/**
 * 4-window integration test
 *
 * Spawns 4 daemon processes (A, B, C, D) in the same room and verifies:
 *   1. A → B   (direct)
 *   2. B → C   (direct)
 *   3. C → A, D (multicast)
 *   4. D → ALL  (broadcast)
 *
 * Each daemon gets its own control port and state is isolated to /tmp/cc-bridge-4w-test/.
 */

import { spawn, type Subprocess } from "bun";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ── Config ───────────────────────────────────────────────────────────────────

const ROOM = "test-4window";
const STATE_DIR = "/tmp/cc-bridge-4w-test";
const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;

const PEERS = ["A", "B", "C", "D"] as const;
type Peer = (typeof PEERS)[number];

const PORT = {} as Record<Peer, number>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function allocatePorts(): Record<Peer, number> {
  // Keep ports deterministic enough for logs, but random enough to avoid
  // collisions with previous local test runs.
  const base = 20000 + Math.floor(Math.random() * 20000);
  return {
    A: base,
    B: base + 1,
    C: base + 2,
    D: base + 3,
  };
}

function logPath(peer: Peer) {
  return `/tmp/cc-bridge-4w-${peer}.log`;
}

function tailLog(peer: Peer) {
  try {
    return readFileSync(logPath(peer), "utf-8").trim().split("\n").slice(-40).join("\n");
  } catch {
    return "(no daemon log found)";
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function daemonEnv(peer: Peer): Record<string, string> {
  return {
    ...process.env,
    AGENTBRIDGE_CONTROL_PORT: String(PORT[peer]),
    AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-4w-${peer}.pid`,
    AGENTBRIDGE_LOG_FILE: logPath(peer),
    CC_BRIDGE_ROOM: ROOM,
    CC_BRIDGE_ENDPOINT: peer,
    CC_BRIDGE_STATE_DIR: STATE_DIR,
    CC_BRIDGE_HEARTBEAT_MS: "500",
    CC_BRIDGE_PEER_STALE_MS: "3000",
    CC_BRIDGE_POLL_INTERVAL_MS: "300",
    AGENTBRIDGE_IDLE_SHUTDOWN_MS: "60000",
  } as Record<string, string>;
}

async function waitHealthy(peer: Peer, maxMs = 8000) {
  const url = `http://127.0.0.1:${PORT[peer]}/healthz`;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Daemon ${peer} did not become healthy within ${maxMs}ms.\n${tailLog(peer)}`);
}

// ── Daemon WebSocket client ───────────────────────────────────────────────────

interface ReceivedMessage {
  content: string;
  senderId: string;
}

class TestDaemonClient {
  private ws!: WebSocket;
  private reqId = 0;
  readonly received: ReceivedMessage[] = [];
  private resolvers = new Map<string, (v: any) => void>();

  constructor(private peer: Peer) {}

  async connect() {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT[this.peer]}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WS open failed for ${this.peer}`));
      this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
    });
    this.ws.send(JSON.stringify({ type: "claude_connect" }));
  }

  private onMessage(msg: any) {
    if (msg.type === "codex_to_claude") {
      const content: string = msg.message.content;
      const senderId = msg.message.senderId ?? msg.message.sender ?? "unknown";
      this.received.push({ content, senderId });
    }
    const resolver = this.resolvers.get(msg.requestId);
    if (resolver) {
      this.resolvers.delete(msg.requestId);
      resolver(msg);
    }
  }

  async send(text: string, to?: string[]): Promise<{ success: boolean; resolvedRecipients?: string[]; error?: string }> {
    const requestId = `req_${this.peer}_${++this.reqId}`;
    return new Promise((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({
        type: "post_message",
        requestId,
        message: { id: requestId, source: "claude", content: text, timestamp: Date.now() },
        ...(to && to.length > 0 ? { to } : {}),
      }));
    });
  }

  async waitMessages(minCount: number, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.received.length >= minCount) return;
      await sleep(100);
    }
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

const procs: Subprocess[] = [];
const clients: Record<Peer, TestDaemonClient> = {} as any;

beforeAll(async () => {
  // Clean state dir
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  for (const peer of PEERS) {
    rmSync(`/tmp/cc-bridge-4w-${peer}.pid`, { force: true });
    rmSync(logPath(peer), { force: true });
  }

  Object.assign(PORT, allocatePorts());

  // Spawn 4 daemons
  for (const peer of PEERS) {
    const proc = spawn(["bun", "run", DAEMON_PATH], {
      env: daemonEnv(peer),
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(proc);
  }

  // Wait for all to be healthy
  await Promise.all(PEERS.map((p) => waitHealthy(p)));

  // Extra settle time for heartbeats/peer discovery
  await sleep(1500);

  // Connect all clients
  for (const peer of PEERS) {
    const client = new TestDaemonClient(peer);
    await client.connect();
    clients[peer] = client;
  }

  // Allow peer-discovery heartbeat cycle to complete
  await sleep(1200);
}, 20000);

afterAll(async () => {
  for (const client of Object.values(clients)) client.close();
  for (const proc of procs) { try { proc.kill(); } catch {} }
  await sleep(500);
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  for (const peer of PEERS) {
    rmSync(`/tmp/cc-bridge-4w-${peer}.pid`, { force: true });
    rmSync(logPath(peer), { force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("4-window routing", () => {
  test("A → B (direct): only B receives", async () => {
    const beforeB = clients.B.received.length;
    const beforeC = clients.C.received.length;
    const beforeD = clients.D.received.length;

    const result = await clients.A.send("hello from A to B only", ["B"]);
    expect(result.success).toBe(true);
    expect(result.resolvedRecipients).toEqual(["B"]);

    await clients.B.waitMessages(beforeB + 1);
    await sleep(600); // extra settle

    expect(clients.B.received.length).toBe(beforeB + 1);
    expect(clients.B.received.at(-1)!.content).toContain("hello from A to B only");
    expect(clients.C.received.length).toBe(beforeC); // C should NOT receive
    expect(clients.D.received.length).toBe(beforeD); // D should NOT receive
  });

  test("B → C (direct): only C receives", async () => {
    const beforeA = clients.A.received.length;
    const beforeC = clients.C.received.length;
    const beforeD = clients.D.received.length;

    const result = await clients.B.send("hello from B to C only", ["C"]);
    expect(result.success).toBe(true);
    expect(result.resolvedRecipients).toEqual(["C"]);

    await clients.C.waitMessages(beforeC + 1);
    await sleep(600);

    expect(clients.C.received.length).toBe(beforeC + 1);
    expect(clients.C.received.at(-1)!.content).toContain("hello from B to C only");
    expect(clients.A.received.length).toBe(beforeA);
    expect(clients.D.received.length).toBe(beforeD);
  });

  test("C → A, D (multicast): only A and D receive", async () => {
    const beforeA = clients.A.received.length;
    const beforeB = clients.B.received.length;
    const beforeD = clients.D.received.length;

    const result = await clients.C.send("hello from C to A and D", ["A", "D"]);
    expect(result.success).toBe(true);
    expect(result.resolvedRecipients?.sort()).toEqual(["A", "D"]);

    await Promise.all([
      clients.A.waitMessages(beforeA + 1),
      clients.D.waitMessages(beforeD + 1),
    ]);
    await sleep(600);

    expect(clients.A.received.length).toBe(beforeA + 1);
    expect(clients.D.received.length).toBe(beforeD + 1);
    expect(clients.B.received.length).toBe(beforeB); // B should NOT receive
  });

  test("D → ALL (broadcast): A, B, C all receive", async () => {
    const beforeA = clients.A.received.length;
    const beforeB = clients.B.received.length;
    const beforeC = clients.C.received.length;

    const result = await clients.D.send("hello from D to everyone");
    expect(result.success).toBe(true);
    expect(result.resolvedRecipients?.sort()).toEqual(["A", "B", "C"]);

    await Promise.all([
      clients.A.waitMessages(beforeA + 1),
      clients.B.waitMessages(beforeB + 1),
      clients.C.waitMessages(beforeC + 1),
    ]);
    await sleep(600);

    expect(clients.A.received.length).toBe(beforeA + 1);
    expect(clients.B.received.length).toBe(beforeB + 1);
    expect(clients.C.received.length).toBe(beforeC + 1);
    expect(clients.A.received.at(-1)!.content).toContain("hello from D to everyone");
  });

  test("targeted send to offline peer fails with clear error", async () => {
    const result = await clients.A.send("this should fail", ["Z"]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENDPOINT_NOT_FOUND|are currently online/);
  });
});
