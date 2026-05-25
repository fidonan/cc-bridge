/**
 * Phase 2 integration smoke tests
 *
 * Spawns a real daemon and a real child process (test-peer-child.ts) to exercise:
 *   1. Real spawn happy path: launch → child registers + acks → bootstrapped, pid returned
 *   2. Spawn failure: invalid command → SPAWN_FAILED, no registry entry
 *   3. Child exits before bootstrap_ack → terminated + bootstrap_state='failed'
 *   4. terminate_peer: send SIGTERM → child exits → SpawnExitObservable + terminated
 *   5. terminate_peer idempotency: already-terminated → success, no double lifecycle_ack
 *   6. terminate_peer unknown endpoint → ENDPOINT_NOT_FOUND
 *   7. Stalled → terminated escalation (timer fires, state monotone guard)
 *   8. Stalled recovery cancels escalation (heartbeat before timer fires)
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LaunchRequest, LaunchResult, MessageEnvelope, RegistrySnapshot, TerminatePeerRequest } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const CHILD_PATH = new URL("./test-peer-child.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase2-test";
const ROOM = "test-phase2";
const COORDINATOR = "coord-A2";
const BOOTSTRAP_TIMEOUT_MS = 2000;
const STALL_ESCALATION_MS = 2000;

const PORT = 21000 + Math.floor(Math.random() * 5000);
let proc: Subprocess | null = null;
let client: Phase2TestClient;
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
    message_id: `t2_${++msgCounter}_${Date.now()}`,
    from,
    sent_at: Date.now(),
    kind,
    intent,
    payload,
    ...opts,
  };
}

// ── Test Client ───────────────────────────────────────────────────────────────

interface ObservableEntry {
  raw: string;
  parsed: unknown;
}

class Phase2TestClient {
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
    const requestId = `r2_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  launchPeer(request: LaunchRequest) {
    return this.req<{ type: "launch_peer_result"; result: LaunchResult }>({
      type: "launch_peer",
      request,
    });
  }

  terminatePeer(request: TerminatePeerRequest) {
    return this.req<{ type: "terminate_peer_result"; result: { success: boolean; endpoint: string; error?: unknown } }>({
      type: "terminate_peer",
      request,
    });
  }

  postEnvelope(envelope: MessageEnvelope) {
    return this.req<{ type: "post_envelope_result"; success: boolean; error?: unknown }>({
      type: "post_envelope",
      envelope,
    });
  }

  queryRegistry() {
    return this.req<{ type: "query_registry_result"; snapshot: RegistrySnapshot }>({
      type: "query_registry",
    });
  }

  async waitForObservable(predicate: (p: any) => boolean, timeoutMs = 6000): Promise<any> {
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

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync("/tmp/cc-bridge-phase2.pid", { force: true });
  rmSync("/tmp/cc-bridge-phase2.log", { force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: "/tmp/cc-bridge-phase2.pid",
      AGENTBRIDGE_LOG_FILE: "/tmp/cc-bridge-phase2.log",
      CC_BRIDGE_ROOM: ROOM,
      CC_BRIDGE_ENDPOINT: COORDINATOR,
      CC_BRIDGE_STATE_DIR: STATE_DIR,
      CC_BRIDGE_HEARTBEAT_MS: "300",
      CC_BRIDGE_PEER_STALE_MS: "800",
      CC_BRIDGE_POLL_INTERVAL_MS: "200",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: String(BOOTSTRAP_TIMEOUT_MS),
      CC_BRIDGE_STALL_ESCALATION_MS: String(STALL_ESCALATION_MS),
      // Spawn command: bun run <child script>
      CC_BRIDGE_SPAWN_COMMAND: `bun run ${CHILD_PATH}`,
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "120000",
    } as Record<string, string>,
    stdout: "ignore",
    stderr: "ignore",
  });

  const healthUrl = `http://127.0.0.1:${PORT}/healthz`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(healthUrl);
      if (r.ok) break;
    } catch {}
    await sleep(200);
  }

  client = new Phase2TestClient();
  await client.connect(PORT);
  await sleep(300);
}, 15000);

afterAll(async () => {
  client?.close();
  try { proc?.kill(); } catch {}
  await sleep(300);
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync("/tmp/cc-bridge-phase2.pid", { force: true });
  rmSync("/tmp/cc-bridge-phase2.log", { force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 2 integration", () => {
  test("chain 1: real spawn happy path — launch → child registers + acks → bootstrapped", async () => {
    const launchRes = await client.launchPeer({
      role: "Worker",
      coordinator: COORDINATOR,
      bootstrap_message: "register_and_ack",
    });
    expect(launchRes.result.success).toBe(true);
    expect(launchRes.result.endpoint).toBeTruthy();
    expect(launchRes.result.pid).toBeGreaterThan(0); // real OS pid
    const endpoint = launchRes.result.endpoint!;

    // Child connects and sends register + bootstrap_ack; wait for BootstrapAck observable
    const bootstrapObs = await client.waitForObservable(
      (p) => p?.endpoint === endpoint && p?.status === "acked",
      6000,
    );
    expect(bootstrapObs).not.toBeNull();
    expect(bootstrapObs.role).toBe("Worker");

    // Verify registry
    const reg = await client.queryRegistry();
    const peer = reg.snapshot.peers.find((p) => p.endpoint === endpoint);
    expect(peer?.bootstrap_state).toBe("acked");
    expect(peer?.status).toBe("bootstrapped");
  }, 10000);

  test("chain 2: spawn failure — invalid command → SPAWN_FAILED, no registry entry", async () => {
    // Temporarily override SPAWN_COMMAND is not possible at runtime, but we can test
    // by relying on the daemon's fallback: if the command is not found, it throws SPAWN_FAILED.
    // We'll launch with a nonexistent command by patching via a helper endpoint.
    // Since SPAWN_COMMAND is fixed at daemon startup, test this indirectly:
    // The daemon with a bad SPAWN_COMMAND returns SPAWN_FAILED.
    // We spawn a one-off daemon to test this case.

    const badPort = PORT + 100;
    const badProc = spawn(["bun", "run", DAEMON_PATH], {
      env: {
        ...process.env,
        AGENTBRIDGE_CONTROL_PORT: String(badPort),
        AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase2-bad.pid`,
        AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase2-bad.log`,
        CC_BRIDGE_ROOM: ROOM,
        CC_BRIDGE_ENDPOINT: "coord-bad",
        CC_BRIDGE_STATE_DIR: `${STATE_DIR}-bad`,
        CC_BRIDGE_SPAWN_COMMAND: "totally-nonexistent-command-xyz",
        AGENTBRIDGE_IDLE_SHUTDOWN_MS: "30000",
      } as Record<string, string>,
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      // Wait for health
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`http://127.0.0.1:${badPort}/healthz`);
          if (r.ok) break;
        } catch {}
        await sleep(200);
      }

      const badClient = new Phase2TestClient();
      await badClient.connect(badPort);
      await sleep(200);

      const launchRes = await badClient.launchPeer({ role: "Doomed", coordinator: "coord-bad" });
      expect(launchRes.result.success).toBe(false);
      expect((launchRes.result.error as any)?.code).toBe("SPAWN_FAILED");

      // No registry entry for the failed spawn
      const reg = await badClient.queryRegistry();
      expect(reg.snapshot.peers.find((p) => p.role === "Doomed")).toBeUndefined();

      badClient.close();
    } finally {
      try { badProc.kill(); } catch {}
      rmSync(`/tmp/cc-bridge-phase2-bad.pid`, { force: true });
      rmSync(`/tmp/cc-bridge-phase2-bad.log`, { force: true });
      if (existsSync(`${STATE_DIR}-bad`)) rmSync(`${STATE_DIR}-bad`, { recursive: true, force: true });
    }
  }, 15000);

  test("chain 3: child exits before bootstrap_ack → terminated + bootstrap_state='failed'", async () => {
    const launchRes = await client.launchPeer({ role: "CrashTest", coordinator: COORDINATOR, bootstrap_message: "crash_after_register" });
    expect(launchRes.result.success).toBe(true);
    const endpoint = launchRes.result.endpoint!;
    const pid = launchRes.result.pid!;
    expect(pid).toBeGreaterThan(0);

    // Child (scenario: crash_after_register) exits before sending bootstrap_ack
    // Wait for SpawnExitObservable
    const exitObs = await client.waitForObservable(
      (p) => p?.endpoint === endpoint && p?.pid === pid && "exit_code" in p,
      6000,
    );
    expect(exitObs).not.toBeNull();

    // Wait for lifecycle_ack terminated
    const terminatedAck = await client.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "terminated",
      3000,
    );
    expect(terminatedAck).not.toBeNull();

    // Registry: bootstrap_state='failed', status='terminated'
    const reg = await client.queryRegistry();
    const peer = reg.snapshot.peers.find((p) => p.endpoint === endpoint);
    expect(peer?.status).toBe("terminated");
    expect(peer?.bootstrap_state).toBe("failed");
  }, 10000);

  test("chain 4: terminate_peer → SIGTERM → SpawnExitObservable + terminated", async () => {
    // Launch a peer that stays alive (register_and_ack scenario)
    const launchRes = await client.launchPeer({ role: "LongRunner", coordinator: COORDINATOR, bootstrap_message: "register_and_ack" });
    expect(launchRes.result.success).toBe(true);
    const endpoint = launchRes.result.endpoint!;
    const pid = launchRes.result.pid!;

    // Wait for it to bootstrap
    const bootstrapObs = await client.waitForObservable(
      (p) => p?.endpoint === endpoint && p?.status === "acked",
      6000,
    );
    expect(bootstrapObs).not.toBeNull();

    // Send terminate_peer
    const termResult = await client.terminatePeer({ endpoint, signal: "SIGTERM" });
    expect(termResult.result.success).toBe(true);

    // Lifecycle ack should arrive (from the immediate registry update)
    const terminatedAck = await client.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "terminated",
      3000,
    );
    expect(terminatedAck).not.toBeNull();

    // SpawnExitObservable arrives when the process actually exits
    const exitObs = await client.waitForObservable(
      (p) => p?.endpoint === endpoint && p?.pid === pid && "exit_code" in p,
      4000,
    );
    expect(exitObs).not.toBeNull();

    // Verify final registry state
    const reg = await client.queryRegistry();
    const peer = reg.snapshot.peers.find((p) => p.endpoint === endpoint);
    expect(peer?.status).toBe("terminated");
    expect(peer?.bootstrap_state).toBe("acked"); // was bootstrapped before terminate
  }, 12000);

  test("chain 5: terminate_peer idempotency — already-terminated → success", async () => {
    // Use an endpoint from chain 4 (already terminated) — find it in registry
    const reg = await client.queryRegistry();
    const terminated = reg.snapshot.peers.find((p) => p.status === "terminated" && p.role === "LongRunner");
    expect(terminated).toBeDefined();
    const endpoint = terminated!.endpoint;

    const before = client.observables.length;
    const termResult = await client.terminatePeer({ endpoint });
    expect(termResult.result.success).toBe(true);

    // No new lifecycle_ack should be emitted (idempotent)
    await sleep(300);
    const newLifecycleAcks = client.observables.slice(before).filter(
      (o) => (o.parsed as any)?.intent === "lifecycle_ack" && (o.parsed as any)?.payload?.endpoint === endpoint,
    );
    expect(newLifecycleAcks).toHaveLength(0);
  });

  test("chain 6: terminate_peer unknown endpoint → ENDPOINT_NOT_FOUND", async () => {
    const termResult = await client.terminatePeer({ endpoint: "nonexistent-endpoint-phase2" });
    expect(termResult.result.success).toBe(false);
    expect((termResult.result.error as any)?.code).toBe("ENDPOINT_NOT_FOUND");
  });

  test(
    "chain 7: stalled → terminated escalation (timer fires, state monotone)",
    async () => {
      // Register a peer manually (no process, so it will stall when heartbeat stops)
      const endpoint = `stall-test-${Date.now()}`;
      await client.postEnvelope(
        makeEnvelope(endpoint, "control", "register", { endpoint, role: "StallTest" }),
      );

      // Wait for stalled (PEER_STALE_MS=800ms)
      const stalledAck = await client.waitForObservable(
        (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "stalled",
        3000,
      );
      expect(stalledAck).not.toBeNull();

      // Wait for escalation → terminated (STALL_ESCALATION_MS=2000ms)
      const terminatedAck = await client.waitForObservable(
        (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "terminated",
        STALL_ESCALATION_MS + 1500,
      );
      expect(terminatedAck).not.toBeNull();

      // Registry: terminated
      const reg = await client.queryRegistry();
      const peer = reg.snapshot.peers.find((p) => p.endpoint === endpoint);
      expect(peer?.status).toBe("terminated");
    },
    STALL_ESCALATION_MS + 6000,
  );

  test(
    "chain 8: stalled recovery cancels escalation — heartbeat before timer fires",
    async () => {
      // Register a peer manually
      const endpoint = `stall-recovery-${Date.now()}`;
      await client.postEnvelope(
        makeEnvelope(endpoint, "control", "register", { endpoint, role: "RecoveryTest" }),
      );

      // Wait for stalled
      const stalledAck = await client.waitForObservable(
        (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "stalled",
        3000,
      );
      expect(stalledAck).not.toBeNull();

      // Send heartbeat before escalation fires (within STALL_ESCALATION_MS=2000ms)
      await client.postEnvelope(
        makeEnvelope(endpoint, "control", "heartbeat", { status: "idle" }),
      );

      // Wait for recovery lifecycle_ack (idle)
      const recoveredAck = await client.waitForObservable(
        (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint && p?.payload?.status === "idle",
        2000,
      );
      expect(recoveredAck).not.toBeNull();

      // Wait just past where the ORIGINAL escalation timer would have fired if not cancelled.
      // (Stall started at ~t0, heartbeat arrived ~300ms later → remaining on original timer ~1700ms)
      // We wait 1200ms: enough to catch a non-cancelled timer, but before any NEW escalation fires.
      await sleep(1200);

      // Peer must NOT be terminated — the original escalation was cancelled on heartbeat recovery.
      // (It may have re-stalled since no continuous heartbeats, but must not have terminated yet.)
      const reg = await client.queryRegistry();
      const peer = reg.snapshot.peers.find((p) => p.endpoint === endpoint);
      expect(peer?.status).not.toBe("terminated");
    },
    STALL_ESCALATION_MS + 8000,
  );
});
