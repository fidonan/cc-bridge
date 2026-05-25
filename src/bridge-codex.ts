#!/usr/bin/env bun

/**
 * cc-bridge Codex Entry Point
 *
 * Bridges a Codex (GPT-5.5) instance into the cc-bridge relay network.
 * Combines:
 *   - CodexAdapter: manages Codex app-server process + message injection/extraction
 *   - MCP Server: exposes reply/get_messages/wait_for_messages/list_peers to the
 *     orchestrating Claude Code window (or CLI)
 *   - DaemonClient: connects to cc-bridge daemon for cross-window relay
 *
 * Usage: bun run src/bridge-codex.ts
 * Environment: same as bridge.ts, plus CODEX_WS_PORT for the app-server port.
 */

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CodexAdapter } from "./codex-adapter";
import { DaemonClient } from "./daemon-client";
import { getInstanceConfig } from "./instance-config";
import type { BridgeMessage } from "./types";

const INSTANCE = getInstanceConfig();
const CONTROL_PORT = INSTANCE.controlPort;
const APP_PORT = INSTANCE.appPort;
const PID_FILE = INSTANCE.pidFile;
const CONTROL_HEALTH_URL = `http://127.0.0.1:${CONTROL_PORT}/healthz`;
const CONTROL_WS_URL = `ws://127.0.0.1:${CONTROL_PORT}/ws`;
const LOG_FILE = INSTANCE.logFile;
const DAEMON_PATH = fileURLToPath(new URL("./daemon.ts", import.meta.url));

// ── Codex Adapter (skip TUI proxy, bridge-only mode) ──────────────────────

const codex = new CodexAdapter({ appPort: APP_PORT, skipProxy: true });

// ── MCP Server ────────────────────────────────────────────────────────────

const mcpServer = new Server(
  { name: "cc-bridge-codex", version: "0.4.0" },
  {
    capabilities: { tools: {} },
    instructions: [
      "Your peer is a Codex (GPT-5.5) instance bridged through cc-bridge.",
      "Use reply to send messages, wait_for_messages to receive.",
      "After replying, always call wait_for_messages again.",
    ].join("\n"),
  },
);

// ── Message Queue (Codex → MCP pull/wait) ────────────────────────────────

const pendingMessages: BridgeMessage[] = [];
const waiters = new Map<string, { resolve: (result: any) => void; timer: ReturnType<typeof setTimeout> }>();

function enqueueMessage(msg: BridgeMessage) {
  pendingMessages.push(msg);
  fulfillWaiters();
}

function drainMessages(): BridgeMessage[] {
  return pendingMessages.splice(0, pendingMessages.length);
}

function fulfillWaiters() {
  if (pendingMessages.length === 0 || waiters.size === 0) return;
  const messages = drainMessages();
  const text = formatMessages(messages);
  for (const [requestId, waiter] of waiters.entries()) {
    clearTimeout(waiter.timer);
    waiter.resolve({ content: [{ type: "text" as const, text }] });
    waiters.delete(requestId);
  }
}

function formatMessages(messages: BridgeMessage[]): string {
  if (messages.length === 0) return "No new messages from Codex.";
  const header = `[${messages.length} new message${messages.length > 1 ? "s" : ""} from Codex]`;
  const formatted = messages
    .map((msg, i) => {
      const ts = new Date(msg.timestamp).toISOString();
      return `---\n[${i + 1}] ${ts}\nCodex: ${msg.content}`;
    })
    .join("\n\n");
  return `${header}\n\n${formatted}`;
}

// ── MCP Tool Registration ─────────────────────────────────────────────────

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message to the Codex instance through cc-bridge.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "The message to send to Codex." },
          to: {
            type: "array",
            items: { type: "string" },
            description: "Optional peer endpoint names. Omit to broadcast.",
          },
          scope: {
            type: "string",
            enum: ["room", "global"],
            description: "Delivery scope. 'room' (default) or 'global'.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "get_messages",
      description: "Check for new messages from Codex.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "wait_for_messages",
      description: "Wait for new messages from Codex. Blocks until a message arrives or timeout.",
      inputSchema: {
        type: "object" as const,
        properties: {
          timeout_ms: { type: "number", description: "Max wait time in ms. Default 120000." },
        },
        required: [],
      },
    },
    {
      name: "list_peers",
      description: "List currently active peer endpoints.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "reply":
      return handleReply(args as Record<string, unknown>);
    case "get_messages":
      return handleGetMessages();
    case "wait_for_messages":
      return handleWaitForMessages(args as Record<string, unknown>);
    case "list_peers":
      return handleListPeers();
    default:
      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
  }
});

// ── Tool Handlers ─────────────────────────────────────────────────────────

async function handleReply(args: Record<string, unknown>) {
  const text = args?.text as string | undefined;
  if (!text) {
    return { content: [{ type: "text" as const, text: "Error: missing 'text'" }], isError: true };
  }

  // Route through cc-bridge daemon for cross-window delivery
  const toRaw = args?.to;
  let to: string[] | undefined;
  if (Array.isArray(toRaw) && toRaw.length > 0) {
    to = [...new Set((toRaw as unknown[]).filter((v): v is string => typeof v === "string").map(v => v.trim()).filter(Boolean))];
    if (to.length === 0) to = undefined;
  }

  const scopeRaw = args?.scope;
  const scope: "room" | "global" | undefined = scopeRaw === "room" || scopeRaw === "global" ? scopeRaw : undefined;

  const bridgeMsg: BridgeMessage = {
    id: `codex_reply_${Date.now()}`,
    source: "claude",
    content: text,
    timestamp: Date.now(),
  };

  try {
    const result = await daemonClient.sendReply(bridgeMsg, to, scope);
    if (!result.success) {
      return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
    }

    // Also inject into Codex if it has an active thread
    if (codex.activeThreadId && !codex.turnInProgress) {
      codex.injectMessage(text);
    }

    let responseText = "Reply sent.";
    if (result.resolvedRecipients && result.resolvedRecipients.length > 0) {
      responseText += ` Delivered to: ${result.resolvedRecipients.join(", ")}.`;
    }
    return { content: [{ type: "text" as const, text: responseText }] };
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
  }
}

function handleGetMessages() {
  const messages = drainMessages();
  return { content: [{ type: "text" as const, text: formatMessages(messages) }] };
}

async function handleWaitForMessages(args: Record<string, unknown>) {
  const timeoutArg = args?.timeout_ms;
  const timeoutMs = typeof timeoutArg === "number" && Number.isFinite(timeoutArg)
    ? Math.max(1000, Math.min(300000, Math.trunc(timeoutArg)))
    : 120000;

  // Check immediate
  const immediate = drainMessages();
  if (immediate.length > 0) {
    return { content: [{ type: "text" as const, text: formatMessages(immediate) }] };
  }

  // Also pull from daemon
  try {
    const pulled = await daemonClient.pullMessages();
    if (pulled.length > 0) {
      return { content: [{ type: "text" as const, text: formatMessages(pulled) }] };
    }
  } catch {}

  // Wait for new messages via promise
  const requestId = `wait_${Date.now()}`;
  return new Promise<any>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(requestId);
      resolve({ content: [{ type: "text" as const, text: `No new messages within ${timeoutMs}ms.` }] });
    }, timeoutMs);
    waiters.set(requestId, { resolve, timer });
  });
}

function handleListPeers() {
  const peers = daemonClient.listPeers();
  const text = peers.length > 0
    ? `Active peers: ${peers.join(", ")}`
    : "No peers currently active.";
  return { content: [{ type: "text" as const, text }] };
}

// ── Daemon Client ─────────────────────────────────────────────────────────

const daemonClient = new DaemonClient(CONTROL_WS_URL);

codex.on("agentMessage", (message: BridgeMessage) => {
  log(`Codex agent message (${message.content.length} chars) — enqueueing for MCP`);
  enqueueMessage(message);
});

codex.on("turnStarted", () => {
  log("Codex turn started");
});

codex.on("turnCompleted", () => {
  log("Codex turn completed");
});

daemonClient.on("codexMessage", (message: BridgeMessage) => {
  log(`Daemon → Codex relay (${message.content.length} chars)`);
  enqueueMessage(message);
  // Also inject into Codex if ready
  if (codex.activeThreadId && !codex.turnInProgress) {
    codex.injectMessage(message.content);
  }
});

daemonClient.on("status", (status) => {
  log(`Daemon status: ready=${status.bridgeReady} peers=${status.peerCount} room=${status.room}`);
});

daemonClient.enableAutoReconnect();

daemonClient.on("disconnect", () => {
  log("Daemon control connection lost — will auto-reconnect");
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

let shuttingDown = false;

async function ensureDaemonRunning() {
  if (await isDaemonHealthy()) return;

  const existingPid = readDaemonPid();
  if (existingPid) {
    if (isProcessAlive(existingPid)) {
      try {
        await waitForDaemonHealthy(12, 250);
        return;
      } catch {
        throw new Error(`Existing daemon PID ${existingPid} on port ${CONTROL_PORT} is not healthy.`);
      }
    }
    removeStalePidFile();
  }

  launchDaemon();
  await waitForDaemonHealthy();
}

function launchDaemon() {
  log(`Launching daemon on control port ${CONTROL_PORT}`);
  const proc = spawn(process.execPath, ["run", DAEMON_PATH], {
    cwd: process.cwd(),
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
}

async function isDaemonHealthy() {
  try { return (await fetch(CONTROL_HEALTH_URL)).ok; } catch { return false; }
}

async function waitForDaemonHealthy(maxRetries = 40, delayMs = 250) {
  for (let i = 0; i < maxRetries; i++) {
    if (await isDaemonHealthy()) return;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Daemon health timeout on ${CONTROL_HEALTH_URL}`);
}

function readDaemonPid() {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

function isProcessAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function removeStalePidFile() {
  try { unlinkSync(PID_FILE); } catch {}
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (${reason})...`);

  const hardExit = setTimeout(() => process.exit(0), 3000);
  codex.stop();
  void daemonClient.disconnect().finally(() => {
    clearTimeout(hardExit);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("exit", () => { if (!shuttingDown) { codex.stop(); void daemonClient.disconnect(); } });
process.on("uncaughtException", (err) => { log(`UNCAUGHT: ${err.stack ?? err.message}`); });
process.on("unhandledRejection", (reason: any) => { log(`UNHANDLED: ${reason?.stack ?? reason}`); });

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [bridge-codex] ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────

log(`Starting bridge-codex instance=${INSTANCE.instance} appPort=${APP_PORT} controlPort=${CONTROL_PORT}`);

(async () => {
  try {
    // 1. Ensure daemon is running
    await ensureDaemonRunning();

    // 2. Connect to daemon
    await daemonClient.connect();
    daemonClient.attachClaude();

    // 3. Start Codex adapter (spawns codex app-server, skipProxy=true)
    await codex.start();
    log("Codex adapter started, waiting for thread...");

    // 4. Start MCP server (stdio transport for the orchestrating Claude window)
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    log("MCP server connected — bridge-codex ready");

  } catch (err: any) {
    log(`Fatal: ${err.message}`);
    process.exit(1);
  }
})();
