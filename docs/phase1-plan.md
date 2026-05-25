# Phase 1 Plan — Launch / Bootstrap / Routing / Registry

> Consensus reached by A (Coordinator) + B (Planner/Critic) on 2026-03-27.
> Supersedes Phase 0, which is fully closed and green.

---

## Goals

- **Launch contract**: Coordinator can request the daemon to launch a new peer by role; receives a stable endpoint and initial metadata, or a structured error.
- **Bootstrap handshake**: After a new peer registers, its `bootstrap_state` transitions from `pending` → `acked` / `timeout`, and is observable. (`failed` is reserved for future phases.)
- **Semantic routing**: Messages can be addressed by role name (`intended_to: ["Planner"]`); daemon resolves to `resolved_endpoints` or returns a structured routing error.
- **Registry query**: Coordinator can retrieve the current peer list with `endpoint / role / model / workdir / status / bootstrap_state`.

## Non-Goals

- No macro/micro loop scheduler implementation
- No busy/idle policy orchestration
- No UI/CLI interaction layer
- No cross-room / cross-host routing
- No complex permission system (minimal validation only)
- No standalone route-resolution dry-run RPC (if needed, that is a later phase)

---

## Control-Plane Contracts

### LaunchRequest
```ts
interface LaunchRequest {
  role: string;           // required
  model?: string;         // optional, passed through to peer
  workdir?: string;       // optional; defaults to coordinator workdir if omitted
  coordinator: EndpointId;
  bootstrap_message?: string; // optional; if provided, must be a string
}
```

### LaunchResult
```ts
interface LaunchResult {
  success: boolean;
  endpoint?: EndpointId;  // pre-allocated at launch time (before peer registers)
  peer?: PeerMetadata;    // initial metadata snapshot
  error?: ErrorReceiptPayload;
}
```

### BootstrapAck
```ts
// Phase 1: 'failed' reserved for future process-lifecycle phases.
interface BootstrapAck {
  endpoint: EndpointId;
  role: string;
  status: 'acked' | 'timeout';
  observed_at: number;
  correlation_id?: string;
}
```

### RegistrySnapshot
```ts
interface RegistrySnapshot {
  peers: PeerMetadata[];
}
```

### Routing result (inlined into `post_envelope_result`)
- Success: `resolvedRecipients: string[]` (already present in existing field)
- Failure: `error: ErrorReceiptPayload` with code `ROLE_NOT_FOUND` or `ROLE_AMBIGUOUS`

---

## Validation Invariants

| Field | Rule |
|---|---|
| `role` | Required; must be a non-empty string |
| `model` | Optional; if provided, passed through to peer |
| `workdir` | Optional; if omitted, inherits coordinator workdir; if provided and invalid → `WORKDIR_INVALID` |
| `bootstrap_message` | Optional; if provided, must be a plain string |
| Role routing | Must distinguish `ROLE_NOT_FOUND` (no match) from `ROLE_AMBIGUOUS` (multiple matches) |

---

## Endpoint Allocation

Endpoint is **pre-allocated at launch time** (before the peer process registers).
This gives the coordinator a stable handle to:
- Associate bootstrap timeout with an expected peer
- Correlate a later register event with the launch request
- Detect cases where launch succeeds but register never arrives (timeout)

---

## Phase 1 Gates

### Happy Path

1. A sends `LaunchRequest` → daemon returns `LaunchResult` with `endpoint` + initial `PeerMetadata`
2. B process starts and sends `register` → `bootstrap_state = pending`
3. B sends bootstrap ack → `bootstrap_state = acked`, `BootstrapAck` observable
4. A sends role-routed envelope (`intended_to: ["Planner"]`) → daemon resolves `resolved_endpoints` → B receives
5. A queries registry → sees B with correct `role / status / bootstrap_state`

### Sad Path

1. Launch with invalid params → structured `ErrorReceiptPayload`
2. B fails to ack within timeout → `bootstrap_state = timeout` + `BootstrapAck` observable
3. Role routing: role not found → `ROLE_NOT_FOUND`
4. Role routing: role matches multiple peers → `ROLE_AMBIGUOUS`
5. Invalid `workdir` → `WORKDIR_INVALID`
6. `bootstrap_ack` from unknown endpoint → `ENDPOINT_NOT_FOUND` error receipt
7. Duplicate `bootstrap_ack` (already `acked`) → `BOOTSTRAP_DUPLICATE_ACK` observable receipt, state unchanged
8. Late `bootstrap_ack` (after `timeout`) → `BOOTSTRAP_TIMEOUT` observable receipt, state unchanged (Option A: timeout is terminal)

---

## Routing Contract Invariants (Locked)

### Role Matching
- Role matching is **case-sensitive exact string match, no canonicalization**.
- This is a protocol-level contract, not an implementation detail.
- `"Planner"` and `"planner"` are treated as two distinct roles.
- Coordinators are responsible for using consistent casing at both registration and routing time.
- A protocol change (not an implementation fix) is required if this rule is ever relaxed.

### Field Naming: `resolvedRecipients` vs `resolved_endpoints`
- **Control-protocol layer** (TypeScript `post_envelope_result`): `resolvedRecipients: string[]`
  — follows existing `post_message_result` naming convention (camelCase).
- **MessageEnvelope JSON protocol layer** (`envelope.resolved_endpoints`): snake_case
  — follows envelope field naming convention.
- These two fields refer to the same concept at different layers. When logging or documenting, use the layer-appropriate name.

### Required Tests (not yet written)

**Routing:**
1. `"Planner"` and `"planner"` must resolve independently (case-sensitive gate)
2. `intended_to = ["Planner", "planner-123"]` where role Planner resolves to `planner-123` must produce a single deduplicated entry in `resolvedRecipients`
3. `launching` and `terminated` peers must not appear in `resolvedRecipients` even if role matches

**Bootstrap:**
4. Pre-allocated endpoint: `register` → timer starts; `bootstrap_ack` within timeout → `status=bootstrapped`, `bootstrap_state=acked`
5. Timeout path: no `bootstrap_ack` within `BOOTSTRAP_TIMEOUT_MS` → `bootstrap_state=timeout`, `BootstrapAck{status:'timeout'}` observable
6. Late ack after timeout → `BOOTSTRAP_TIMEOUT` error receipt, `bootstrap_state` remains `timeout`
7. Duplicate ack → `BOOTSTRAP_DUPLICATE_ACK` receipt, state unchanged
8. `bootstrap_ack` from unregistered endpoint → `ENDPOINT_NOT_FOUND` receipt

### Error Code Registry (Phase 1 complete set)
| Code | When |
|---|---|
| `MISSING_FIELD` | Required envelope field absent |
| `INVALID_FORMAT` | Field present but wrong type/value |
| `ROLE_NOT_FOUND` | Role routing: no routable peer matches role |
| `ROLE_AMBIGUOUS` | Role routing: multiple peers match same role |
| `WORKDIR_INVALID` | workdir missing, not a string, not a directory |
| `BOOTSTRAP_TIMEOUT` | Late bootstrap_ack after timeout (terminal) |
| `BOOTSTRAP_DUPLICATE_ACK` | Duplicate bootstrap_ack on already-acked endpoint |
| `ENDPOINT_NOT_FOUND` | bootstrap_ack from endpoint not in registry |

---

## Phase 0 Carry-Over Constraint

> From Phase 0 close: heartbeat `payload.status` enum must be made explicit (Zod or type guard) before Phase 1 heartbeat handling is extended. Do not silently expand the binary `busy/idle` strategy.
