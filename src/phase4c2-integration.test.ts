/**
 * Phase 4C-2 Integration Tests — Task Hand-off on Legacy Supervisor Disconnect
 *
 * Verifies that when the legacy supervisor (supervisor_attach without partition_id)
 * disconnects, all tasks it owns (partition_id === undefined) are failed immediately
 * with LoopEvent{state:'failed', details:{reason:'coordinator_disconnected'}}.
 *
 * Partition-owned tasks must NOT be affected.
 *
 * Constraint: the one-coordinator-per-room invariant (Phase 4A) means each new WS that
 * sends claude_connect replaces the previous coordinator. Tests are designed around this:
 * each test uses a fresh coordinator WS; successive tests reconnect.
 *
 * Scenarios:
 *   1. Explicit supervisor_detach → legacy tasks failed immediately (event on departing WS)
 *   2. Supervisor socket close → legacy tasks buffered in supervisorBuffer; next attach receives them
 *   3. Single-coordinator holds both legacy supervisor + named partition:
 *      legacy-detach fails ONLY legacy tasks; partition tasks survive until explicit partition release
 *   4. Room with no in-flight tasks: supervisor detach is a clean no-op
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase4c2-test";
const ROOM = "test-phase4c2";
const COORDINATOR = "coord-4C2";

const PORT = 37000 + Math.floor(Math.random() * 3000);
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
    message_id: `t4c2_${++msgCounter}_${Date.now()}`,
    from,
    sent_at: Date.now(),
    kind,
    intent,
    payload,
    ...opts,
  };
}

function makeTaskId() {
  return `task-4c2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Test client ───────────────────────────────────────────────────────────────

class Phase4C2Client {
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
    // Join room (claude_connect replaces existing coordinator — Phase 4A invariant)
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
    const requestId = `rc2_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  supervisorAttach(endpoint: string, partitionId?: string) {
    return this.req<{ success: boolean; error?: { code: string } }>({
      type: "supervisor_attach",
      endpoint,
      ...(partitionId !== undefined ? { partition_id: partitionId } : {}),
    });
  }

  supervisorDetach(partitionId?: string) {
    return this.req<{ success: boolean }>({
      type: "supervisor_detach",
      ...(partitionId !== undefined ? { partition_id: partitionId } : {}),
    });
  }

  assignTask(assignment: { task_id: string; assigned_to: string; payload?: unknown; timeout_ms?: number }) {
    return this.req<{ type: "assign_task_result"; result: { success: boolean; task_id: string; error?: { code: string } } }>({
      type: "assign_task",
      assignment: { ...assignment, payload: assignment.payload ?? {} },
    });
  }

  bindWorker(partitionId: string, endpoint: string) {
    return this.req<{ type: "bind_worker_result"; result: { success: boolean; error?: { code: string } } }>({
      type: "bind_worker",
      partition_id: partitionId,
      endpoint,
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
  rmSync(`/tmp/cc-bridge-phase4c2-${PORT}.pid`, { force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase4c2-${PORT}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase4c2-${PORT}.log`,
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
});

afterAll(async () => {
  proc?.kill();
  await sleep(200);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Register a simulated worker in peerRegistry via coordinator post_envelope. */
async function registerWorker(client: Phase4C2Client, endpoint: string): Promise<void> {
  await client.postEnvelope(makeEnvelope(endpoint, "control", "register", { endpoint, role: "Worker" }));
  await client.waitForObservable(
    (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "connected",
    3000,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 4C-2 — Task Hand-off on Legacy Supervisor Disconnect", () => {

  // ── 1: explicit supervisor_detach → legacy tasks failed immediately ───────────

  test("1. explicit supervisor_detach (no partition_id) → in-flight legacy tasks failed with coordinator_disconnected", async () => {
    const coord = new Phase4C2Client();
    await coord.connect(PORT);
    await coord.supervisorAttach(COORDINATOR);

    const ep = `w-detach-${Date.now()}`;
    await registerWorker(coord, ep);

    const taskId = makeTaskId();
    const r = await coord.assignTask({ task_id: taskId, assigned_to: ep, timeout_ms: 30000 });
    expect(r.result.success).toBe(true);

    coord.clearObservables();

    // Explicit detach — socket still open; emitLoopEvent delivers to coord's own WS
    const detachR = await coord.supervisorDetach();
    expect(detachR.success).toBe(true);

    const failedEvent = await coord.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "failed",
      3000,
    );
    expect(failedEvent).not.toBeNull();
    expect(failedEvent.details?.reason).toBe("coordinator_disconnected");
    expect(failedEvent.endpoint).toBe(ep);

    // Task must be gone: same task_id is immediately reusable
    const r2 = await coord.supervisorAttach(COORDINATOR);
    expect(r2.success).toBe(true);
    const r3 = await coord.assignTask({ task_id: taskId, assigned_to: ep, timeout_ms: 30000 });
    expect(r3.result.success).toBe(true);

    // Cleanup
    await coord.postEnvelope(makeEnvelope(ep, "control", "loop_event", {
      task_id: taskId, endpoint: ep, state: "completed", observed_at: Date.now(),
    }));
    await coord.supervisorDetach();
    await sleep(100);
    coord.close();
  });

  // ── 2: supervisor socket close → events buffered, flushed to next supervisor ──

  test("2. supervisor socket close → failed events buffered in supervisorBuffer; next attach receives them", async () => {
    const coord1 = new Phase4C2Client();
    await coord1.connect(PORT);
    await coord1.supervisorAttach(COORDINATOR);

    const ep = `w-close-${Date.now()}`;
    await registerWorker(coord1, ep);

    const taskId = makeTaskId();
    const r = await coord1.assignTask({ task_id: taskId, assigned_to: ep, timeout_ms: 30000 });
    expect(r.result.success).toBe(true);

    // Close socket — daemon nulls supervisorSocket first, buffers failed event in supervisorBuffer
    coord1.close();
    await sleep(300);

    // coord2 connects and attaches as supervisor — buffered events are flushed on attach
    const coord2 = new Phase4C2Client();
    await coord2.connect(PORT); // replaces coord1 as room coordinator
    coord2.clearObservables();  // clear any flush that happened before attach
    await coord2.supervisorAttach(COORDINATOR); // ← supervisorBuffer flushed HERE

    // The failed task event should arrive as part of the flush
    const failedEvent = await coord2.waitForObservable(
      (p) => p?.task_id === taskId && p?.state === "failed",
      3000,
    );
    expect(failedEvent).not.toBeNull();
    expect(failedEvent.details?.reason).toBe("coordinator_disconnected");
    expect(failedEvent.endpoint).toBe(ep);

    coord2.close();
  });

  // ── 3: single coordinator with both legacy + partition roles ──────────────────

  test("3. legacy supervisor detach does NOT fail partition-owned tasks (partition_id filter)", async () => {
    // A single coordinator holds BOTH the legacy supervisor slot AND a named partition.
    // Since partitions.size must be 0 at legacy-task assign time (Phase 4B gate),
    // we assign the legacy task FIRST, then claim the partition and assign the partition task.
    const coord = new Phase4C2Client();
    await coord.connect(PORT);
    await coord.supervisorAttach(COORDINATOR); // legacy supervisor

    const epLegacy = `w-leg-${Date.now()}`;
    const epPart = `w-part-${Date.now()}`;
    await registerWorker(coord, epLegacy);
    await registerWorker(coord, epPart);

    // Step 1: assign legacy task (partitions.size === 0 → allowed; task.partition_id = undefined)
    const legacyTaskId = makeTaskId();
    const r1 = await coord.assignTask({ task_id: legacyTaskId, assigned_to: epLegacy, timeout_ms: 30000 });
    expect(r1.result.success).toBe(true);

    // Step 2: claim named partition and bind epPart
    const partitionId = `part-${Date.now()}`;
    const partAttach = await coord.supervisorAttach(COORDINATOR, partitionId);
    expect(partAttach.success).toBe(true);
    const bindR = await coord.bindWorker(partitionId, epPart);
    expect(bindR.result.success).toBe(true);

    // Step 3: assign partition-owned task (partitions.size > 0, coord holds it → task.partition_id set)
    const partTaskId = makeTaskId();
    const r2 = await coord.assignTask({ task_id: partTaskId, assigned_to: epPart, timeout_ms: 30000 });
    expect(r2.result.success).toBe(true);

    coord.clearObservables();

    // Step 4: detach legacy supervisor only (no partition_id)
    const detachR = await coord.supervisorDetach();
    expect(detachR.success).toBe(true);

    await sleep(300);

    // Legacy task must have failed
    const legacyFailed = coord.observables.find(
      (o) => (o.parsed as any)?.task_id === legacyTaskId && (o.parsed as any)?.state === "failed",
    );
    expect(legacyFailed).toBeDefined();
    expect((legacyFailed!.parsed as any).details?.reason).toBe("coordinator_disconnected");

    // Partition task must NOT have failed (partition_id filter)
    const partFailed = coord.observables.find(
      (o) => (o.parsed as any)?.task_id === partTaskId && (o.parsed as any)?.state === "failed",
    );
    expect(partFailed).toBeUndefined();

    // Cleanup: explicitly release partition (fails partition task via releasePartition)
    await coord.supervisorDetach(partitionId);
    await sleep(100);
    coord.close();
  });

  // ── 4: no in-flight tasks → supervisor detach is a clean no-op ───────────────

  test("4. supervisor_detach with no in-flight legacy tasks → clean no-op, no spurious events", async () => {
    const coord = new Phase4C2Client();
    await coord.connect(PORT);
    await coord.supervisorAttach(COORDINATOR);

    coord.clearObservables();

    const detachR = await coord.supervisorDetach();
    expect(detachR.success).toBe(true);

    await sleep(300);

    // No failed events should appear
    const failedEvents = coord.observables.filter(
      (o) => (o.parsed as any)?.state === "failed",
    );
    expect(failedEvents.length).toBe(0);

    coord.close();
  });

});
