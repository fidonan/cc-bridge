/**
 * Phase 1 pure handler functions — extracted for testability.
 * These functions have no side effects and do not depend on daemon global state.
 * daemon.ts imports from here; tests import from here directly.
 */

import { existsSync, statSync } from "node:fs";
import type {
  MessageEnvelope,
  ErrorEnvelope,
  ErrorReceiptPayload,
  LaunchRequest,
  PeerMetadata,
} from "./protocol";

// ===== Envelope Validation =====

const REQUIRED_ENVELOPE_FIELDS: (keyof MessageEnvelope)[] = [
  "protocol_version",
  "message_id",
  "from",
  "sent_at",
  "kind",
  "intent",
];
const VALID_ENVELOPE_KINDS = ["control", "work", "error"] as const;

export function makeErrorEnvelope(
  from: string,
  code: ErrorReceiptPayload["code"],
  message: string,
  correlationId?: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    protocol_version: "1.0",
    message_id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...(correlationId ? { correlation_id: correlationId } : {}),
    from,
    sent_at: Date.now(),
    kind: "error",
    intent: "error_receipt",
    payload: { code, message, ...(details ? { details } : {}) },
  };
}

export function validateEnvelope(
  raw: unknown,
  from: string,
  correlationId?: string,
): { ok: true; envelope: MessageEnvelope } | { ok: false; error: ErrorEnvelope } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: makeErrorEnvelope(from, "INVALID_FORMAT", "Envelope must be a JSON object", correlationId),
    };
  }

  const obj = raw as Record<string, unknown>;

  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      return {
        ok: false,
        error: makeErrorEnvelope(from, "MISSING_FIELD", `Required field '${field}' is missing`, correlationId, {
          field,
        }),
      };
    }
  }

  if (!VALID_ENVELOPE_KINDS.includes(obj.kind as (typeof VALID_ENVELOPE_KINDS)[number])) {
    return {
      ok: false,
      error: makeErrorEnvelope(
        from,
        "INVALID_FORMAT",
        `Invalid kind '${obj.kind}', must be one of: ${VALID_ENVELOPE_KINDS.join(", ")}`,
        correlationId,
        { field: "kind", value: obj.kind },
      ),
    };
  }

  return { ok: true, envelope: raw as MessageEnvelope };
}

// ===== Launch Validation =====

export function validateWorkdir(path: string): ErrorReceiptPayload | null {
  if (!existsSync(path)) {
    return { code: "WORKDIR_INVALID", message: `workdir does not exist: ${path}` };
  }
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      return { code: "WORKDIR_INVALID", message: `workdir is not a directory: ${path}` };
    }
  } catch {
    return { code: "WORKDIR_INVALID", message: `workdir is not accessible: ${path}` };
  }
  return null;
}

export function validateLaunchRequest(req: LaunchRequest): ErrorReceiptPayload | null {
  if (!req.role || typeof req.role !== "string" || req.role.trim() === "") {
    return { code: "MISSING_FIELD", message: "LaunchRequest.role is required and must be a non-empty string" };
  }
  if (req.bootstrap_message !== undefined && typeof req.bootstrap_message !== "string") {
    return { code: "INVALID_FORMAT", message: "LaunchRequest.bootstrap_message must be a string if provided" };
  }
  if (req.workdir !== undefined) {
    if (typeof req.workdir !== "string" || req.workdir.trim() === "") {
      return { code: "WORKDIR_INVALID", message: "LaunchRequest.workdir must be a non-empty string if provided" };
    }
    const workdirError = validateWorkdir(req.workdir);
    if (workdirError) return workdirError;
  }
  return null;
}

// ===== Bootstrap State Machine =====

export type BootstrapState = PeerMetadata["bootstrap_state"];

export type BootstrapAckOutcome =
  | { action: "ack" }                                         // happy path: pending → acked
  | { action: "ignore_duplicate" }                            // already acked, ignored + observable
  | { action: "ignore_late"; code: "BOOTSTRAP_TIMEOUT" }     // late after timeout, Option A
  | { action: "unknown_endpoint"; code: "ENDPOINT_NOT_FOUND" }; // endpoint not in registry

/**
 * Pure bootstrap_ack state machine.
 * Takes current bootstrap_state (undefined = endpoint not found) and returns the outcome.
 * All side effects (registry mutation, emit) are handled by the caller (daemon).
 */
export function processBootstrapAck(currentState: BootstrapState | undefined): BootstrapAckOutcome {
  if (currentState === undefined) {
    return { action: "unknown_endpoint", code: "ENDPOINT_NOT_FOUND" };
  }
  if (currentState === "acked") {
    return { action: "ignore_duplicate" };
  }
  if (currentState === "timeout") {
    return { action: "ignore_late", code: "BOOTSTRAP_TIMEOUT" };
  }
  // pending → ack
  return { action: "ack" };
}

/**
 * Maps a bootstrap outcome to the error code that should be emitted as an observable receipt.
 * Returns null for the happy-path 'ack' outcome (no error receipt, only BootstrapAck + lifecycle_ack).
 * This function defines the outcome → observable receipt contract for testing.
 */
export function bootstrapOutcomeErrorCode(outcome: BootstrapAckOutcome): ErrorReceiptPayload["code"] | null {
  switch (outcome.action) {
    case "unknown_endpoint": return "ENDPOINT_NOT_FOUND";
    case "ignore_late":      return "BOOTSTRAP_TIMEOUT";
    case "ignore_duplicate": return "BOOTSTRAP_DUPLICATE_ACK";
    case "ack":              return null; // no error receipt on happy path
  }
}

// ===== Semantic Routing =====

export type RouteResolution = { ok: true; endpoints: string[] } | { ok: false; error: ErrorReceiptPayload };

/**
 * Resolve intended_to array to routable endpoint IDs.
 * - Internally filters out launching and terminated peers (non-routability invariant).
 * - Exact endpoint match takes priority over role match.
 * - Role matching is case-sensitive exact string equality (protocol contract).
 * - Result is deduplicated by endpoint (Set semantics).
 * - Empty intended_to = broadcast to all routable peers (excluding self).
 *
 * @param intended  - list of target role names or endpoint IDs
 * @param allPeers  - full peer registry (function filters internally)
 * @param selfEndpoint - excluded from broadcast results
 */
export function resolveIntendedTo(
  intended: string[],
  allPeers: PeerMetadata[],
  selfEndpoint: string,
): RouteResolution {
  // Enforce non-routability invariant: launching and terminated peers are never routable
  const routablePeers = allPeers.filter((m) => m.status !== "launching" && m.status !== "terminated");

  if (intended.length === 0) {
    return {
      ok: true,
      endpoints: routablePeers.map((m) => m.endpoint).filter((e) => e !== selfEndpoint),
    };
  }

  const resolved = new Set<string>();

  for (const target of intended) {
    // Priority 1: exact endpoint match
    const exactMatch = routablePeers.find((m) => m.endpoint === target);
    if (exactMatch) {
      resolved.add(exactMatch.endpoint);
      continue;
    }

    // Priority 2: role match (case-sensitive exact string equality)
    const roleMatches = routablePeers.filter((m) => m.role === target);
    if (roleMatches.length === 0) {
      return {
        ok: false,
        error: { code: "ROLE_NOT_FOUND", message: `No routable peer found for '${target}'`, details: { target } },
      };
    }
    if (roleMatches.length > 1) {
      return {
        ok: false,
        error: {
          code: "ROLE_AMBIGUOUS",
          message: `Multiple peers match role '${target}'`,
          details: { target, matches: roleMatches.map((m) => m.endpoint) },
        },
      };
    }
    resolved.add(roleMatches[0].endpoint);
  }

  return { ok: true, endpoints: [...resolved] };
}
