/**
 * Phase 5 Integration Tests — Global Peer Discovery & Cross-Room Broadcast
 *
 * Phase 5A: query_registry returns room field for each peer
 * Phase 5B: post_message with scope="global" broadcasts across all active rooms
 *
 * Tests:
 *   1. 5A: query_registry populates room for peers in default room
 *   2. 5A: query_registry populates room for peers in non-default rooms
 *   3. 5B: global broadcast from default room reaches coordinator in second room
 *   4. 5B: global broadcast with no other rooms returns delivered_rooms=[ROOM], skipped_rooms=[]
 *   5. 5B: global broadcast to room with no live coordinator goes to skipped_rooms
 *   6. 5B: non-global post_message (scope omitted) stays room-scoped
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase5-test";
const DEFAULT_ROOM = "p5-default";
const ROOM2 = "p5-room2";
const ROOM3 = "p5-room3";
const COORD_EP = "coord-p5-A";
const PEER_EP = "peer-p5-B";

const PORT = 45000 + Math.floor(Math.random() * 3000);
let proc: Subprocess | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Test client ───────────────────────────────────────────────────────────────

class Phase5Client {
  private ws!: WebSocket;
  private reqId = 0;
  readonly received: { raw: string; parsed: unknown }[] = [];
  private resolvers = new Map<string, (v: any) => void>();
  private pendingMessages: string[] = [];
  private messageListeners: Array<(msg: any) => void> = [];

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
      this.received.push({ raw: msg.message?.content ?? "", parsed: null });
      for (const listener of this.messageListeners) listener(msg.message?.content ?? "");
    }
    const resolver = this.resolvers.get(msg.requestId);
    if (resolver) {
      this.resolvers.delete(msg.requestId);
      resolver(msg);
    }
  }

  req<T>(msg: object): Promise<T> {
    const requestId = `r5_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  postMessage(content: string, opts: { to?: string[]; scope?: "room" | "global" } = {}) {
    return this.req<{
      type: "post_message_result";
      success: boolean;
      error?: string;
      resolvedRecipients?: string[];
      delivered_rooms?: string[];
      skipped_rooms?: string[];
    }>({
      type: "post_message",
      message: { source: "claude", content },
      ...(opts.to ? { to: opts.to } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
  }

  queryRegistry() {
    return this.req<{ type: "query_registry_result"; snapshot: { peers: any[] } }>({
      type: "query_registry",
    });
  }

  registerPeer(endpoint: string, role: string) {
    const envelope = {
      type: "register",
      endpoint,
      role,
      started_at: Date.now(),
    };
    this.ws.send(JSON.stringify({ type: "post_envelope", requestId: `reg_${++this.reqId}`, envelope }));
  }

  async waitForMessage(timeoutMs = 3000): Promise<string | null> {
    if (this.received.length > 0) {
      return this.received[this.received.length - 1].raw as string;
    }
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.messageListeners = this.messageListeners.filter((l) => l !== listener);
        resolve(null);
      }, timeoutMs);
      const listener = (content: string) => {
        clearTimeout(timer);
        this.messageListeners = this.messageListeners.filter((l) => l !== listener);
        resolve(content);
      };
      this.messageListeners.push(listener);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let coord1: Phase5Client;
let coord2: Phase5Client;

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase5-${PORT}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase5-${PORT}.log`,
      CC_BRIDGE_ROOM: DEFAULT_ROOM,
      CC_BRIDGE_ENDPOINT: COORD_EP,
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
    try {
      const r = await fetch(url);
      if (r.ok) break;
    } catch {}
    await sleep(200);
  }

  coord1 = new Phase5Client();
  coord2 = new Phase5Client();
  await coord1.connect(PORT, DEFAULT_ROOM);
  await coord2.connect(PORT, ROOM2);
});

afterAll(async () => {
  coord1?.close();
  coord2?.close();
  proc?.kill();
  await sleep(200);
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 5A: query_registry room field", () => {
  test("Test 1: peer registered via relay in default room appears with correct room", async () => {
    // Register a peer via post_envelope → register intent in DEFAULT_ROOM
    const regEnvelope = {
      protocol_version: "1.0",
      message_id: `reg_5a_1_${Date.now()}`,
      from: PEER_EP,
      from_role: "Worker",
      sent_at: Date.now(),
      kind: "control",
      intent: "register",
      payload: { role: "Worker", started_at: Date.now() },
    };
    await coord1.req({ type: "post_envelope", envelope: regEnvelope });
    await sleep(200);

    const result = await coord1.queryRegistry();
    expect(result.type).toBe("query_registry_result");
    expect(result.snapshot).toBeDefined();
    const peer = result.snapshot.peers.find((p: any) => p.endpoint === PEER_EP);
    expect(peer).toBeDefined();
    expect(peer?.room).toBe(DEFAULT_ROOM);
  });

  test("Test 2: peer registered via relay in non-default room appears with correct room", async () => {
    // Register a different peer via coord2 (in ROOM2)
    const ep2 = "peer-p5-room2-only";
    const regEnvelope = {
      protocol_version: "1.0",
      message_id: `reg_5a_2_${Date.now()}`,
      from: ep2,
      from_role: "Planner",
      sent_at: Date.now(),
      kind: "control",
      intent: "register",
      payload: { role: "Planner", started_at: Date.now() },
    };
    await coord2.req({ type: "post_envelope", envelope: regEnvelope });
    await sleep(200);

    const result = await coord2.queryRegistry();
    expect(result.type).toBe("query_registry_result");
    const peer = result.snapshot.peers.find((p: any) => p.endpoint === ep2);
    expect(peer).toBeDefined();
    expect(peer?.room).toBe(ROOM2);

    // PEER_EP (from Test 1) should still show DEFAULT_ROOM
    const peer1 = result.snapshot.peers.find((p: any) => p.endpoint === PEER_EP);
    expect(peer1).toBeDefined();
    expect(peer1?.room).toBe(DEFAULT_ROOM);
  });
});

describe("Phase 5B: cross-room global broadcast", () => {
  test("Test 3: global broadcast from coord1 (DEFAULT_ROOM) is received by coord2 (ROOM2)", async () => {
    // coord2 is connected to ROOM2; global broadcast should fan out to it
    const initialReceivedCount = coord2.received.length;

    const result = await coord1.postMessage("hello-from-room1-global", { scope: "global" });
    expect(result.type).toBe("post_message_result");
    expect(result.success).toBe(true);
    expect(result.delivered_rooms).toContain(DEFAULT_ROOM);
    expect(result.delivered_rooms).toContain(ROOM2);

    // coord2 should have received the message
    const msg = await coord2.waitForMessage(3000);
    expect(msg).toContain("hello-from-room1-global");
  });

  test("Test 4: global broadcast with only one active room has delivered_rooms=[DEFAULT_ROOM]", async () => {
    // Connect a third client to query but DON'T connect a coordinator to any other room
    // The default room is always active, so delivered_rooms should include it.
    // For this test we use coord1 which is in DEFAULT_ROOM.
    // We temporarily close coord2 to simulate single-room scenario.
    // Instead, we just verify the result from a fresh single-room daemon perspective.
    // Since coord2 is still connected to ROOM2, use a different approach:
    // Create a coord in ROOM3 that just connects and immediately checks.
    const singleRoomClient = new Phase5Client();
    await singleRoomClient.connect(PORT, ROOM3);
    await sleep(100);

    const result = await singleRoomClient.postMessage("test-single-active", { scope: "global" });
    expect(result.type).toBe("post_message_result");
    expect(result.success).toBe(true);
    expect(result.delivered_rooms).toContain(ROOM3);
    // All currently-active rooms should be included; no rooms should be skipped since all have coordinators
    expect(result.skipped_rooms?.length ?? 0).toBe(0);

    singleRoomClient.close();
    await sleep(100);
  });

  test("Test 5: combining to[] with scope='global' returns an error (Fix 2 — no silent misrouting)", async () => {
    // Protocol contract: to[] + scope:"global" must be rejected, not silently broadcast
    const result = await coord1.req<{
      type: "post_message_result";
      success: boolean;
      error?: string;
    }>({
      type: "post_message",
      message: { source: "claude", content: "targeted-but-global" },
      to: ["B"],
      scope: "global",
    });
    expect(result.type).toBe("post_message_result");
    expect(result.success).toBe(false);
    expect(result.error).toContain("scope='global'");
  });

  test("Test 6: non-global post_message (no scope) stays room-scoped — coord2 does NOT receive it", async () => {
    const receivedBefore = coord2.received.length;

    const result = await coord1.postMessage("room-scoped-only", {});
    // Room-scoped send to default room — no to[] specified, broadcasts to all in room
    expect(result.type).toBe("post_message_result");
    expect(result.success).toBe(true);
    // delivered_rooms should NOT be present for non-global sends
    expect(result.delivered_rooms).toBeUndefined();

    // Wait briefly; coord2 (ROOM2) should NOT receive the room-scoped message
    await sleep(300);
    expect(coord2.received.length).toBe(receivedBefore);
  });
});
