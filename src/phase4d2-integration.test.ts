/**
 * Phase 4D-2 Integration Tests — Per-Room Relay Filesystem
 *
 * Verifies that per-room relay participation is correctly managed:
 *   1. Default room relay is active immediately after daemon start
 *   2. Non-default room relay dirs are created when a coordinator attaches
 *   3. Heartbeats survive brief disconnect/reconnect cycles without false peer_left
 *   4. Non-default room relay is deactivated after the configured grace period
 *   5. Room switch activates the new room and deactivates the old room after grace
 *   6. Default room relay stays active across non-default room coordinator churn
 *   7. File-backed relay delivers messages within a non-default room
 *   8. Relay messages persist until a coordinator is connected
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ── 2-daemon relay helper ─────────────────────────────────────────────────────

async function spawnDaemon(port: number, room: string, endpoint: string, stateDir: string): Promise<Subprocess> {
  const proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(port),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-d2relay-${port}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-d2relay-${port}.log`,
      CC_BRIDGE_ROOM: room,
      CC_BRIDGE_ENDPOINT: endpoint,
      CC_BRIDGE_STATE_DIR: stateDir,
      CC_BRIDGE_HEARTBEAT_MS: "200",
      CC_BRIDGE_PEER_STALE_MS: "800",
      CC_BRIDGE_POLL_INTERVAL_MS: "150",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: "3000",
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "120000",
      CC_BRIDGE_ROOM_DEACTIVATE_GRACE_MS: "1200",
    } as Record<string, string>,
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) break;
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 150));
  }
  return proc;
}

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase4d2-test";
const DEFAULT_ROOM = "d2-default";
const OTHER_ROOM = "d2-other";
const ENDPOINT = "d2-daemon";

const PORT = 43000 + Math.floor(Math.random() * 3000);
let proc: Subprocess | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

class Phase4D2Client {
  private ws!: WebSocket;
  private reqId = 0;
  readonly received: { raw: string; parsed: unknown }[] = [];
  private resolvers = new Map<string, (v: any) => void>();

  async connect(port: number, room?: string) {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WS connect failed on port ${port}`));
      this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
    });
    this.ws.send(JSON.stringify({ type: "claude_connect", room: room ?? DEFAULT_ROOM }));
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
    const requestId = `r4d2_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  postMessage(content: string, to?: string[]) {
    return this.req<{ type: "post_message_result"; success: boolean; error?: string; resolvedRecipients?: string[] }>({
      type: "post_message",
      message: { source: "claude", content },
      ...(to ? { to } : {}),
    });
  }

  switchRoom(newRoom: string) {
    // A second claude_connect triggers a room switch
    this.ws.send(JSON.stringify({ type: "claude_connect", room: newRoom }));
    return sleep(150);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase4d2-${PORT}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase4d2-${PORT}.log`,
      CC_BRIDGE_ROOM: DEFAULT_ROOM,
      CC_BRIDGE_ENDPOINT: ENDPOINT,
      CC_BRIDGE_STATE_DIR: STATE_DIR,
      CC_BRIDGE_HEARTBEAT_MS: "300",
      CC_BRIDGE_PEER_STALE_MS: "800",
      CC_BRIDGE_POLL_INTERVAL_MS: "200",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: "3000",
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "120000",
      CC_BRIDGE_ROOM_DEACTIVATE_GRACE_MS: "1200",
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
});

afterAll(async () => {
  proc?.kill();
  await sleep(200);
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 4D-2 — Per-Room Relay Filesystem", () => {

  // ── Test 1: default room relay is always active ───────────────────────────

  test("1. default room relay dirs exist immediately after daemon start", async () => {
    const defaultPeersDir = join(STATE_DIR, DEFAULT_ROOM, "peers");
    const defaultMsgsDir = join(STATE_DIR, DEFAULT_ROOM, "messages");
    expect(existsSync(defaultPeersDir)).toBe(true);
    expect(existsSync(defaultMsgsDir)).toBe(true);

    // Daemon heartbeat file should be present in default room peers dir
    const entries = readdirSync(defaultPeersDir);
    expect(entries.some((e) => e.includes(ENDPOINT))).toBe(true);
  });

  // ── Test 2: non-default room relay dirs created on coordinator attach ──────

  test("2. non-default room relay dirs created when coordinator attaches", async () => {
    const coord = new Phase4D2Client();
    await coord.connect(PORT, OTHER_ROOM);

    const peersDir = join(STATE_DIR, OTHER_ROOM, "peers");
    const msgsDir = join(STATE_DIR, OTHER_ROOM, "messages");
    expect(existsSync(peersDir)).toBe(true);
    expect(existsSync(msgsDir)).toBe(true);

    // Daemon heartbeat must be present in non-default room peers dir
    const entries = readdirSync(peersDir);
    expect(entries.some((e) => e.includes(ENDPOINT))).toBe(true);

    coord.close();
    await sleep(300);
  });

  test("3. daemon heartbeat survives brief coordinator disconnects and no false peer_left is emitted", async () => {
    const sharedRoom = `d2-presence-${Date.now()}`;
    const sharedStateDir = `/tmp/cc-bridge-d2-presence-${Date.now()}`;
    const portA = 45000 + Math.floor(Math.random() * 1000);
    const portB = portA + 1;
    let procA: Subprocess | null = null;
    let procB: Subprocess | null = null;

    try {
      procA = await spawnDaemon(portA, sharedRoom, "presence-A", sharedStateDir);
      procB = await spawnDaemon(portB, sharedRoom, "presence-B", sharedStateDir);

      const coordA = new Phase4D2Client();
      const coordB1 = new Phase4D2Client();
      await coordA.connect(portA, sharedRoom);
      await coordB1.connect(portB, sharedRoom);
      await sleep(900);

      const peersDir = join(sharedStateDir, sharedRoom, "peers");
      expect(existsSync(peersDir)).toBe(true);
      expect(readdirSync(peersDir).some((e) => e.includes("presence-B"))).toBe(true);

      coordB1.close();
      await sleep(1000);

      expect(existsSync(peersDir)).toBe(true);
      expect(readdirSync(peersDir).some((e) => e.includes("presence-B"))).toBe(true);
      expect(coordA.received.some((m) => m.raw.includes("No peer currently active"))).toBe(false);

      const coordB2 = new Phase4D2Client();
      await coordB2.connect(portB, sharedRoom);
      await sleep(700);

      expect(readdirSync(peersDir).some((e) => e.includes("presence-B"))).toBe(true);
      expect(coordA.received.some((m) => m.raw.includes("No peer currently active"))).toBe(false);

      coordA.close();
      coordB2.close();
    } finally {
      procA?.kill();
      procB?.kill();
      await sleep(200);
      try { rmSync(sharedStateDir, { recursive: true, force: true }); } catch {}
    }
  }, 30000);

  // ── Test 4: heartbeat removed on coordinator detach after grace window ─────

  test("4. daemon heartbeat removed from non-default room after deactivation grace when last coordinator detaches", async () => {
    const uniqueRoom = `d2-detach-${Date.now()}`;
    const coord = new Phase4D2Client();
    await coord.connect(PORT, uniqueRoom);

    const peersDir = join(STATE_DIR, uniqueRoom, "peers");
    expect(existsSync(peersDir)).toBe(true);
    const beforeEntries = readdirSync(peersDir);
    expect(beforeEntries.some((e) => e.includes(ENDPOINT))).toBe(true);

    // Disconnect the coordinator, then wait past the deactivation grace period.
    coord.close();
    await sleep(1300);

    // Daemon heartbeat must be gone from the non-default room after grace elapses.
    if (existsSync(peersDir)) {
      const afterEntries = readdirSync(peersDir);
      expect(afterEntries.some((e) => e.includes(ENDPOINT))).toBe(false);
    }
    // If the whole dir was cleaned up, that also satisfies the invariant
  });

  // ── Test 5: room switch deactivates old room, activates new ──────────────

  test("5. room switch: new non-default room activates immediately and old room deactivates after grace", async () => {
    const roomA = `d2-switch-a-${Date.now()}`;
    const roomB = `d2-switch-b-${Date.now()}`;

    const coord = new Phase4D2Client();
    await coord.connect(PORT, roomA);

    const peersA = join(STATE_DIR, roomA, "peers");
    expect(existsSync(peersA)).toBe(true);
    expect(readdirSync(peersA).some((e) => e.includes(ENDPOINT))).toBe(true);

    // Switch to roomB via second claude_connect
    await coord.switchRoom(roomB);

    const peersB = join(STATE_DIR, roomB, "peers");
    expect(existsSync(peersB)).toBe(true);
    expect(readdirSync(peersB).some((e) => e.includes(ENDPOINT))).toBe(true);

    // roomA should retain its heartbeat during the grace period, then lose it.
    expect(existsSync(peersA)).toBe(true);
    expect(readdirSync(peersA).some((e) => e.includes(ENDPOINT))).toBe(true);

    await sleep(1300);

    if (existsSync(peersA)) {
      expect(readdirSync(peersA).some((e) => e.includes(ENDPOINT))).toBe(false);
    }

    coord.close();
    await sleep(300);
  });

  // ── Test 6: default room relay unaffected by coordinator lifecycle ─────────

  test("6. default room relay remains active throughout coordinator attach/detach cycles", async () => {
    const defaultPeersDir = join(STATE_DIR, DEFAULT_ROOM, "peers");

    // Create and tear down several non-default room coordinators
    for (let i = 0; i < 3; i++) {
      const c = new Phase4D2Client();
      await c.connect(PORT, `d2-transient-${i}-${Date.now()}`);
      c.close();
      await sleep(100);
    }

    // Default room must still have its heartbeat
    expect(existsSync(defaultPeersDir)).toBe(true);
    const entries = readdirSync(defaultPeersDir);
    expect(entries.some((e) => e.includes(ENDPOINT))).toBe(true);
  });

  // ── Test 7: 2-daemon non-default room file relay ──────────────────────────

  test("7. two daemons in same non-default room: message delivered via per-room file relay", async () => {
    const sharedRoom = `d2-shared-${Date.now()}`;
    const sharedStateDir = `/tmp/cc-bridge-d2-shared-${Date.now()}`;
    const portA = 44000 + Math.floor(Math.random() * 2000);
    const portB = portA + 1;
    let procA: Subprocess | null = null;
    let procB: Subprocess | null = null;

    try {
      procA = await spawnDaemon(portA, `d2-own-A-${Date.now()}`, "relay-A", sharedStateDir);
      procB = await spawnDaemon(portB, `d2-own-B-${Date.now()}`, "relay-B", sharedStateDir);

      // Connect both coordinators to the shared non-default room
      const coordA = new Phase4D2Client();
      const coordB = new Phase4D2Client();
      await coordA.connect(portA, sharedRoom);
      await coordB.connect(portB, sharedRoom);

      // Allow heartbeats to propagate: each daemon writes to STATE_DIR/sharedRoom/peers/
      // Both daemons need to discover each other via refreshPeers
      await sleep(700);

      // Verify both peers visible in shared room peers dir
      const peersDir = join(sharedStateDir, sharedRoom, "peers");
      const peerFiles = readdirSync(peersDir);
      expect(peerFiles.some((e) => e.includes("relay-A"))).toBe(true);
      expect(peerFiles.some((e) => e.includes("relay-B"))).toBe(true);

      // coordA sends to relay-B — written to STATE_DIR/sharedRoom/messages/
      const beforeCount = coordB.received.length;
      const result = await coordA.postMessage("file-relay-test in non-default room", ["relay-B"]);
      expect(result.success).toBe(true);

      // Verify message file created in the shared room's messages dir (not default room's)
      const sharedMsgsDir = join(sharedStateDir, sharedRoom, "messages");
      expect(existsSync(sharedMsgsDir)).toBe(true);
      const msgFiles = readdirSync(sharedMsgsDir);
      expect(msgFiles.length).toBeGreaterThan(0);

      // coordB should receive the message via pollMessages(sharedRoom)
      const deadline = Date.now() + 3000;
      let found = false;
      while (Date.now() < deadline) {
        if (coordB.received.length > beforeCount &&
            coordB.received.some((m) => m.raw.includes("file-relay-test in non-default room"))) {
          found = true;
          break;
        }
        await sleep(100);
      }
      expect(found).toBe(true);

      // Verify the message landed in the shared non-default room's dir, not any default-room dir
      expect(sharedMsgsDir).toContain(sharedRoom);

      coordA.close();
      coordB.close();
    } finally {
      procA?.kill();
      procB?.kill();
      await sleep(200);
      try { rmSync(sharedStateDir, { recursive: true, force: true }); } catch {}
    }
  }, 30000);

  test("8. relay message is buffered and delivered when coordinator connects", async () => {
    // After the push/pull fix, daemon B now ACKs and buffers messages via emitToClaude
    // even without a coordinator. The message is delivered via flushBufferedMessages
    // when a coordinator connects.
    const sharedRoom = `d2-no-coord-${Date.now()}`;
    const sharedStateDir = `/tmp/cc-bridge-d2-no-coord-${Date.now()}`;
    const portA = 46000 + Math.floor(Math.random() * 1000);
    const portB = portA + 1;
    let procA: Subprocess | null = null;
    let procB: Subprocess | null = null;

    try {
      procA = await spawnDaemon(portA, sharedRoom, "no-coord-A", sharedStateDir);
      procB = await spawnDaemon(portB, sharedRoom, "no-coord-B", sharedStateDir);

      const coordA = new Phase4D2Client();
      await coordA.connect(portA, sharedRoom);
      await sleep(700);

      const sendResult = await coordA.postMessage("persist-until-coordinator-connects", ["no-coord-B"]);
      expect(sendResult.success).toBe(true);

      // Wait for B's daemon to poll and buffer the message (ACKs immediately now)
      await sleep(800);

      // Connect coordinator B — should receive the buffered message via flushBufferedMessages
      const coordB = new Phase4D2Client();
      await coordB.connect(portB, sharedRoom);

      const deliveryDeadline = Date.now() + 4000;
      let delivered = false;
      while (Date.now() < deliveryDeadline) {
        if (coordB.received.some((m) => m.raw.includes("persist-until-coordinator-connects"))) {
          delivered = true;
          break;
        }
        await sleep(100);
      }
      expect(delivered).toBe(true);

      // Message file should be cleaned up (both peers ACKed)
      const messagesDir = join(sharedStateDir, sharedRoom, "messages");
      const cleanupDeadline = Date.now() + 4000;
      let cleanedUp = false;
      while (Date.now() < cleanupDeadline) {
        const remainingMessageFiles = readdirSync(messagesDir).filter((entry) => entry.endsWith(".json"));
        if (remainingMessageFiles.length === 0) {
          cleanedUp = true;
          break;
        }
        await sleep(100);
      }
      expect(cleanedUp).toBe(true);

      coordA.close();
      coordB.close();
    } finally {
      procA?.kill();
      procB?.kill();
      await sleep(200);
      try { rmSync(sharedStateDir, { recursive: true, force: true }); } catch {}
    }
  }, 30000);

});
