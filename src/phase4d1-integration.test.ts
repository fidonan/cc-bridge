/**
 * Phase 4D-1 Integration Tests — Cross-Room Control-Plane Forwarding
 *
 * Verifies that a peer in room R1 can send a point-to-point message to a peer
 * in room R2 via daemon-mediated coordinator forwarding (not file-backed relay).
 *
 * Relies on one-coordinator-per-room invariant (Phase 4A).
 *
 *   1. A in room1 sends to B in room2 — coord2 receives codex_to_claude with correct content
 *   2. A sends to unknown endpoint → ENDPOINT_NOT_FOUND error
 *   3. A sends to terminated endpoint → PEER_TERMINATED error
 *   4. A sends to endpoint in room with no coordinator → COORDINATOR_OFFLINE error
 *   5. Broadcast from A stays room1-scoped — coord2 does NOT receive it
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase4d1-test";
const ROOM1 = "d1-room1";
const ROOM2 = "d1-room2";
const COORD1_EP = "coord-4d1-room1";

const PORT = 41000 + Math.floor(Math.random() * 3000);
let proc: Subprocess | null = null;
let msgCounter = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function makeEnvelope(
  from: string,
  kind: "control" | "work" | "error",
  intent: string,
  payload: unknown = {},
  opts: Partial<MessageEnvelope> = {},
): MessageEnvelope {
  return {
    protocol_version: "1.0",
    message_id: `t4d1_${++msgCounter}_${Date.now()}`,
    from,
    sent_at: Date.now(),
    kind,
    intent,
    payload,
    ...opts,
  };
}

// ── Test client ───────────────────────────────────────────────────────────────

class Phase4D1Client {
  private ws!: WebSocket;
  private reqId = 0;
  readonly received: { raw: string; parsed: unknown }[] = [];
  private resolvers = new Map<string, (v: any) => void>();

  async connect(port: number, room: string) {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WS connect failed on port ${port}`));
      this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
    });
    this.ws.send(JSON.stringify({ type: "claude_connect", room }));
    await sleep(100);
  }

  private onMessage(msg: any) {
    if (msg.type === "codex_to_claude") {
      const raw: string = msg.message?.content ?? "";
      let parsed: unknown = null;
      try { parsed = JSON.parse(raw); } catch {}
      this.received.push({ raw, parsed });
    }
    const resolver = this.resolvers.get(msg.requestId);
    if (resolver) {
      this.resolvers.delete(msg.requestId);
      resolver(msg);
    }
  }

  req<T>(msg: object): Promise<T> {
    const requestId = `r4d1_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  postEnvelope(envelope: MessageEnvelope) {
    return this.req<{ type: "post_envelope_result"; success: boolean; error?: any }>({
      type: "post_envelope",
      envelope,
    });
  }

  postMessage(content: string, to?: string[]) {
    return this.req<{ type: "post_message_result"; success: boolean; error?: string; resolvedRecipients?: string[] }>({
      type: "post_message",
      message: { source: "claude", content },
      ...(to ? { to } : {}),
    });
  }

  terminatePeer(endpoint: string) {
    return this.req<{ type: "terminate_peer_result"; success: boolean }>({
      type: "terminate_peer",
      request: { endpoint },
    });
  }

  async waitForMessage(predicate: (p: any) => boolean, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find((o) => o.parsed !== null && predicate(o.parsed));
      if (found) return found.parsed;
      await sleep(50);
    }
    return null;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let coord1: Phase4D1Client; // coordinator of room1 — sends messages
let coord2: Phase4D1Client; // coordinator of room2 — receives cross-room messages

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase4d1-${PORT}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase4d1-${PORT}.log`,
      CC_BRIDGE_ROOM: ROOM1,
      CC_BRIDGE_ENDPOINT: COORD1_EP,
      CC_BRIDGE_STATE_DIR: STATE_DIR,
      CC_BRIDGE_HEARTBEAT_MS: "300",
      CC_BRIDGE_PEER_STALE_MS: "800",
      CC_BRIDGE_POLL_INTERVAL_MS: "200",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: "3000",
      CC_BRIDGE_STALL_ESCALATION_MS: "10000",
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "120000",
    } as Record<string, string>,
    stdout: "ignore",
    stderr: "ignore",
  });

  const url = `http://127.0.0.1:${PORT}/healthz`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) break; } catch {}
    await sleep(200);
  }

  // Connect two coordinators to two different rooms
  coord1 = new Phase4D1Client();
  await coord1.connect(PORT, ROOM1);

  coord2 = new Phase4D1Client();
  await coord2.connect(PORT, ROOM2);
});

afterAll(async () => {
  coord1?.close();
  coord2?.close();
  proc?.kill();
  await sleep(200);
});

// ── Helper: register a simulated peer in a specific room ──────────────────────

async function registerPeerInRoom(
  coord: Phase4D1Client,
  endpoint: string,
): Promise<void> {
  await coord.postEnvelope(
    makeEnvelope(endpoint, "control", "register", { endpoint, role: "Worker" }),
  );
  // Wait for lifecycle_ack
  await coord.waitForMessage(
    (p: any) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint,
    3000,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 4D-1 — Cross-Room Control-Plane Forwarding", () => {

  // ── Test 1: successful cross-room delivery ────────────────────────────────

  test("1. cross-room send — coord2 receives codex_to_claude with correct content and semantics", async () => {
    const workerEp = `d1-worker-${Date.now()}`;
    await registerPeerInRoom(coord2, workerEp);

    const beforeCount = coord2.received.length;
    const result = await coord1.postMessage("hello cross-room", [workerEp]);
    expect(result.success).toBe(true);
    expect(result.resolvedRecipients).toContain(workerEp);

    // coord2 should receive a codex_to_claude message with a RelayEnvelope containing the content
    const found = await coord2.waitForMessage(
      (p: any) => typeof p?.content === "string" && p.content === "hello cross-room",
      3000,
    );
    expect(found).not.toBeNull();
    expect(coord2.received.length).toBeGreaterThan(beforeCount);

    // Semantic assertions: sender identity and target endpoint (Phase 4D-1 contract)
    expect(found.sender_room).toBe(ROOM1);          // originating coordinator room
    expect(found.target_endpoint).toBe(workerEp);   // explicit destination
    // senderId is daemon ENDPOINT (not per-coordinator) — just check it is a string
    expect(typeof found.senderId).toBe("string");
  });

  // ── Test 2: unknown endpoint → ENDPOINT_NOT_FOUND ────────────────────────

  test("2. send to unknown endpoint → ENDPOINT_NOT_FOUND error", async () => {
    const result = await coord1.postMessage("should fail", ["d1-ghost-endpoint"]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("ENDPOINT_NOT_FOUND");
  });

  // ── Test 3: terminated endpoint → PEER_TERMINATED ────────────────────────

  test("3. send to terminated endpoint → PEER_TERMINATED error", async () => {
    const workerEp = `d1-term-${Date.now()}`;
    await registerPeerInRoom(coord2, workerEp);

    // Terminate the peer
    await coord2.terminatePeer(workerEp);
    await sleep(100);

    const result = await coord1.postMessage("should fail", [workerEp]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("PEER_TERMINATED");
  });

  // ── Test 4: no coordinator in target room → COORDINATOR_OFFLINE ──────────

  test("4. send to endpoint in room with no coordinator → COORDINATOR_OFFLINE error", async () => {
    const orphanRoom = `d1-orphan-${Date.now()}`;
    const orphanEp = `d1-orphan-ep-${Date.now()}`;

    // Connect a temporary coordinator to orphanRoom, register a peer, then disconnect
    const tempCoord = new Phase4D1Client();
    await tempCoord.connect(PORT, orphanRoom);
    await registerPeerInRoom(tempCoord, orphanEp);
    tempCoord.close();
    await sleep(200); // let WS close propagate

    // Now orphanRoom has no coordinator — send should fail
    const result = await coord1.postMessage("should fail", [orphanEp]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("COORDINATOR_OFFLINE");
  });

  // ── Test 5: broadcast stays room-scoped ──────────────────────────────────

  test("5. broadcast from coord1 does NOT reach coord2 in room2", async () => {
    const beforeCount = coord2.received.length;
    const result = await coord1.postMessage("broadcast to room1 only");
    expect(result.success).toBe(true);

    await sleep(300); // give time for any spurious delivery
    expect(coord2.received.length).toBe(beforeCount);
  });

  // ── Test 6: non-default room sender → default room target uses 4D-1 path ──

  test("6. room2 sender → room1 target: correct semantics (sender_room=room2, target_endpoint=room1Peer)", async () => {
    // Register a peer in room1 (default room) via coord1
    const room1Peer = `d1-r1peer-${Date.now()}`;
    await registerPeerInRoom(coord1, room1Peer);

    // coord2 (non-default room sender) sends to room1Peer
    const beforeCount = coord1.received.length;
    const result = await coord2.postMessage("hello from room2 to room1", [room1Peer]);
    expect(result.success).toBe(true);
    expect(result.resolvedRecipients).toContain(room1Peer);

    // coord1 (room1 coordinator) should receive the message via direct WS forwarding
    const found = await coord1.waitForMessage(
      (p: any) => typeof p?.content === "string" && p.content === "hello from room2 to room1",
      3000,
    );
    expect(found).not.toBeNull();
    expect(coord1.received.length).toBeGreaterThan(beforeCount);

    // Semantic assertions: sender_room = room2, target_endpoint = room1Peer
    expect(found.sender_room).toBe(ROOM2);
    expect(found.target_endpoint).toBe(room1Peer);
  });

});
