#!/usr/bin/env bun

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { getInstanceConfig } from "./instance-config";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "./control-protocol";
import type { BridgeMessage } from "./types";

interface ControlSocketData {
  clientId: number;
  attached: boolean;
}

interface RelayEnvelope {
  id: string;
  sender: string;
  room: string;
  content: string;
  timestamp: number;
}

const INSTANCE = getInstanceConfig();
const CONTROL_PORT = INSTANCE.controlPort;
const PID_FILE = INSTANCE.pidFile;
const LOG_FILE = INSTANCE.logFile;
const ROOM = sanitizeName(process.env.CC_BRIDGE_ROOM ?? "default");
const ENDPOINT = sanitizeName(process.env.CC_BRIDGE_ENDPOINT ?? INSTANCE.instance);
const PEER_LABEL = process.env.CC_BRIDGE_PEER_LABEL ?? "Peer Claude";
const STATE_ROOT = process.env.CC_BRIDGE_STATE_DIR ?? "/tmp/cc-bridge";
const ROOM_DIR = join(STATE_ROOT, ROOM);
const PEERS_DIR = join(ROOM_DIR, "peers");
const MESSAGES_DIR = join(ROOM_DIR, "messages");
const HEARTBEAT_MS = parsePositiveInt(process.env.CC_BRIDGE_HEARTBEAT_MS, 2000);
const PEER_STALE_MS = parsePositiveInt(process.env.CC_BRIDGE_PEER_STALE_MS, 10000);
const POLL_INTERVAL_MS = parsePositiveInt(process.env.CC_BRIDGE_POLL_INTERVAL_MS, 700);
const IDLE_SHUTDOWN_MS = parsePositiveInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS, 30000);
const MAX_BUFFERED_MESSAGES = parsePositiveInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES, 100);

let controlServer: ReturnType<typeof Bun.serve> | null = null;
let attachedClaude: ServerWebSocket<ControlSocketData> | null = null;
let nextControlClientId = 0;
let nextSystemMessageId = 0;
let shuttingDown = false;
let bootstrapped = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let peerConnected = false;
let peerCount = 0;
const bufferedMessages: BridgeMessage[] = [];
const pendingPullMessages: BridgeMessage[] = [];
const waiters = new Map<string, { ws: ServerWebSocket<ControlSocketData>; timer: ReturnType<typeof setTimeout> }>();
const seenMessageIds = new Set<string>();

function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        return Response.json(currentStatus());
      }

      if (url.pathname === "/ws" && server.upgrade(req, { data: { clientId: 0, attached: false } })) {
        return undefined;
      }

      return new Response("cc-bridge daemon");
    },
    websocket: {
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws: ServerWebSocket<ControlSocketData>) => {
        log(`Frontend socket closed (#${ws.data.clientId})`);
        if (attachedClaude === ws) {
          detachClaude(ws, "frontend socket closed");
        }
      },
      message: (ws: ServerWebSocket<ControlSocketData>, raw) => {
        handleControlMessage(ws, raw);
      },
    },
  });
}

function handleControlMessage(ws: ServerWebSocket<ControlSocketData>, raw: string | Buffer) {
  let message: ControlClientMessage;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e: any) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }

  switch (message.type) {
    case "claude_connect":
      attachClaude(ws);
      return;
    case "claude_disconnect":
      detachClaude(ws, "frontend requested disconnect");
      return;
    case "status":
      sendStatus(ws);
      return;
    case "claude_to_codex": {
      if (message.message.source !== "claude") {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Invalid message source",
        });
        return;
      }

      try {
        postPeerMessage(message.message.content);
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: true,
        });
      } catch (err: any) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: err.message,
        });
      }
      return;
    }
    case "pull_messages":
      sendProtocolMessage(ws, {
        type: "pull_messages_result",
        requestId: message.requestId,
        messages: drainPendingPullMessages(),
      });
      return;
    case "wait_for_messages":
      handleWaitForMessages(ws, message.requestId, message.timeoutMs);
      return;
  }
}

function attachClaude(ws: ServerWebSocket<ControlSocketData>) {
  if (attachedClaude && attachedClaude !== ws) {
    attachedClaude.close(4001, "replaced by a newer Claude session");
  }

  attachedClaude = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`Claude frontend attached (#${ws.data.clientId})`);

  sendStatus(ws);

  if (bufferedMessages.length > 0) {
    flushBufferedMessages(ws);
  } else {
    sendBridgeMessage(ws, systemMessage("system_ready", currentReadyMessage()));
  }
}

function detachClaude(ws: ServerWebSocket<ControlSocketData>, reason: string) {
  if (attachedClaude !== ws) return;
  attachedClaude = null;
  ws.data.attached = false;
  log(`Claude frontend detached (#${ws.data.clientId}, ${reason})`);
  clearWaitersForSocket(ws);
  scheduleIdleShutdown();
}

function emitToClaude(message: BridgeMessage) {
  pendingPullMessages.push(message);
  fulfillWaiters();
  if (attachedClaude && attachedClaude.readyState === WebSocket.OPEN) {
    if (trySendBridgeMessage(attachedClaude, message)) return;
    log("Send to Claude failed, buffering message for retry on reconnect");
  }

  bufferedMessages.push(message);
  if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    bufferedMessages.splice(0, dropped);
    log(`Message buffer overflow: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
  }
}

function trySendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage): boolean {
  try {
    const result = ws.send(JSON.stringify({ type: "codex_to_claude", message } satisfies ControlServerMessage));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(ws: ServerWebSocket<ControlSocketData>) {
  const messages = bufferedMessages.splice(0, bufferedMessages.length);
  for (const message of messages) {
    if (!trySendBridgeMessage(ws, message)) {
      const failedIndex = messages.indexOf(message);
      const remaining = messages.slice(failedIndex);
      bufferedMessages.unshift(...remaining);
      log(`Flush interrupted: re-buffered ${remaining.length} message(s) after send failure`);
      return;
    }
  }
}

function sendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage) {
  trySendBridgeMessage(ws, message);
}

function sendStatus(ws: ServerWebSocket<ControlSocketData>) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}

function broadcastStatus() {
  if (!attachedClaude) return;
  sendStatus(attachedClaude);
}

function sendProtocolMessage(ws: ServerWebSocket<ControlSocketData>, message: ControlServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err: any) {
    log(`Failed to send control message: ${err.message}`);
  }
}

function currentStatus(): DaemonStatus {
  return {
    bridgeReady: bootstrapped,
    peerConnected,
    room: ROOM,
    peerCount,
    queuedMessageCount: bufferedMessages.length,
    endpoint: ENDPOINT,
    pid: process.pid,
  };
}

function drainPendingPullMessages(): BridgeMessage[] {
  const messages = pendingPullMessages.splice(0, pendingPullMessages.length);
  return messages;
}

function handleWaitForMessages(ws: ServerWebSocket<ControlSocketData>, requestId: string, timeoutMs: number) {
  const messages = drainPendingPullMessages();
  if (messages.length > 0) {
    sendProtocolMessage(ws, { type: "wait_for_messages_result", requestId, messages });
    return;
  }

  const boundedTimeout = Math.max(1000, Math.min(120000, timeoutMs || 30000));
  const timer = setTimeout(() => {
    waiters.delete(requestId);
    sendProtocolMessage(ws, { type: "wait_for_messages_result", requestId, messages: [] });
  }, boundedTimeout);

  waiters.set(requestId, { ws, timer });
}

function fulfillWaiters() {
  if (pendingPullMessages.length === 0 || waiters.size === 0) return;

  const messages = drainPendingPullMessages();
  for (const [requestId, waiter] of waiters.entries()) {
    clearTimeout(waiter.timer);
    sendProtocolMessage(waiter.ws, { type: "wait_for_messages_result", requestId, messages });
    waiters.delete(requestId);
  }
}

function clearWaitersForSocket(ws: ServerWebSocket<ControlSocketData>) {
  for (const [requestId, waiter] of waiters.entries()) {
    if (waiter.ws !== ws) continue;
    clearTimeout(waiter.timer);
    waiters.delete(requestId);
  }
}

function currentReadyMessage() {
  if (peerConnected) {
    return `✅ ${PEER_LABEL} connected in room '${ROOM}'. Endpoint=${ENDPOINT}, peers=${peerCount}.`;
  }

  return `⏳ Waiting for another Claude window in room '${ROOM}'. Endpoint=${ENDPOINT}.`;
}

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    source: "codex",
    content,
    timestamp: Date.now(),
  };
}

function ensureRelayDirs() {
  mkdirSync(PEERS_DIR, { recursive: true });
  mkdirSync(MESSAGES_DIR, { recursive: true });
}

function peerHeartbeatPath(endpoint: string) {
  return join(PEERS_DIR, `${endpoint}.json`);
}

function messagePath(id: string) {
  return join(MESSAGES_DIR, `${id}.json`);
}

function writeHeartbeat() {
  ensureRelayDirs();
  const payload = {
    endpoint: ENDPOINT,
    room: ROOM,
    updatedAt: Date.now(),
    pid: process.pid,
  };
  writeFileSync(peerHeartbeatPath(ENDPOINT), JSON.stringify(payload), "utf-8");
}

function refreshPeers() {
  ensureRelayDirs();
  let nextPeerCount = 0;

  for (const entry of readdirSync(PEERS_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = join(PEERS_DIR, entry);
    try {
      const peer = JSON.parse(readFileSync(fullPath, "utf-8")) as { endpoint?: string; updatedAt?: number };
      const endpoint = peer.endpoint ?? entry.replace(/\.json$/, "");
      const updatedAt = Number(peer.updatedAt ?? 0);
      if (!updatedAt || Date.now() - updatedAt > PEER_STALE_MS) {
        unlinkSync(fullPath);
        continue;
      }
      if (endpoint !== ENDPOINT) {
        nextPeerCount += 1;
      }
    } catch {
      try { unlinkSync(fullPath); } catch {}
    }
  }

  const wasConnected = peerConnected;
  peerCount = nextPeerCount;
  peerConnected = nextPeerCount > 0;

  if (!wasConnected && peerConnected) {
    emitToClaude(systemMessage("peer_joined", `✅ ${PEER_LABEL} joined room '${ROOM}'. peers=${peerCount}.`));
    broadcastStatus();
  } else if (wasConnected && !peerConnected) {
    emitToClaude(systemMessage("peer_left", `⚠️ No peer currently active in room '${ROOM}'.`));
    broadcastStatus();
  }
}

function pollMessages() {
  ensureRelayDirs();
  for (const entry of readdirSync(MESSAGES_DIR)) {
    if (!entry.endsWith(".json")) continue;

    const fullPath = join(MESSAGES_DIR, entry);
    try {
      const envelope = JSON.parse(readFileSync(fullPath, "utf-8")) as RelayEnvelope;
      if (seenMessageIds.has(envelope.id)) continue;
      seenMessageIds.add(envelope.id);

      if (envelope.room !== ROOM) continue;
      if (envelope.sender === ENDPOINT) continue;

      emitToClaude({
        id: envelope.id,
        source: "codex",
        content: `[${envelope.sender}] ${envelope.content}`,
        timestamp: envelope.timestamp,
      });
    } catch (err: any) {
      log(`Failed to read relay message ${entry}: ${err.message}`);
    }
  }
}

function postPeerMessage(content: string) {
  ensureRelayDirs();
  const envelope: RelayEnvelope = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    sender: ENDPOINT,
    room: ROOM,
    content,
    timestamp: Date.now(),
  };
  seenMessageIds.add(envelope.id);
  writeFileSync(messagePath(envelope.id), JSON.stringify(envelope), "utf-8");
  log(`Forwarding local Claude -> peer (${content.length} chars)`);
}

function startRelayLoops() {
  writeHeartbeat();
  refreshPeers();
  pollMessages();

  heartbeatTimer = setInterval(() => {
    writeHeartbeat();
    refreshPeers();
  }, HEARTBEAT_MS);

  pollTimer = setInterval(() => {
    pollMessages();
  }, POLL_INTERVAL_MS);
}

function stopRelayLoops() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  try {
    unlinkSync(peerHeartbeatPath(ENDPOINT));
  } catch {}
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (attachedClaude) return;

  log(`No Claude client connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    if (attachedClaude) {
      log("Idle shutdown cancelled: Claude reconnected during grace period");
      return;
    }
    shutdown("idle — no Claude client connected");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

function writePidFile() {
  writeFileSync(PID_FILE, `${process.pid}\n`, "utf-8");
}

function removePidFile() {
  try {
    unlinkSync(PID_FILE);
  } catch {}
}

function bootRelay() {
  log(`Starting cc-bridge daemon for room='${ROOM}' endpoint='${ENDPOINT}'`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);
  log(`Relay state dir: ${ROOM_DIR}`);

  ensureRelayDirs();
  startRelayLoops();
  bootstrapped = true;
  emitToClaude(systemMessage("system_ready", currentReadyMessage()));
  broadcastStatus();
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
  }
  waiters.clear();
  stopRelayLoops();
  controlServer?.stop();
  controlServer = null;
  removePidFile();
  process.exit(0);
}

function sanitizeName(raw: string): string {
  const trimmed = raw.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "default";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  stopRelayLoops();
  removePidFile();
});
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [cc-bridge] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

writePidFile();
startControlServer();
bootRelay();
