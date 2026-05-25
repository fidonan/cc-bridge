/**
 * Phase 3A integration tests — Supervisor Attachment Contract
 *
 * Exercises:
 *   1. supervisor_attach happy path → success; observables route to supervisor WS
 *   2. Non-coordinator WS → SUPERVISOR_ATTACH_FORBIDDEN
 *   3. supervisor_detach → buffer → reattach → buffered observables flushed in order
 *   4. supervisor_detach idempotency (not attached → success)
 *   5. Socket close → implicit release → new coordinator can attach
 *   6. Backward compat: no supervisor_attach → observables reach attachedClaude (Phase 0/1/2 path)
 *   7. Observables do NOT reach non-supervisor WS when supervisor is attached
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LaunchRequest, LaunchResult, MessageEnvelope, RegistrySnapshot } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase3a-test";
const ROOM = "test-phase3a";
const COORDINATOR = "coord-A3";
const BOOTSTRAP_TIMEOUT_MS = 2000;

const PORT = 25000 + Math.floor(Math.random() * 3000);
const PORT2 = 28000 + Math.floor(Math.random() * 1000); // separate daemon for backward compat test
let proc: Subprocess | null = null;
let proc2: Subprocess | null = null;
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
    message_id: `t3a_${++msgCounter}_${Date.now()}`,
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

class Phase3ATestClient {
  private ws!: WebSocket;
  private reqId = 0;
  readonly observables: ObservableEntry[] = [];
  private resolvers = new Map<string, (v: any) => void>();

  async connect(port: number, sendClaudeConnect = true) {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WS connect failed on port ${port}`));
      this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
    });
    if (sendClaudeConnect) {
      this.ws.send(JSON.stringify({ type: "claude_connect" }));
      await sleep(100);
    }
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
    const requestId = `r3a_${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.resolvers.set(requestId, resolve);
      this.ws.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  supervisorAttach(endpoint: string) {
    return this.req<{ type: "supervisor_attach_result"; requestId: string; success: boolean; error?: unknown }>({
      type: "supervisor_attach",
      endpoint,
    });
  }

  supervisorDetach() {
    return this.req<{ type: "supervisor_detach_result"; requestId: string; success: boolean }>({
      type: "supervisor_detach",
    });
  }

  launchPeer(request: LaunchRequest) {
    return this.req<{ type: "launch_peer_result"; result: LaunchResult }>({
      type: "launch_peer",
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

  async waitForObservable(predicate: (p: any) => boolean, timeoutMs = 4000): Promise<any> {
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

// ── Daemon factory ────────────────────────────────────────────────────────────

function startDaemon(port: number, stateDir: string, room: string, extra: Record<string, string> = {}): Subprocess {
  return spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(port),
      AGENTBRIDGE_PID_FILE: `/tmp/cc-bridge-phase3a-${port}.pid`,
      AGENTBRIDGE_LOG_FILE: `/tmp/cc-bridge-phase3a-${port}.log`,
      CC_BRIDGE_ROOM: room,
      CC_BRIDGE_ENDPOINT: COORDINATOR,
      CC_BRIDGE_STATE_DIR: stateDir,
      CC_BRIDGE_HEARTBEAT_MS: "300",
      CC_BRIDGE_PEER_STALE_MS: "2000",
      CC_BRIDGE_POLL_INTERVAL_MS: "200",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: String(BOOTSTRAP_TIMEOUT_MS),
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "120000",
      ...extra,
    } as Record<string, string>,
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitForDaemon(port: number, timeoutMs = 8000): Promise<void> {
  const url = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Daemon on port ${port} failed to start`);
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(`/tmp/cc-bridge-phase3a-${PORT}.pid`, { force: true });
  rmSync(`/tmp/cc-bridge-phase3a-${PORT2}.pid`, { force: true });

  proc = startDaemon(PORT, STATE_DIR, ROOM);
  proc2 = startDaemon(PORT2, STATE_DIR + "-compat", ROOM + "-compat");
  await Promise.all([waitForDaemon(PORT), waitForDaemon(PORT2)]);
});

afterAll(async () => {
  proc?.kill();
  proc2?.kill();
  await sleep(200);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 3A — Supervisor Attachment", () => {

  // ── Gate 1: Happy path attach + observable routing ────────────────────────

  test("1. supervisor_attach succeeds for coordinator; lifecycle_ack observable received", async () => {
    const client = new Phase3ATestClient();
    await client.connect(PORT); // sends claude_connect → becomes attachedClaude
    await sleep(100);

    const attachResult = await client.supervisorAttach("coord-A");
    expect(attachResult.success).toBe(true);
    expect(attachResult.error).toBeUndefined();

    // Register a peer via post_envelope → triggers lifecycle_ack observable
    const endpoint = `peer-gate1-${Date.now()}`;
    await client.postEnvelope(makeEnvelope(endpoint, "control", "register", { endpoint, role: "Worker" }));

    const obs = await client.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint,
    );
    expect(obs).not.toBeNull();
    expect(obs.payload.status).toBe("connected");

    client.close();
    await sleep(100);
  });

  // ── Gate 2: SUPERVISOR_ATTACH_FORBIDDEN for non-coordinator WS ───────────

  test("2. non-coordinator WS gets SUPERVISOR_ATTACH_FORBIDDEN", async () => {
    // Client A is coordinator (already occupies attachedClaude from gate 1 daemon, but closed)
    // Open fresh coordinator first so attachedClaude is set
    const coordinator = new Phase3ATestClient();
    await coordinator.connect(PORT); // claude_connect → attachedClaude

    // Open a second WS WITHOUT claude_connect
    const nonCoord = new Phase3ATestClient();
    await nonCoord.connect(PORT, false); // no claude_connect → not attachedClaude
    await sleep(100);

    const result = await nonCoord.supervisorAttach("impostor");
    expect(result.success).toBe(false);
    expect((result.error as any)?.code).toBe("SUPERVISOR_ATTACH_FORBIDDEN");

    coordinator.close();
    nonCoord.close();
    await sleep(100);
  });

  // ── Gate 3: Detach → buffer → reattach → flush ───────────────────────────

  test("3. detach → observable buffered → reattach → buffered observable flushed", async () => {
    const client = new Phase3ATestClient();
    await client.connect(PORT);

    // Attach supervisor
    const a1 = await client.supervisorAttach("coord-buf");
    expect(a1.success).toBe(true);

    // Detach
    const det = await client.supervisorDetach();
    expect(det.success).toBe(true);
    client.clearObservables();

    // While detached: register a peer → lifecycle_ack goes to supervisorBuffer
    const endpoint = `peer-buf-${Date.now()}`;
    await client.postEnvelope(makeEnvelope(endpoint, "control", "register", { endpoint, role: "Worker" }));
    await sleep(100); // let observable be generated and buffered

    // At this point the observable should NOT have arrived (supervisor detached)
    const beforeReattach = client.observables.find(
      (o) => (o.parsed as any)?.payload?.endpoint === endpoint,
    );
    expect(beforeReattach).toBeUndefined();

    // Reattach → should flush buffered lifecycle_ack
    const a2 = await client.supervisorAttach("coord-buf");
    expect(a2.success).toBe(true);

    const obs = await client.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint,
    );
    expect(obs).not.toBeNull();
    expect(obs.payload.status).toBe("connected");

    client.close();
    await sleep(100);
  });

  // ── Gate 4: supervisor_detach idempotency ────────────────────────────────

  test("4. supervisor_detach when not attached is idempotent (success)", async () => {
    const client = new Phase3ATestClient();
    await client.connect(PORT);
    // Do NOT call supervisor_attach

    const det = await client.supervisorDetach();
    expect(det.success).toBe(true);

    client.close();
    await sleep(100);
  });

  // ── Gate 5: Socket close → implicit release ───────────────────────────────

  test("5. socket close releases supervisor; new coordinator can attach", async () => {
    // Start fresh: use a fresh daemon (proc) with a new client
    const client1 = new Phase3ATestClient();
    await client1.connect(PORT);
    const r1 = await client1.supervisorAttach("coord-close1");
    expect(r1.success).toBe(true);

    // Close socket → implicit release
    client1.close();
    await sleep(300); // allow close event to propagate

    // New coordinator
    const client2 = new Phase3ATestClient();
    await client2.connect(PORT);
    const r2 = await client2.supervisorAttach("coord-close2");
    expect(r2.success).toBe(true);

    client2.close();
    await sleep(100);
  });

  // ── Gate 6: Backward compat — no supervisor_attach → attachedClaude path ──

  test("6. backward compat: no supervisor_attach → observables reach attachedClaude (Phase 0/1/2 path)", async () => {
    // Uses separate daemon (proc2) — no supervisor_attach ever called
    const client = new Phase3ATestClient();
    await client.connect(PORT2); // claude_connect only, no supervisor_attach

    const endpoint = `peer-compat-${Date.now()}`;
    await client.postEnvelope(makeEnvelope(endpoint, "control", "register", { endpoint, role: "Compat" }));

    // lifecycle_ack should arrive via attachedClaude (backward compat fallback)
    const obs = await client.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint,
    );
    expect(obs).not.toBeNull();
    expect(obs.payload.status).toBe("connected");

    client.close();
    await sleep(100);
  });

  // ── Gate 7: Observables don't reach non-supervisor WS ────────────────────

  test("7. observables do NOT arrive on non-supervisor WS when supervisor is attached", async () => {
    const coordinator = new Phase3ATestClient();
    await coordinator.connect(PORT);
    const r = await coordinator.supervisorAttach("coord-isolation");
    expect(r.success).toBe(true);

    // Non-supervisor WS: connect without claude_connect
    const bystander = new Phase3ATestClient();
    await bystander.connect(PORT, false);
    await sleep(100);

    const endpoint = `peer-iso-${Date.now()}`;
    await coordinator.postEnvelope(makeEnvelope(endpoint, "control", "register", { endpoint, role: "IsoWorker" }));

    // coordinator receives observable
    const obs = await coordinator.waitForObservable(
      (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === endpoint,
    );
    expect(obs).not.toBeNull();

    // bystander receives nothing
    await sleep(300);
    const bystanderObs = bystander.observables.find(
      (o) => (o.parsed as any)?.payload?.endpoint === endpoint,
    );
    expect(bystanderObs).toBeUndefined();

    coordinator.close();
    bystander.close();
    await sleep(100);
  });

  // ── Gate 8: supervisorEverAttached state machine ──────────────────────────
  // no attach yet → fallback to attachedClaude
  // attach → live supervisor sink
  // detach/close after ever-attached → buffer (NOT fallback to attachedClaude live path)
  // reattach → FIFO flush buffered events exactly once

  test("8. ever-attached state machine: detach→buffer (not attachedClaude fallback), reattach→FIFO flush once", async () => {
    // Use a fresh daemon via proc2 has already been used for compat; use proc for this test
    // but proc may have supervisorEverAttached=true from earlier tests — need fresh daemon
    // Spin up a third daemon inline
    const port3 = 29000 + Math.floor(Math.random() * 500);
    rmSync(`/tmp/cc-bridge-phase3a-${port3}.pid`, { force: true });
    const proc3 = startDaemon(port3, STATE_DIR + "-ever", ROOM + "-ever");
    await waitForDaemon(port3);

    try {
      const client = new Phase3ATestClient();
      await client.connect(port3);

      // PHASE A: attach → live sink
      const a1 = await client.supervisorAttach("coord-ever");
      expect(a1.success).toBe(true);

      // Detach
      const det = await client.supervisorDetach();
      expect(det.success).toBe(true);
      client.clearObservables();

      // PHASE B: after ever-attached+detach, observable must go to supervisorBuffer,
      // NOT back to attachedClaude live path.
      // (client is still attachedClaude; if fallback were used, it would receive obs immediately)
      const ep1 = `peer-ever1-${Date.now()}`;
      await client.postEnvelope(makeEnvelope(ep1, "control", "register", { endpoint: ep1, role: "EverW" }));
      await sleep(150); // time for observable to be generated

      // Observable must NOT have arrived yet (buffered, not sent live)
      const premature = client.observables.find((o) => (o.parsed as any)?.payload?.endpoint === ep1);
      expect(premature).toBeUndefined(); // strict: must be in buffer, not delivered

      // Register a second peer while still detached — both should be buffered
      const ep2 = `peer-ever2-${Date.now()}`;
      await client.postEnvelope(makeEnvelope(ep2, "control", "register", { endpoint: ep2, role: "EverW2" }));
      await sleep(100);

      // PHASE C: reattach → FIFO flush: ep1 lifecycle_ack arrives before ep2
      const beforeFlush = client.observables.length;
      const a2 = await client.supervisorAttach("coord-ever");
      expect(a2.success).toBe(true);

      // Wait for both buffered observables to arrive
      const obs1 = await client.waitForObservable(
        (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === ep1,
      );
      const obs2 = await client.waitForObservable(
        (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === ep2,
      );
      expect(obs1).not.toBeNull();
      expect(obs2).not.toBeNull();

      // Verify FIFO: ep1 was registered first, so its lifecycle_ack index < ep2's
      const idx1 = client.observables.findIndex((o) => (o.parsed as any)?.payload?.endpoint === ep1);
      const idx2 = client.observables.findIndex((o) => (o.parsed as any)?.payload?.endpoint === ep2);
      expect(idx1).toBeLessThan(idx2);

      // Verify exactly once delivery: no duplicate for ep1 or ep2
      const ep1Count = client.observables.filter((o) => (o.parsed as any)?.payload?.endpoint === ep1).length;
      const ep2Count = client.observables.filter((o) => (o.parsed as any)?.payload?.endpoint === ep2).length;
      expect(ep1Count).toBe(1);
      expect(ep2Count).toBe(1);

      // PHASE D: post-reattach observables go live (no duplicate via buffer)
      const ep3 = `peer-ever3-${Date.now()}`;
      await client.postEnvelope(makeEnvelope(ep3, "control", "register", { endpoint: ep3, role: "EverW3" }));
      const obs3 = await client.waitForObservable(
        (p) => p?.intent === "lifecycle_ack" && p?.payload?.endpoint === ep3,
      );
      expect(obs3).not.toBeNull(); // live delivery still works after reattach

      client.close();
    } finally {
      proc3.kill();
      await sleep(200);
    }
  });

});
