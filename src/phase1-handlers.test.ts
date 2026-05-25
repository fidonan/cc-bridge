import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEnvelope, validateLaunchRequest, validateWorkdir, resolveIntendedTo, processBootstrapAck, bootstrapOutcomeErrorCode } from "./phase1-handlers";
import type { PeerMetadata } from "./protocol";

// ===== validateEnvelope =====

describe("validateEnvelope", () => {
  const SELF = "test-endpoint";

  const validEnvelope = {
    protocol_version: "1.0",
    message_id: "m1",
    from: "A",
    sent_at: 1000,
    kind: "control",
    intent: "register",
    payload: {},
  };

  test("accepts a complete valid envelope", () => {
    const result = validateEnvelope(validEnvelope, SELF);
    expect(result.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = validateEnvelope("not-an-object", SELF);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.payload.code).toBe("INVALID_FORMAT");
  });

  test("rejects missing message_id", () => {
    const result = validateEnvelope({ ...validEnvelope, message_id: undefined }, SELF);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.payload.code).toBe("MISSING_FIELD");
      expect((result.error.payload as any).details?.field).toBe("message_id");
    }
  });

  test("rejects missing intent", () => {
    const result = validateEnvelope({ ...validEnvelope, intent: undefined }, SELF);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.payload.code).toBe("MISSING_FIELD");
      expect((result.error.payload as any).details?.field).toBe("intent");
    }
  });

  test("rejects invalid kind", () => {
    const result = validateEnvelope({ ...validEnvelope, kind: "unknown" }, SELF);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.payload.code).toBe("INVALID_FORMAT");
  });

  test("propagates correlationId into error envelope", () => {
    const result = validateEnvelope({ ...validEnvelope, intent: null }, SELF, "req-123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.correlation_id).toBe("req-123");
  });
});

// ===== validateLaunchRequest =====

describe("validateLaunchRequest", () => {
  test("accepts a minimal valid request", () => {
    const result = validateLaunchRequest({ role: "Planner", coordinator: "A" });
    expect(result).toBeNull();
  });

  test("rejects missing role", () => {
    const result = validateLaunchRequest({ role: "", coordinator: "A" });
    expect(result?.code).toBe("MISSING_FIELD");
  });

  test("rejects non-string bootstrap_message", () => {
    const result = validateLaunchRequest({ role: "Planner", coordinator: "A", bootstrap_message: 42 as any });
    expect(result?.code).toBe("INVALID_FORMAT");
  });

  test("rejects empty string workdir", () => {
    const result = validateLaunchRequest({ role: "Planner", coordinator: "A", workdir: "" });
    expect(result?.code).toBe("WORKDIR_INVALID");
  });

  test("rejects non-existent workdir", () => {
    const result = validateLaunchRequest({ role: "Planner", coordinator: "A", workdir: "/this/path/does/not/exist" });
    expect(result?.code).toBe("WORKDIR_INVALID");
  });
});

// ===== validateWorkdir =====

describe("validateWorkdir", () => {
  test("accepts an existing directory", () => {
    const result = validateWorkdir("/tmp");
    expect(result).toBeNull();
  });

  test("rejects a non-existent path", () => {
    const result = validateWorkdir("/this/path/does/not/exist/at/all");
    expect(result?.code).toBe("WORKDIR_INVALID");
  });

  test("rejects a regular file (not a directory)", () => {
    // Create a temp file
    const filePath = join(tmpdir(), `phase1-test-${Date.now()}.txt`);
    writeFileSync(filePath, "not a directory");
    try {
      const result = validateWorkdir(filePath);
      expect(result?.code).toBe("WORKDIR_INVALID");
    } finally {
      unlinkSync(filePath);
    }
  });
});

// ===== resolveIntendedTo =====

function makePeer(endpoint: string, role: string, status: PeerMetadata["status"] = "idle"): PeerMetadata {
  const now = Date.now();
  return { endpoint, role, started_at: now, last_heartbeat: now, status };
}

describe("resolveIntendedTo", () => {
  const peers: PeerMetadata[] = [
    makePeer("planner-001", "Planner"),
    makePeer("impl-001", "Implementer"),
    makePeer("impl-002", "Implementer"),
    makePeer("coord-001", "Coordinator", "busy"),
  ];
  const self = "coord-001";

  test("empty intended = broadcast to all routable peers excluding self", () => {
    const result = resolveIntendedTo([], peers, self);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoints).toContain("planner-001");
      expect(result.endpoints).toContain("impl-001");
      expect(result.endpoints).not.toContain(self);
    }
  });

  test("resolves by exact endpoint match", () => {
    const result = resolveIntendedTo(["planner-001"], peers, self);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.endpoints).toEqual(["planner-001"]);
  });

  test("resolves by role — exact case-sensitive match", () => {
    const result = resolveIntendedTo(["Planner"], peers, self);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.endpoints).toEqual(["planner-001"]);
  });

  test("role matching is case-sensitive: Planner != planner", () => {
    const result = resolveIntendedTo(["planner"], peers, self);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ROLE_NOT_FOUND");
  });

  test("returns ROLE_NOT_FOUND for unknown role", () => {
    const result = resolveIntendedTo(["Ghost"], peers, self);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ROLE_NOT_FOUND");
  });

  test("returns ROLE_AMBIGUOUS when multiple peers share a role", () => {
    const result = resolveIntendedTo(["Implementer"], peers, self);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ROLE_AMBIGUOUS");
  });

  test("deduplicates when endpoint and role both resolve to the same peer", () => {
    // intended_to = ["Planner", "planner-001"] — both point to planner-001
    const result = resolveIntendedTo(["Planner", "planner-001"], peers, self);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoints).toEqual(["planner-001"]); // deduplicated
    }
  });

  test("launching peers are not routable", () => {
    const peersWithLaunching: PeerMetadata[] = [
      ...peers,
      makePeer("new-001", "NewRole", "launching"),
    ];
    const result = resolveIntendedTo(["NewRole"], peersWithLaunching, self);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ROLE_NOT_FOUND");
  });

  test("terminated peers are not routable", () => {
    const peersWithTerminated: PeerMetadata[] = [
      ...peers,
      makePeer("old-001", "OldRole", "terminated"),
    ];
    const result = resolveIntendedTo(["OldRole"], peersWithTerminated, self);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ROLE_NOT_FOUND");
  });
});

// ===== processBootstrapAck =====

describe("processBootstrapAck", () => {
  test("unknown endpoint (undefined state) -> ENDPOINT_NOT_FOUND", () => {
    const outcome = processBootstrapAck(undefined);
    expect(outcome.action).toBe("unknown_endpoint");
    if (outcome.action === "unknown_endpoint") {
      expect(outcome.code).toBe("ENDPOINT_NOT_FOUND");
    }
  });

  test("pending -> ack (happy path)", () => {
    const outcome = processBootstrapAck("pending");
    expect(outcome.action).toBe("ack");
  });

  test("already acked -> ignore_duplicate (observable)", () => {
    const outcome = processBootstrapAck("acked");
    expect(outcome.action).toBe("ignore_duplicate");
  });

  test("timeout state -> ignore_late with BOOTSTRAP_TIMEOUT (Option A: terminal)", () => {
    const outcome = processBootstrapAck("timeout");
    expect(outcome.action).toBe("ignore_late");
    if (outcome.action === "ignore_late") {
      expect(outcome.code).toBe("BOOTSTRAP_TIMEOUT");
    }
  });

  test("timeout is terminal: late ack does NOT revert to acked", () => {
    // Simulate: state was timeout, now bootstrap_ack arrives
    const outcome = processBootstrapAck("timeout");
    // Must NOT be 'ack' — timeout is a terminal bootstrap state in Phase 1
    expect(outcome.action).not.toBe("ack");
  });

  test("once acked, subsequent ack is duplicate (idempotency)", () => {
    const first = processBootstrapAck("pending");
    expect(first.action).toBe("ack");
    // Simulate daemon updated state to 'acked', then another ack arrives
    const second = processBootstrapAck("acked");
    expect(second.action).toBe("ignore_duplicate");
  });
});

// ===== bootstrapOutcomeErrorCode — outcome → observable receipt mapping =====

describe("bootstrapOutcomeErrorCode", () => {
  test("unknown_endpoint outcome → ENDPOINT_NOT_FOUND receipt", () => {
    const outcome = processBootstrapAck(undefined);
    expect(bootstrapOutcomeErrorCode(outcome)).toBe("ENDPOINT_NOT_FOUND");
  });

  test("ignore_duplicate outcome → BOOTSTRAP_DUPLICATE_ACK receipt (observable)", () => {
    const outcome = processBootstrapAck("acked");
    expect(bootstrapOutcomeErrorCode(outcome)).toBe("BOOTSTRAP_DUPLICATE_ACK");
  });

  test("ignore_late outcome → BOOTSTRAP_TIMEOUT receipt (observable, Option A)", () => {
    const outcome = processBootstrapAck("timeout");
    expect(bootstrapOutcomeErrorCode(outcome)).toBe("BOOTSTRAP_TIMEOUT");
  });

  test("ack outcome → null (no error receipt on happy path)", () => {
    const outcome = processBootstrapAck("pending");
    expect(bootstrapOutcomeErrorCode(outcome)).toBeNull();
  });
});
