/**
 * Phase 4C-3 Integration Tests — Load-Aware Assignment Hints (Advisory)
 *
 * Verifies that query_registry returns advisory active_task_count per peer,
 * computed at snapshot time from room.activeTasks (not stored in peerRegistry).
 *
 *   1. query_registry returns active_task_count=1 for a peer with one in-flight task
 *   2. active_task_count decrements to 0 after task completes
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MessageEnvelope, PeerSnapshotEntry } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase4c3-test";
const ROOM = "test-phase4c3";
const COORDINATOR = "coord-4C3";

const PORT = 38000 + Math.floor(Math.random() * 3000);
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
    message_id: `t4c3_${++msgCounter}_${Date.now()}`,
    from,
    sent_at: Date.now(),
    kind,
    intent,
    payload,
    ...opts,
  };
}

function makeTaskId() {
  return `task-4c3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Test client ───────────────────────────────────────────────────────────────

class Phase4C3Client {
  private ws!: WebSocket;
  private reqId = 0;
  readonly observables: { raw: string; parsed: unknown }[] = [];
  private resolvers = new Map<string, (v: any) => void>();

  async connect(port: number) {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WS connect failed on port ${port}`));
      this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
    });
    this.ws.send(JSON.stringify({ type: "claude_connect", room: ROOM }));
    await sleep(100);
  }

  private onMessage(msg: any) {
    if (msg.type === "codex_to_claude") {
      const raw: string = msg.message?.content ?? "";
      let parsed: unknown = null;
      try { parsed = JSON.parse(raw); } catch {}
      this.observables.push({ raw, parsed });
    }
    const resolver = this.resolvers.get(msg.requestId);
    if (resolver) {
      this.resolvers.delete(msg.requestId);
      resolver(msg);
    }
  }

  req<T>(msg: object): Promise<T> {
    const requestId = `rc3_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  supervisorAttach(endpoint: string) {
    return this.req<{ success: boolean }>({ type: "supervisor_attach", endpoint });
  }

  assignTask(assignment: { task_id: string; assigned_to: string; payload?: unknown; timeout_ms?: number }) {
    return this.req<{ type: "assign_task_result"; result: { success: boolean; task_id: string; error?: { code: string } } }>({
      type: "assign_task",
      assignment: { ...assignment, payload: assignment.payload ?? {} },
    });
  }

  queryRegistry() {
    return this.req<{ type: "query_registry_result"; snapshot: { peers: PeerSnapshotEntry[] } }>({
      type: "query_registry",
    });
  }

  postEnvelope(envelope: MessageEnvelope) {
    return this.req<{ type: "post_envelope_result"; success: boolean }>({
      type: "post_envelope",
      envelope,
    });
  }

  async waitForObservable(predicate: (p: any) => boolean, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.observables.find((o) => o.parsed !== null && predicate(o.parsed));
      if (found) return found.parsed;
      await sleep(50);
    }
    return null;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let coord: Phase4C3Client;

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(`/tmp/cc-bridge-phase4c3-${PORT}.pid`, { force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase4c3-${PORT}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase4c3-${PORT}.log`,
      CC_BRIDGE_ROOM: ROOM,
      CC_BRIDGE_ENDPOINT: COORDINATOR,
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

  coord = new Phase4C3Client();
  await coord.connect(PORT);
  await coord.supervisorAttach(COORDINATOR);
});

afterAll(async () => {
  coord?.close();
  proc?.kill();
  await sleep(200);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 4C-3 — Load-Aware Assignment Hints", () => {

  // ── 1: query_registry reflects in-flight task count ──────────────────────────

  test("1. query_registry returns active_task_count=1 for peer with one in-flight task", async () => {
    const ep = `w-load-${Date.now()}`;

    // Register a simulated worker
    await coord.postEnvelope(makeEnvelope(ep, "control", "register", { endpoint: ep, role: "LoadWorker" }));
    await coord.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === ep && p?.payload?.status === "connected",
      3000,
    );

    // Baseline: active_task_count should be 0 before any task is assigned
    const snap0 = await coord.queryRegistry();
    const peer0 = snap0.snapshot.peers.find((p) => p.endpoint === ep);
    expect(peer0).toBeDefined();
    expect(peer0!.active_task_count).toBe(0);

    // Assign a task
    const taskId = makeTaskId();
    const r = await coord.assignTask({ task_id: taskId, assigned_to: ep, timeout_ms: 30000 });
    expect(r.result.success).toBe(true);

    // active_task_count should now be 1
    const snap1 = await coord.queryRegistry();
    const peer1 = snap1.snapshot.peers.find((p) => p.endpoint === ep);
    expect(peer1).toBeDefined();
    expect(peer1!.active_task_count).toBe(1);

    // Store taskId for test 2 (sequential tests share the in-flight task)
    // Cleanup happens in test 2
  });

  // ── 2: active_task_count decrements after task completes ─────────────────────

  test("2. active_task_count returns to 0 after task completes", async () => {
    const ep = `w-load-${Date.now()}`;

    // Register worker and assign a task
    await coord.postEnvelope(makeEnvelope(ep, "control", "register", { endpoint: ep, role: "LoadWorker" }));
    await coord.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === ep && p?.payload?.status === "connected",
      3000,
    );

    const taskId = makeTaskId();
    const r = await coord.assignTask({ task_id: taskId, assigned_to: ep, timeout_ms: 30000 });
    expect(r.result.success).toBe(true);

    // Confirm in-flight count
    const snapBefore = await coord.queryRegistry();
    const peerBefore = snapBefore.snapshot.peers.find((p) => p.endpoint === ep);
    expect(peerBefore!.active_task_count).toBe(1);

    // Complete the task
    await coord.postEnvelope(makeEnvelope(ep, "control", "loop_event", {
      task_id: taskId, endpoint: ep, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);

    // active_task_count should return to 0
    const snapAfter = await coord.queryRegistry();
    const peerAfter = snapAfter.snapshot.peers.find((p) => p.endpoint === ep);
    expect(peerAfter).toBeDefined();
    expect(peerAfter!.active_task_count).toBe(0);
  });

});
