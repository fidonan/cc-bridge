/**
 * Phase 3B integration tests — Task/Trigger Orchestration Primitives
 *
 * Exercises:
 *   1. assign_task happy path: coordinator assigns → assign_task_result{success:true} (relay, not completion)
 *   2. Worker emits loop_event{running} → coordinator receives via supervisor sink with task_id
 *   3. Worker emits loop_event{completed} → task removed from activeTasks; observable received
 *   4. assign_task to terminated/unknown endpoint → TASK_TARGET_NOT_FOUND
 *   5. assign_task with duplicate in-flight task_id → TASK_ID_CONFLICT
 *   6. assign_task from non-coordinator WS → TASK_ASSIGN_FORBIDDEN
 *   7. Per-task timeout fires → LoopEvent{state:'timeout'} observable; task cleaned up
 *   8. Worker terminated while task in-flight → LoopEvent{state:'failed', reason:'worker_terminated'}
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LaunchRequest, LaunchResult, MessageEnvelope, RegistrySnapshot, TerminatePeerRequest } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const CHILD_PATH = new URL("./test-peer-child.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase3b-test";
const ROOM = "test-phase3b";
const COORDINATOR = "coord-A3B";
const BOOTSTRAP_TIMEOUT_MS = 2000;
const STALL_ESCALATION_MS = 2000;

const PORT = 31000 + Math.floor(Math.random() * 3000);
let proc: Subprocess | null = null;
let client: Phase3BTestClient;
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
    message_id: `t3b_${++msgCounter}_${Date.now()}`,
    from,
    sent_at: Date.now(),
    kind,
    intent,
    payload,
    ...opts,
  };
}

function makeTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Test Client ───────────────────────────────────────────────────────────────

interface ObservableEntry {
  raw: string;
  parsed: unknown;
}

class Phase3BTestClient {
  private ws!: WebSocket;
  private reqId = 0;
  readonly observables: ObservableEntry[] = [];
  private resolvers = new Map<string, (v: any) => void>();

  async connect(port: number) {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WS connect failed on port ${port}`));
      this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
    });
    this.ws.send(JSON.stringify({ type: "claude_connect" }));
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

  private req<T>(msg: object): Promise<T> {
    const requestId = `r3b_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  supervisorAttach(endpoint: string) {
    return this.req<{ type: "supervisor_attach_result"; success: boolean; error?: unknown }>({
      type: "supervisor_attach",
      endpoint,
    });
  }

  assignTask(assignment: { task_id: string; assigned_to: string; payload?: unknown; timeout_ms?: number }) {
    return this.req<{ type: "assign_task_result"; result: { success: boolean; task_id: string; error?: { code: string; message: string } } }>({
      type: "assign_task",
      assignment: { ...assignment, payload: assignment.payload ?? {} },
    });
  }

  launchPeer(request: LaunchRequest) {
    return this.req<{ type: "launch_peer_result"; result: LaunchResult }>({
      type: "launch_peer",
      request,
    });
  }

  terminatePeer(request: TerminatePeerRequest) {
    return this.req<{ type: "terminate_peer_result"; result: { success: boolean } }>({
      type: "terminate_peer",
      request,
    });
  }

  postEnvelope(envelope: MessageEnvelope) {
    return this.req<{ type: "post_envelope_result"; success: boolean }>({
      type: "post_envelope",
      envelope,
    });
  }

  queryRegistry() {
    return this.req<{ type: "query_registry_result"; snapshot: RegistrySnapshot }>({
      type: "query_registry",
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

// ── Non-coordinator WS helper ─────────────────────────────────────────────────

class RawTestClient {
  private ws!: WebSocket;
  private reqId = 0;
  private resolvers = new Map<string, (v: any) => void>();

  async connect(port: number) {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WS connect failed on port ${port}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        const r = this.resolvers.get(msg.requestId);
        if (r) { this.resolvers.delete(msg.requestId); r(msg); }
      };
    });
    // No claude_connect
  }

  req<T>(msg: object): Promise<T> {
    const requestId = `raw_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  assignTask(assignment: { task_id: string; assigned_to: string; payload?: unknown }) {
    return this.req<{ type: "assign_task_result"; result: { success: boolean; task_id: string; error?: { code: string } } }>({
      type: "assign_task",
      assignment: { ...assignment, payload: assignment.payload ?? {} },
    });
  }

  close() { try { this.ws.close(); } catch {} }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(`/tmp/cc-bridge-phase3b-${PORT}.pid`, { force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase3b-${PORT}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase3b-${PORT}.log`,
      CC_BRIDGE_ROOM: ROOM,
      CC_BRIDGE_ENDPOINT: COORDINATOR,
      CC_BRIDGE_STATE_DIR: STATE_DIR,
      CC_BRIDGE_HEARTBEAT_MS: "300",
      CC_BRIDGE_PEER_STALE_MS: "800",
      CC_BRIDGE_POLL_INTERVAL_MS: "200",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: String(BOOTSTRAP_TIMEOUT_MS),
      CC_BRIDGE_STALL_ESCALATION_MS: String(STALL_ESCALATION_MS),
      CC_BRIDGE_SPAWN_COMMAND: `bun run ${CHILD_PATH}`,
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

  client = new Phase3BTestClient();
  await client.connect(PORT);

  // Attach supervisor so all observables route to client
  await client.supervisorAttach(COORDINATOR);
});

afterAll(async () => {
  client?.close();
  proc?.kill();
  await sleep(200);
});

// ── Helpers for peer registration ─────────────────────────────────────────────

async function registerPeer(endpoint: string, role = "Worker"): Promise<void> {
  await client.postEnvelope(makeEnvelope(endpoint, "control", "register", { endpoint, role }));
  await client.waitForObservable(
    (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "connected",
    3000,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 3B — Task Assignment", () => {

  // ── Gate 1: assign_task happy path ────────────────────────────────────────

  test("1. assign_task returns success immediately after relay (not task completion)", async () => {
    const endpoint = `worker-g1-${Date.now()}`;
    await registerPeer(endpoint);

    const taskId = makeTaskId();
    const result = await client.assignTask({ task_id: taskId, assigned_to: endpoint, payload: { work: "gate1" } });

    expect(result.result.success).toBe(true);
    expect(result.result.task_id).toBe(taskId);
    expect(result.result.error).toBeUndefined();

    // Clean up: emit completed so task leaves activeTasks
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId, endpoint, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
  });

  // ── Gate 2: loop_event{running} received via supervisor sink ─────────────

  test("2. worker emits loop_event{running} → coordinator receives via supervisor sink with task_id", async () => {
    const endpoint = `worker-g2-${Date.now()}`;
    await registerPeer(endpoint);

    const taskId = makeTaskId();
    await client.assignTask({ task_id: taskId, assigned_to: endpoint });

    // Simulate worker emitting loop_event{running}
    const loopId = `loop-${Date.now()}`;
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      loop_id: loopId,
      task_id: taskId,
      endpoint,
      state: "running",
      observed_at: Date.now(),
    }));

    const obs = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "running",
    );
    expect(obs).not.toBeNull();
    expect(obs.loop_id).toBe(loopId);
    expect(obs.endpoint).toBe(endpoint);

    // Clean up
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId, endpoint, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
  });

  // ── Gate 3: loop_event{completed} removes task from activeTasks ───────────

  test("3. loop_event{completed} removes task; same task_id can be reused after completion", async () => {
    const endpoint = `worker-g3-${Date.now()}`;
    await registerPeer(endpoint);

    const taskId = makeTaskId();
    await client.assignTask({ task_id: taskId, assigned_to: endpoint });

    // Complete the task
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId, endpoint, state: "completed", observed_at: Date.now(),
    }));
    const completedObs = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "completed",
    );
    expect(completedObs).not.toBeNull();

    // Reuse same task_id — should succeed (no longer in-flight)
    const result2 = await client.assignTask({ task_id: taskId, assigned_to: endpoint });
    expect(result2.result.success).toBe(true);

    // Clean up
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId, endpoint, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
  });

  // ── Gate 4: TASK_TARGET_NOT_FOUND ─────────────────────────────────────────

  test("4. assign_task to unknown endpoint → TASK_TARGET_NOT_FOUND", async () => {
    const result = await client.assignTask({ task_id: makeTaskId(), assigned_to: "nonexistent-ep" });
    expect(result.result.success).toBe(false);
    expect(result.result.error?.code).toBe("TASK_TARGET_NOT_FOUND");
  });

  // ── Gate 5: TASK_ID_CONFLICT ──────────────────────────────────────────────

  test("5. duplicate in-flight task_id → TASK_ID_CONFLICT", async () => {
    const endpoint = `worker-g5-${Date.now()}`;
    await registerPeer(endpoint);

    const taskId = makeTaskId();
    const r1 = await client.assignTask({ task_id: taskId, assigned_to: endpoint });
    expect(r1.result.success).toBe(true);

    // Assign same task_id again while first is in-flight
    const r2 = await client.assignTask({ task_id: taskId, assigned_to: endpoint });
    expect(r2.result.success).toBe(false);
    expect(r2.result.error?.code).toBe("TASK_ID_CONFLICT");

    // Clean up
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId, endpoint, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
  });

  // ── Gate 6: TASK_ASSIGN_FORBIDDEN ────────────────────────────────────────

  test("6. non-coordinator WS → TASK_ASSIGN_FORBIDDEN", async () => {
    const endpoint = `worker-g6-${Date.now()}`;
    await registerPeer(endpoint);

    const nonCoord = new RawTestClient();
    await nonCoord.connect(PORT);
    await sleep(50);

    const result = await nonCoord.assignTask({ task_id: makeTaskId(), assigned_to: endpoint });
    expect(result.result.success).toBe(false);
    expect(result.result.error?.code).toBe("TASK_ASSIGN_FORBIDDEN");

    nonCoord.close();
  });

  // ── Gate 7: Per-task timeout → LoopEvent{state:'timeout'} ────────────────

  test("7. per-task timeout fires → LoopEvent{state:'timeout'} observable; task cleaned up", async () => {
    const endpoint = `worker-g7-${Date.now()}`;
    await registerPeer(endpoint);

    const taskId = makeTaskId();
    const TIMEOUT_MS = 500;

    const r = await client.assignTask({ task_id: taskId, assigned_to: endpoint, timeout_ms: TIMEOUT_MS });
    expect(r.result.success).toBe(true);

    // Wait for timeout observable
    const obs = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "timeout",
      TIMEOUT_MS + 2000,
    );
    expect(obs).not.toBeNull();
    expect(obs.endpoint).toBe(endpoint);
    // loop_id absent for daemon-generated timeout events
    expect(obs.loop_id).toBeUndefined();

    // Task should now be out of activeTasks; same task_id can be reused
    const r2 = await client.assignTask({ task_id: taskId, assigned_to: endpoint });
    expect(r2.result.success).toBe(true);

    // Clean up
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId, endpoint, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
  });

  // ── Gate 8: Worker terminated while task in-flight ────────────────────────

  test("8. worker terminated while task in-flight → LoopEvent{state:'failed', reason:'worker_terminated'}", async () => {
    // Launch a real child that registers + acks then stays alive
    const launchResult = await client.launchPeer({
      role: "TermWorker",
      coordinator: COORDINATOR,
    });
    expect(launchResult.result.success).toBe(true);
    const workerEndpoint = launchResult.result.endpoint!;

    // Wait for bootstrap_ack
    const ack = await client.waitForObservable(
      (p) => p?.endpoint === workerEndpoint && (p?.status === "acked" || p?.state === "acked"),
      5000,
    );
    expect(ack).not.toBeNull();

    // Assign a task with no timeout (stays in-flight until worker dies)
    const taskId = makeTaskId();
    const r = await client.assignTask({ task_id: taskId, assigned_to: workerEndpoint });
    expect(r.result.success).toBe(true);

    // Terminate the worker
    await client.terminatePeer({ endpoint: workerEndpoint });

    // Expect LoopEvent{state:'failed'} for the in-flight task
    const failObs = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "failed",
      4000,
    );
    expect(failObs).not.toBeNull();
    expect(failObs.details?.reason).toBe("worker_terminated");
    expect(failObs.endpoint).toBe(workerEndpoint);
  });

});
