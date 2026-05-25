/**
 * Phase 4C-1 Integration Tests — Direct Worker-WS Delivery
 *
 * Exercises the worker_connect declaration and direct relay path:
 *   1. Spawned worker (via launch_peer) → assign_task relay arrives on worker WS, NOT via supervisor observable
 *   2. Duplicate worker_connect same socket → idempotent success
 *   3. Duplicate worker_connect different live socket → rejected SUPERVISOR_ALREADY_ATTACHED
 *   4. Worker WS closes → evicted; assign_task relay falls back to emitObservable (supervisor sees it)
 *   5. Simulated worker (no worker_connect) → fallback emitObservable (Phase 3B compat preserved)
 *   6. worker_connect for unknown endpoint → ENDPOINT_NOT_FOUND
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const CHILD_PATH = new URL("./test-peer-child.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase4c-test";
const ROOM = "test-phase4c";
const COORDINATOR = "coord-4C";

const PORT = 36000 + Math.floor(Math.random() * 3000);
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
    message_id: `t4c_${++msgCounter}_${Date.now()}`,
    from,
    sent_at: Date.now(),
    kind,
    intent,
    payload,
    ...opts,
  };
}

function makeTaskId() {
  return `task-4c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Coordinator (supervisor) client ──────────────────────────────────────────

class CoordinatorClient {
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
    const requestId = `rc4_${++this.reqId}`;
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

  launchPeer(role: string) {
    return this.req<{ type: "launch_peer_result"; result: { success: boolean; endpoint?: string; error?: { code: string } } }>({
      type: "launch_peer",
      request: { role, coordinator: COORDINATOR },
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

// ── Worker client (simulates a peer's own dedicated WS for direct delivery) ──

class WorkerClient {
  private ws!: WebSocket;
  private reqId = 0;
  readonly received: { raw: string; parsed: unknown }[] = [];
  private resolvers = new Map<string, (v: any) => void>();

  async connect(port: number) {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`Worker WS connect failed on port ${port}`));
      this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
    });
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
    const requestId = `rw4_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  workerConnect(endpoint: string) {
    return this.req<{ type: "worker_connect_result"; success: boolean; error?: { code: string; message: string } }>({
      type: "worker_connect",
      endpoint,
    });
  }

  postEnvelope(envelope: MessageEnvelope) {
    return this.req<{ type: "post_envelope_result"; success: boolean }>({
      type: "post_envelope",
      envelope,
    });
  }

  async waitForReceived(predicate: (p: any) => boolean, timeoutMs = 5000): Promise<any> {
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

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let coordinator: CoordinatorClient;

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(`/tmp/cc-bridge-phase4c-${PORT}.pid`, { force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase4c-${PORT}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase4c-${PORT}.log`,
      CC_BRIDGE_ROOM: ROOM,
      CC_BRIDGE_ENDPOINT: COORDINATOR,
      CC_BRIDGE_STATE_DIR: STATE_DIR,
      CC_BRIDGE_HEARTBEAT_MS: "300",
      CC_BRIDGE_PEER_STALE_MS: "800",
      CC_BRIDGE_POLL_INTERVAL_MS: "200",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: "3000",
      CC_BRIDGE_STALL_ESCALATION_MS: "2000",
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

  coordinator = new CoordinatorClient();
  await coordinator.connect(PORT);
  await coordinator.supervisorAttach(COORDINATOR);
});

afterAll(async () => {
  coordinator?.close();
  proc?.kill();
  await sleep(200);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Spawn a peer via launch_peer (pre-allocates endpoint + spawns child),
 * wait for the child to bootstrap. The spawned child (test-peer-child.ts)
 * calls worker_connect itself before register, so direct delivery is active.
 */
async function spawnAndBootstrap(): Promise<string> {
  const r = await coordinator.launchPeer("4CWorker");
  expect(r.result.success).toBe(true);
  const endpoint = r.result.endpoint!;

  const ack = await coordinator.waitForObservable(
    (p) => p?.endpoint === endpoint && (p?.status === "acked" || p?.status === "bootstrapped"),
    6000,
  );
  expect(ack).not.toBeNull();
  return endpoint;
}

/**
 * Pre-register a simulated endpoint in peerRegistry (without spawning a real process).
 * Uses a WorkerClient WS to post the register envelope so the WS is separately controllable.
 * Returns the WorkerClient (caller should close it when done).
 */
async function registerSimulatedWorker(endpoint: string): Promise<WorkerClient> {
  const workerWs = new WorkerClient();
  await workerWs.connect(PORT);
  await workerWs.postEnvelope(makeEnvelope(endpoint, "control", "register", { endpoint, role: "SimWorker" }));
  // Wait for lifecycle_ack connected at coordinator
  await coordinator.waitForObservable(
    (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "connected",
    3000,
  );
  return workerWs;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 4C-1 — Direct Worker-WS Delivery", () => {

  // ── 1: spawned worker → relay arrives via direct delivery, NOT via supervisor ─

  test("1. spawned worker (worker_connect declared) → assign_task relay NOT visible at supervisor (direct delivery)", async () => {
    // test-peer-child.ts calls worker_connect before register, so its socket is registered
    const endpoint = await spawnAndBootstrap();

    coordinator.clearObservables();

    // Assign task to the spawned worker
    const taskId = makeTaskId();
    const r = await coordinator.assignTask({ task_id: taskId, assigned_to: endpoint });
    expect(r.result.success).toBe(true);

    // Wait briefly to let any supervisor-path delivery land
    await sleep(400);

    // Direct delivery: coordinator must NOT receive the task_assignment relay via codex_to_claude
    const supervisorRelay = coordinator.observables.find(
      (o) => (o.parsed as any)?.intent === "task_assignment" && (o.parsed as any)?.payload?.task_id === taskId,
    );
    expect(supervisorRelay).toBeUndefined();

    // Cleanup: send loop_event completed to clear activeTasks
    await coordinator.postEnvelope(makeEnvelope(endpoint, "control", "loop_event", {
      task_id: taskId, endpoint, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
  });

  // ── 2: duplicate worker_connect same socket → idempotent success ─────────────

  test("2. duplicate worker_connect on same socket → idempotent success", async () => {
    const ep = `worker-idem-${Date.now()}`;
    // Register endpoint in peerRegistry via simulated register
    const workerWs = await registerSimulatedWorker(ep);

    // First worker_connect
    const r1 = await workerWs.workerConnect(ep);
    expect(r1.success).toBe(true);

    // Second worker_connect — same socket, same endpoint → idempotent success
    const r2 = await workerWs.workerConnect(ep);
    expect(r2.success).toBe(true);

    workerWs.close();
  });

  // ── 3: duplicate worker_connect different socket → rejected ───────────────────

  test("3. second worker_connect for same endpoint from different live socket → SUPERVISOR_ALREADY_ATTACHED", async () => {
    const ep = `worker-dup-${Date.now()}`;
    const worker1 = await registerSimulatedWorker(ep);

    // First WS binds successfully
    const r1 = await worker1.workerConnect(ep);
    expect(r1.success).toBe(true);

    // Second WS tries to claim the same endpoint while first is still open
    const worker2 = new WorkerClient();
    await worker2.connect(PORT);
    const r2 = await worker2.workerConnect(ep);
    expect(r2.success).toBe(false);
    expect(r2.error?.code).toBe("SUPERVISOR_ALREADY_ATTACHED");

    worker1.close();
    worker2.close();
  });

  // ── 4: worker WS closes → evicted; assign_task falls back to supervisor ────────

  test("4. worker WS closes → socket evicted; assign_task relay falls back to emitObservable (coordinator sees it)", async () => {
    const ep = `worker-close-${Date.now()}`;
    const workerWs = await registerSimulatedWorker(ep);

    // Bind worker socket
    const wcR = await workerWs.workerConnect(ep);
    expect(wcR.success).toBe(true);

    // Also send bootstrap_ack so the peer is fully bootstrapped (not stale)
    await workerWs.postEnvelope(makeEnvelope(ep, "control", "bootstrap_ack", {}));
    await sleep(100);

    // Close the worker WS — daemon evicts from workerSockets
    workerWs.close();
    await sleep(300); // let close propagate

    coordinator.clearObservables();

    // assign_task — workerSockets has no entry → emitObservable fallback path
    const taskId = makeTaskId();
    const r = await coordinator.assignTask({ task_id: taskId, assigned_to: ep });
    expect(r.result.success).toBe(true);

    // Coordinator (supervisor) should receive relay via fallback observable path
    const observable = await coordinator.waitForObservable(
      (p) => p?.intent === "task_assignment" && p?.payload?.task_id === taskId,
      3000,
    );
    expect(observable).not.toBeNull();
    expect(observable.payload.task_id).toBe(taskId);

    // Cleanup
    await coordinator.postEnvelope(makeEnvelope(ep, "control", "loop_event", {
      task_id: taskId, endpoint: ep, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
  });

  // ── 5: simulated worker (no worker_connect) → Phase 3B compat path ────────────

  test("5. simulated worker (no worker_connect) → assign_task relay via emitObservable (Phase 3B compat)", async () => {
    const ep = `sim-worker-${Date.now()}`;
    const workerWs = await registerSimulatedWorker(ep);
    // No worker_connect call — workerSockets has no entry for ep

    coordinator.clearObservables();

    const taskId = makeTaskId();
    const r = await coordinator.assignTask({ task_id: taskId, assigned_to: ep });
    expect(r.result.success).toBe(true);

    // No worker_connect → relay goes via supervisor observable path (Phase 3B)
    const observable = await coordinator.waitForObservable(
      (p) => p?.intent === "task_assignment" && p?.payload?.task_id === taskId,
      3000,
    );
    expect(observable).not.toBeNull();
    expect(observable.payload.task_id).toBe(taskId);

    // Cleanup
    await coordinator.postEnvelope(makeEnvelope(ep, "control", "loop_event", {
      task_id: taskId, endpoint: ep, state: "completed", observed_at: Date.now(),
    }));
    await sleep(100);
    workerWs.close();
  });

  // ── 6: worker_connect for unknown endpoint → ENDPOINT_NOT_FOUND ──────────────

  test("6. worker_connect for unknown endpoint → ENDPOINT_NOT_FOUND", async () => {
    const worker = new WorkerClient();
    await worker.connect(PORT);

    const r = await worker.workerConnect("endpoint-that-does-not-exist");
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("ENDPOINT_NOT_FOUND");

    worker.close();
  });

});
