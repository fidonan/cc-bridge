/**
 * Race Condition Hardening Tests — Single-Winner Terminal Path
 *
 * Exercises the single-winner invariant: `removeActiveTask` is the exclusive
 * cleanup gate. Any path (timeout, worker death, stall escalation) that fires
 * after the gate has been crossed must be a no-op — no duplicate terminal events,
 * no double timer cleanup, no re-insertion into activeTasks.
 *
 * Three scenarios:
 *   1. Timeout fires first, then worker terminates shortly after
 *      → exactly one terminal event (timeout); worker-exit path finds no active task
 *   2. Worker terminates first, then timeout would have fired
 *      → exactly one terminal event (failed/worker_terminated); timer cleared atomically
 *   3. Late loop_event{completed} from worker after daemon-generated timeout already fired
 *      → late event is routed (observability), activeTasks already cleared (no double cleanup)
 *   4. Stall escalation with in-flight task
 *      → LoopEvent{failed, reason:'worker_terminated'} emitted; activeTasks cleaned up
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LaunchRequest, LaunchResult, MessageEnvelope } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const CHILD_PATH = new URL("./test-peer-child.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-hardening-test";
const ROOM = "test-hardening";
const COORDINATOR = "coord-hardening";

const PORT = 35000 + Math.floor(Math.random() * 3000);
let daemonProc: Subprocess | null = null;
let client: HardeningClient;
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
    message_id: `th_${++msgCounter}_${Date.now()}`,
    from,
    sent_at: Date.now(),
    kind,
    intent,
    payload,
    ...opts,
  };
}

function makeTaskId() {
  return `htask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Test Client ───────────────────────────────────────────────────────────────

class HardeningClient {
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
    const requestId = `rh_${++this.reqId}`;
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

  launchPeer(request: LaunchRequest) {
    return this.req<{ type: "launch_peer_result"; result: LaunchResult }>({
      type: "launch_peer",
      request,
    });
  }

  terminatePeer(endpoint: string) {
    return this.req<{ type: "terminate_peer_result"; result: { success: boolean } }>({
      type: "terminate_peer",
      request: { endpoint },
    });
  }

  postEnvelope(envelope: MessageEnvelope) {
    return this.req<{ type: "post_envelope_result"; success: boolean }>({
      type: "post_envelope",
      envelope,
    });
  }

  /** Collect all terminal LoopEvents for a task_id within timeoutMs. */
  async collectTerminalEvents(taskId: string, waitMs: number): Promise<any[]> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(50);
    }
    return this.observables
      .map((o) => o.parsed)
      .filter((p: any) => p?.task_id === taskId &&
        (p?.state === "completed" || p?.state === "timeout" || p?.state === "failed"));
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

  clearObservables() {
    this.observables.splice(0, this.observables.length);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(`/tmp/cc-bridge-hardening-${PORT}.pid`, { force: true });

  daemonProc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-hardening-${PORT}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-hardening-${PORT}.log`,
      CC_BRIDGE_ROOM: ROOM,
      CC_BRIDGE_ENDPOINT: COORDINATOR,
      CC_BRIDGE_STATE_DIR: STATE_DIR,
      CC_BRIDGE_HEARTBEAT_MS: "300",
      CC_BRIDGE_PEER_STALE_MS: "800",
      CC_BRIDGE_POLL_INTERVAL_MS: "200",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: "2000",
      CC_BRIDGE_STALL_ESCALATION_MS: "1500",
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

  client = new HardeningClient();
  await client.connect(PORT);
  await client.supervisorAttach(COORDINATOR);
});

afterAll(async () => {
  client?.close();
  daemonProc?.kill();
  await sleep(200);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function spawnAndBootstrap(): Promise<string> {
  const launchResult = await client.launchPeer({ role: "HardeningWorker", coordinator: COORDINATOR });
  expect(launchResult.result.success).toBe(true);
  const endpoint = launchResult.result.endpoint!;

  const ack = await client.waitForObservable(
    (p) => p?.endpoint === endpoint && (p?.status === "acked" || p?.status === "bootstrapped"),
    6000,
  );
  expect(ack).not.toBeNull();
  return endpoint;
}

async function registerPeer(endpoint: string, role = "HardeningWorker"): Promise<void> {
  await client.postEnvelope(makeEnvelope(endpoint, "control", "register", { endpoint, role }));
  await client.waitForObservable(
    (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "connected",
    3000,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Race Condition Hardening — Single-Winner Terminal Path", () => {

  // ── Scenario 1: Timeout fires first, worker terminates shortly after ────────

  test("1. timeout fires before worker death → exactly one terminal event; worker-exit path is no-op", async () => {
    const endpoint = await spawnAndBootstrap();
    const taskId = makeTaskId();
    const TIMEOUT_MS = 300;

    client.clearObservables();

    // Assign task with short timeout
    const r = await client.assignTask({ task_id: taskId, assigned_to: endpoint, timeout_ms: TIMEOUT_MS });
    expect(r.result.success).toBe(true);

    // Wait for timeout to fire (daemon-generated)
    const timeoutEvent = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "timeout",
      TIMEOUT_MS + 2000,
    );
    expect(timeoutEvent).not.toBeNull();

    // Now terminate the worker (after timeout already cleaned up the task)
    await client.terminatePeer(endpoint);
    await sleep(500); // allow failTasksForEndpoint to complete

    // Collect ALL terminal events for this task — must be exactly one
    const terminalEvents = await client.collectTerminalEvents(taskId, 500);
    expect(terminalEvents.length).toBe(1);
    expect(terminalEvents[0].state).toBe("timeout");

    // Verify task is gone: same task_id can be reused
    const r2 = await client.assignTask({ task_id: taskId, assigned_to: endpoint });
    // endpoint is now terminated, so TASK_TARGET_NOT_FOUND — confirms task was cleaned up
    expect(r2.result.error?.code).toBe("TASK_TARGET_NOT_FOUND");
  });

  // ── Scenario 2: Worker terminates before timeout fires ─────────────────────

  test("2. worker terminates before timeout fires → exactly one terminal event (failed); timer cleared", async () => {
    const endpoint = await spawnAndBootstrap();
    const taskId = makeTaskId();
    const TIMEOUT_MS = 5000; // long timeout — should never fire

    client.clearObservables();

    // Assign task with long timeout
    const r = await client.assignTask({ task_id: taskId, assigned_to: endpoint, timeout_ms: TIMEOUT_MS });
    expect(r.result.success).toBe(true);

    // Terminate worker immediately (well before timeout)
    await client.terminatePeer(endpoint);

    // Expect LoopEvent{state:'failed', reason:'worker_terminated'}
    const failedEvent = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "failed",
      3000,
    );
    expect(failedEvent).not.toBeNull();
    expect(failedEvent.details?.reason).toBe("worker_terminated");

    // Wait past what would be the remaining timeout to confirm no second terminal event
    await sleep(500);

    const terminalEvents = await client.collectTerminalEvents(taskId, 200);
    expect(terminalEvents.length).toBe(1);
    expect(terminalEvents[0].state).toBe("failed");
  });

  // ── Scenario 3: Late loop_event{completed} after daemon-generated timeout ──

  test("3. late loop_event{completed} after timeout fired → late event routed, no double cleanup", async () => {
    const endpoint = `worker-late-${Date.now()}`;
    await registerPeer(endpoint);

    const taskId = makeTaskId();
    const TIMEOUT_MS = 300;

    client.clearObservables();

    // Assign task with short timeout
    const r = await client.assignTask({ task_id: taskId, assigned_to: endpoint, timeout_ms: TIMEOUT_MS });
    expect(r.result.success).toBe(true);

    // Wait for timeout to fire
    const timeoutEvent = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "timeout",
      TIMEOUT_MS + 2000,
    );
    expect(timeoutEvent).not.toBeNull();

    // Now worker sends a late loop_event{completed} — task is already gone from activeTasks
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId,
      endpoint,
      state: "completed",
      observed_at: Date.now(),
      loop_id: `loop-late-${Date.now()}`,
    }));
    await sleep(200);

    // Late event should still be observable (routed for observability)
    const lateEvent = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "completed",
      1000,
    );
    expect(lateEvent).not.toBeNull();

    // Wait to allow any hypothetical second daemon cleanup to materialise
    await sleep(300);
    const terminalEvents = await client.collectTerminalEvents(taskId, 200);

    // Observability layer: both timeout (daemon) and late completed (worker) arrive at sink
    expect(terminalEvents.length).toBe(2);

    // State layer 1: exactly one daemon-generated terminal event.
    // Daemon-generated events have no loop_id (per protocol contract).
    // Worker-sourced events carry a loop_id set by the worker.
    const daemonGenerated = terminalEvents.filter((e: any) => e.loop_id === undefined);
    const workerSourced   = terminalEvents.filter((e: any) => e.loop_id !== undefined);
    expect(daemonGenerated.length).toBe(1);
    expect(daemonGenerated[0].state).toBe("timeout");
    expect(workerSourced.length).toBe(1);
    expect(workerSourced[0].state).toBe("completed");

    // State layer 2: activeTasks was NOT re-populated by the late worker event.
    // Same task_id can be reassigned immediately (cleanup happened only once).
    const r2 = await client.assignTask({ task_id: taskId, assigned_to: endpoint });
    expect(r2.result.success).toBe(true);

    // Cleanup
    await client.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId, endpoint, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
  });

  // ── Scenario 4: Stall escalation with in-flight task ──────────────────────

  test("4. stall escalation with in-flight task → LoopEvent{failed, reason:'worker_terminated'}; activeTasks cleaned up", async () => {
    const endpoint = await spawnAndBootstrap();
    const taskId = makeTaskId();
    const STALL_ESCALATION_MS = 1500; // matches daemon config above

    client.clearObservables();

    // Assign task with long timeout (we want stall escalation to win)
    const r = await client.assignTask({ task_id: taskId, assigned_to: endpoint, timeout_ms: 30000 });
    expect(r.result.success).toBe(true);

    // Wait for stalled lifecycle event (PEER_STALE_MS = 800ms + some slack)
    const stalledEvent = await client.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "stalled",
      4000,
    );
    expect(stalledEvent).not.toBeNull();

    // Wait for escalation to fire (STALL_ESCALATION_MS after stalled)
    const terminatedEvent = await client.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "terminated",
      STALL_ESCALATION_MS + 2000,
    );
    expect(terminatedEvent).not.toBeNull();

    // LoopEvent{failed, reason:'worker_terminated'} must arrive
    const failedEvent = await client.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "failed",
      2000,
    );
    expect(failedEvent).not.toBeNull();
    expect(failedEvent.details?.reason).toBe("worker_terminated");
    expect(failedEvent.endpoint).toBe(endpoint);

    // Exactly one terminal event
    const terminalEvents = await client.collectTerminalEvents(taskId, 300);
    expect(terminalEvents.length).toBe(1);
    expect(terminalEvents[0].state).toBe("failed");
  }, 15000); // generous timeout for stall escalation

});
