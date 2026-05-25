/**
 * Phase 1 integration smoke tests
 *
 * Spawns a single real daemon (coordinator) and exercises 4 critical chains:
 *   1. launch → register → bootstrap_ack (happy path)
 *   2. Role routing happy path (resolvedRecipients + dedupe + case-sensitivity)
 *   3. Bootstrap timeout sad path (Option A: timeout is terminal, late ack rejected)
 *   4. Unknown / duplicate bootstrap_ack receipt paths
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LaunchRequest, LaunchResult, MessageEnvelope, RegistrySnapshot } from "./protocol";

// ── Config ────────────────────────────────────────────────────────────────────

const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;
const STATE_DIR = "/tmp/cc-bridge-phase1-test";
const ROOM = "test-phase1";
const COORDINATOR = "coord-A";
const BOOTSTRAP_TIMEOUT_MS = 2000; // shortened for fast timeout test

const PORT = 20000 + Math.floor(Math.random() * 20000);
let proc: Subprocess | null = null;
let client: Phase1TestClient;
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
    message_id: `t_${++msgCounter}_${Date.now()}`,
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
  parsed: unknown; // null if content is not valid JSON
}

class Phase1TestClient {
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
      try {
        parsed = JSON.parse(raw);
      } catch {}
      this.observables.push({ raw, parsed });
    }
    const resolver = this.resolvers.get(msg.requestId);
    if (resolver) {
      this.resolvers.delete(msg.requestId);
      resolver(msg);
    }
  }

  private req<T>(msg: object): Promise<T> {
    const requestId = `r_${++this.reqId}`;
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

  postEnvelope(envelope: MessageEnvelope) {
    return this.req<{
      type: "post_envelope_result";
      success: boolean;
      resolvedRecipients?: string[];
      error?: unknown;
    }>({ type: "post_envelope", envelope });
  }

  queryRegistry() {
    return this.req<{ type: "query_registry_result"; snapshot: RegistrySnapshot }>({
      type: "query_registry",
    });
  }

  /** Poll observables until a matching entry appears or timeout elapses. */
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
    try {
      this.ws.close();
    } catch {}
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync("/tmp/cc-bridge-phase1.pid", { force: true });
  rmSync("/tmp/cc-bridge-phase1.log", { force: true });

  proc = spawn(["bun", "run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(PORT),
      AGENTBRIDGE_PID_FILE: "/tmp/cc-bridge-phase1.pid",
      AGENTBRIDGE_LOG_FILE: "/tmp/cc-bridge-phase1.log",
      CC_BRIDGE_ROOM: ROOM,
      CC_BRIDGE_ENDPOINT: COORDINATOR,
      CC_BRIDGE_STATE_DIR: STATE_DIR,
      CC_BRIDGE_HEARTBEAT_MS: "500",
      CC_BRIDGE_PEER_STALE_MS: "60000", // prevent stall detection during test
      CC_BRIDGE_POLL_INTERVAL_MS: "300",
      CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS: String(BOOTSTRAP_TIMEOUT_MS),
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

  client = new Phase1TestClient();
  await client.connect(PORT);
  await sleep(300);
}, 15000);

afterAll(async () => {
  client?.close();
  try {
    proc?.kill();
  } catch {}
  await sleep(300);
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync("/tmp/cc-bridge-phase1.pid", { force: true });
  rmSync("/tmp/cc-bridge-phase1.log", { force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 1 integration", () => {
  // Shared across chains — set by chain 1, read by chains 2 and 4
  let plannerEndpoint: string;

  test("chain 1: launch → register → bootstrap_ack (happy path)", async () => {
    // Step 1: launch_peer — daemon pre-allocates endpoint in 'launching' state
    const launchRes = await client.launchPeer({ role: "Planner", coordinator: COORDINATOR });
    expect(launchRes.result.success).toBe(true);
    expect(launchRes.result.endpoint).toBeTruthy();
    plannerEndpoint = launchRes.result.endpoint!;
    expect(launchRes.result.peer?.status).toBe("launching");
    expect(launchRes.result.peer?.bootstrap_state).toBe("pending");

    // Step 2: register from the pre-allocated endpoint — triggers bootstrap timer
    const regResult = await client.postEnvelope(
      makeEnvelope(plannerEndpoint, "control", "register", {
        endpoint: plannerEndpoint,
        role: "Planner",
        started_at: Date.now(),
      }),
    );
    expect(regResult.success).toBe(true);

    // Observe lifecycle_ack for 'connected'
    const connectedAck = await client.waitForObservable(
      (p) =>
        p?.intent === "lifecycle_ack" &&
        p?.payload?.endpoint === plannerEndpoint &&
        p?.payload?.status === "connected",
    );
    expect(connectedAck).not.toBeNull();

    // Step 3: send bootstrap_ack — happy path transition
    const ackResult = await client.postEnvelope(
      makeEnvelope(plannerEndpoint, "control", "bootstrap_ack", {}),
    );
    expect(ackResult.success).toBe(true);

    // Observe BootstrapAck{status:'acked'} — raw object, no 'kind' field
    const bootstrapObs = await client.waitForObservable(
      (p) => p?.endpoint === plannerEndpoint && p?.status === "acked",
    );
    expect(bootstrapObs).not.toBeNull();
    expect(bootstrapObs.role).toBe("Planner");

    // Step 4: verify registry reflects final state
    const reg = await client.queryRegistry();
    const peer = reg.snapshot.peers.find((p) => p.endpoint === plannerEndpoint);
    expect(peer).toBeDefined();
    expect(peer!.bootstrap_state).toBe("acked");
    expect(peer!.status).toBe("bootstrapped");
  });

  test("chain 2: role routing (resolvedRecipients + dedupe + case-sensitivity)", async () => {
    expect(plannerEndpoint).toBeTruthy(); // requires chain 1

    // 2a: Route by role name
    const byRole = await client.postEnvelope(
      makeEnvelope(COORDINATOR, "work", "task", {}, { intended_to: ["Planner"] }),
    );
    expect(byRole.success).toBe(true);
    expect(byRole.resolvedRecipients).toEqual([plannerEndpoint]);

    // 2b: Deduplication — role + exact endpoint resolve to same peer → single entry
    const deduped = await client.postEnvelope(
      makeEnvelope(COORDINATOR, "work", "task", {}, { intended_to: ["Planner", plannerEndpoint] }),
    );
    expect(deduped.success).toBe(true);
    expect(deduped.resolvedRecipients).toHaveLength(1);
    expect(deduped.resolvedRecipients![0]).toBe(plannerEndpoint);

    // 2c: Broadcast (no intended_to) returns all routable peers excluding self
    const broadcast = await client.postEnvelope(
      makeEnvelope(COORDINATOR, "work", "task", {}),
    );
    expect(broadcast.success).toBe(true);
    expect(broadcast.resolvedRecipients).toContain(plannerEndpoint);
    expect(broadcast.resolvedRecipients).not.toContain(COORDINATOR);

    // 2d: ROLE_NOT_FOUND for unknown role
    const notFound = await client.postEnvelope(
      makeEnvelope(COORDINATOR, "work", "task", {}, { intended_to: ["Ghost"] }),
    );
    expect(notFound.success).toBe(false);
    expect((notFound.error as any)?.payload?.code).toBe("ROLE_NOT_FOUND");

    // 2e: Role matching is case-sensitive — 'planner' ≠ 'Planner'
    const wrongCase = await client.postEnvelope(
      makeEnvelope(COORDINATOR, "work", "task", {}, { intended_to: ["planner"] }),
    );
    expect(wrongCase.success).toBe(false);
    expect((wrongCase.error as any)?.payload?.code).toBe("ROLE_NOT_FOUND");
  });

  test(
    "chain 3: bootstrap timeout sad path (Option A: timeout is terminal)",
    async () => {
      // Launch a new peer that intentionally never sends bootstrap_ack
      const launchRes = await client.launchPeer({ role: "TimeoutTest", coordinator: COORDINATOR });
      expect(launchRes.result.success).toBe(true);
      const timeoutEndpoint = launchRes.result.endpoint!;

      // Register — starts the bootstrap timer
      await client.postEnvelope(
        makeEnvelope(timeoutEndpoint, "control", "register", {
          endpoint: timeoutEndpoint,
          role: "TimeoutTest",
        }),
      );

      // Wait for the timeout to fire: BootstrapAck{status:'timeout'} observable
      const timeoutObs = await client.waitForObservable(
        (p) => p?.endpoint === timeoutEndpoint && p?.status === "timeout",
        BOOTSTRAP_TIMEOUT_MS + 1500,
      );
      expect(timeoutObs).not.toBeNull();

      // Registry must reflect bootstrap_state: 'timeout'
      const reg1 = await client.queryRegistry();
      const peer1 = reg1.snapshot.peers.find((p) => p.endpoint === timeoutEndpoint);
      expect(peer1?.bootstrap_state).toBe("timeout");

      // Send a late bootstrap_ack — must NOT revert state
      await client.postEnvelope(
        makeEnvelope(timeoutEndpoint, "control", "bootstrap_ack", {}),
      );

      // Expect BOOTSTRAP_TIMEOUT error receipt (not a BootstrapAck{status:'acked'})
      const lateError = await client.waitForObservable(
        (p) =>
          p?.kind === "error" &&
          p?.payload?.code === "BOOTSTRAP_TIMEOUT" &&
          p?.payload?.message?.includes(timeoutEndpoint),
      );
      expect(lateError).not.toBeNull();

      // bootstrap_state must remain 'timeout' — late ack is terminal, state unchanged
      const reg2 = await client.queryRegistry();
      const peer2 = reg2.snapshot.peers.find((p) => p.endpoint === timeoutEndpoint);
      expect(peer2?.bootstrap_state).toBe("timeout");
    },
    BOOTSTRAP_TIMEOUT_MS + 5000,
  );

  test("chain 4: unknown and duplicate bootstrap_ack receipts", async () => {
    // 4a: bootstrap_ack from an endpoint not in the registry → ENDPOINT_NOT_FOUND
    await client.postEnvelope(
      makeEnvelope("totally-unknown-endpoint-xyz", "control", "bootstrap_ack", {}),
    );
    const unknownError = await client.waitForObservable(
      (p) => p?.kind === "error" && p?.payload?.code === "ENDPOINT_NOT_FOUND",
    );
    expect(unknownError).not.toBeNull();

    // 4b: duplicate bootstrap_ack on already-acked endpoint → BOOTSTRAP_DUPLICATE_ACK
    expect(plannerEndpoint).toBeTruthy(); // already acked in chain 1
    await client.postEnvelope(
      makeEnvelope(plannerEndpoint, "control", "bootstrap_ack", {}),
    );
    const duplicateError = await client.waitForObservable(
      (p) => p?.kind === "error" && p?.payload?.code === "BOOTSTRAP_DUPLICATE_ACK",
    );
    expect(duplicateError).not.toBeNull();
  });
});
