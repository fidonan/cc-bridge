# Phase 3 Plan — Attachment, Observable Fanout & Orchestration Primitives

> Consensus reached by A (Coordinator) + B (Planner/Critic) on 2026-03-27.
> Supersedes Phase 2, which is fully closed and green.

---

## Structure

Phase 3 is split into two sequential sub-phases:

- **Phase 3A**: Supervisor attachment contract & observable fanout (prerequisite)
- **Phase 3B**: Task/trigger orchestration primitives (builds on 3A)

---

## Phase 3A — Supervisor Attachment Contract

### Goals

- Define a stable supervisor sink per room, so coordinator observables are never stolen by child processes.
- Replace the current implicit `attachedClaude` single-owner model with an explicit supervisor ownership contract.
- Establish fallback behavior when no supervisor is registered.

### Non-Goals

- No multi-coordinator per room (Phase 4)
- No cross-room supervisor (Phase 4+)
- No message-level ACL or subscriber filtering beyond supervisor vs. non-supervisor

---

### Ownership Contract

#### Scope

**One supervisor sink per room.** A room may have at most one registered supervisor at any time. This is a narrowing constraint — not a global singleton.

#### Ownership Identity

Supervisor ownership has two distinct layers — **auth identity** and **routing identity** — which are intentionally separated:

| Layer | Bound to | Purpose |
|---|---|---|
| **Auth identity** (who may detach) | WS socket object | Only the socket that called `supervisor_attach` may call `supervisor_detach` or is released on disconnect |
| **Routing identity** (observable tagging) | `supervisor_attach.endpoint` (EndpointId) | Used for `task_id` correlation, observable attribution in Phase 3B |

**Claim validation rule (Phase 3) — acquisition eligibility gate**:

**Phase 3 scope constraint: one daemon instance = one room.** There is exactly one room per daemon in Phase 3. Multi-room is Phase 4. Within this constraint, `attachedClaude` IS the room-associated coordinator connection — daemon-global and room-scoped are equivalent in Phase 3.

Eligibility rule: only the WS connection associated with the room's coordinator (i.e., the WS that called `claude_connect` for this session — the `attachedClaude` connection) may call `supervisor_attach`. Any other WS connection attempting `supervisor_attach` receives `SUPERVISOR_ATTACH_FORBIDDEN` immediately, regardless of whether the slot is unattached.

```
Eligibility check: ws === attachedClaude socket → allowed
                   ws !== attachedClaude socket → SUPERVISOR_ATTACH_FORBIDDEN
```

This uses the existing Phase 0 coordinator identity mechanism:
- Coordinator calls `claude_connect` → becomes `attachedClaude` (the room's coordinator connection)
- Coordinator (and only coordinator) may then call `supervisor_attach` to promote itself to supervisor sink
- Child processes do NOT call `claude_connect` (established in Phase 2) → they cannot claim supervisor
- If no `attachedClaude` exists (no `claude_connect` called yet) → `SUPERVISOR_ATTACH_FORBIDDEN`

**Phase 4 extension point**: multi-room support will require per-room coordinator tracking. The eligibility rule must become "room-associated coordinator WS" backed by a per-room registry, not daemon-global `attachedClaude`. This is explicitly out of Phase 3 scope.

**Spoofing scope**: The `endpoint` field in `supervisor_attach` is for routing/correlation only. Endpoint string forgery protection is Phase 4. Phase 3 guarantees:
1. **Acquisition legitimacy**: only the room's `attachedClaude` WS can claim supervisor
2. **Release integrity**: only the owning socket (or disconnect) releases the slot

Ownership state per room:
```
'unattached'                       — no supervisor registered
'attached(socket, owner_endpoint)' — socket: WS ref (auth), owner_endpoint: EndpointId (routing)
```

#### Acquisition: explicit, not implicit

Supervisor ownership is established by a dedicated control message, not by being the first connected WS client or by `claude_connect`. This prevents accidental capture by child processes.

```ts
// Client → Daemon
{ type: "supervisor_attach"; requestId: string; endpoint: EndpointId }

// Daemon → Client
{ type: "supervisor_attach_result"; requestId: string; success: boolean; error?: ErrorReceiptPayload }
```

Error codes:
- `SUPERVISOR_ALREADY_ATTACHED` — another client holds supervisor ownership for this room

#### Release and Reassignment

- **Explicit release**: `{ type: "supervisor_detach"; requestId: string }`
- **Implicit release**: supervisor WS socket closes (disconnect); same cleanup as explicit detach
- **Reassignment after release**: any endpoint may attach; `SUPERVISOR_ALREADY_ATTACHED` returned if slot still held
- **Detach idempotency**: `supervisor_detach` when not attached → success (no-op)
- **Reattach by same owner**: treated as new acquisition (requires slot to be unattached first)

#### Buffered Observable Policy

When no supervisor is registered (`state='unattached'`), observables are buffered per-room — not per-socket, not globally:

| Property | Value |
|---|---|
| Scope | Per-room (one buffer per room) |
| Capacity | Max **200 events** |
| Overflow policy | **Drop-oldest** (circular buffer semantics) |
| Lifetime | Buffer cleared on attach-flush or room teardown |
| TTL | No time-based TTL in Phase 3; cleared only by attach or teardown |

The buffer is strictly append-only while `state='unattached'`. Once a supervisor attaches, the buffer is frozen and flushed.

#### Attach Flush Contract

**Hard constraint: the attach flush path MUST be fully synchronous — no `await`, no async emit, no event-loop yield between steps.** Violation of this constraint invalidates the no-duplication guarantee and requires a cutoff/watermark design instead.

Given the synchronous constraint, the flush is atomic from the perspective of the event loop (Bun/Node.js is single-threaded):

1. **Freeze**: set `state='attached'`, store socket+endpoint as owner — synchronously, before any flush.
2. **Flush buffer**: send all buffered events (FIFO order) to new supervisor WS — synchronous `ws.send()` calls only.
3. **Clear buffer**: discard buffer — synchronously.
4. **Return**: attach handler returns. All subsequent `emitToClaude` calls now route to supervisor WS live.

**No-await implementation rule**: `handleSupervisorAttach` must be a plain synchronous function (not `async`). Any `ws.send()` in the flush loop must be fire-and-forget (not awaited). If future work requires async sends, switch to explicit watermark design.

**No duplication guarantee**: Because state='attached' is set synchronously before flush and before returning to the event loop, any observable generated after the handler returns will see `state='attached'` and route live — never to the buffer. The flush path and live path cannot overlap.

**Flush ordering**: buffered events precede any live events the supervisor receives after attach. The supervisor sees a contiguous, ordered stream.

#### Fallback: no supervisor registered

When `state='unattached'`, all observables are appended to the room's bounded circular buffer (max 200, drop-oldest). No event is silently dropped if capacity is not exceeded; oldest events are dropped when capacity is reached.

#### Observable routing rule

| Event type | Routing |
|---|---|
| `lifecycle_ack` | → supervisor sink only |
| `BootstrapAck` | → supervisor sink only |
| `SpawnExitObservable` | → supervisor sink only |
| Error receipts (`error_receipt`) | → supervisor sink only |
| `codex_to_claude` relay messages | → supervisor sink only (existing behavior) |

Non-supervisor connected clients receive only their own `*_result` responses — not global observables.

#### Non-stealable sink

`claude_connect` from a non-supervisor client does NOT claim the supervisor sink. Existing `claude_connect` semantics are preserved for backward compatibility (it attaches the general-purpose `attachedClaude` slot). The supervisor slot is a separate, explicitly managed ownership layer.

Backward-compatibility rule: if no `supervisor_attach` has been called (`state='unattached'`), observables fall back to `attachedClaude` (current behavior). This means Phase 0/1/2 tests continue working without change. The new bounded buffer replaces the existing `bufferedMessages` on the supervisor path only; `attachedClaude` buffering is unchanged.

---

### New Control Messages (Phase 3A)

```ts
// Client → Daemon
| { type: "supervisor_attach"; requestId: string; endpoint: EndpointId }
| { type: "supervisor_detach"; requestId: string }

// Daemon → Client
| { type: "supervisor_attach_result"; requestId: string; success: boolean; error?: ErrorReceiptPayload }
| { type: "supervisor_detach_result"; requestId: string; success: boolean }
```

### New Error Codes (Phase 3A)

| Code | When |
|---|---|
| `SUPERVISOR_ALREADY_ATTACHED` | A supervisor is already registered for this room |
| `SUPERVISOR_ATTACH_FORBIDDEN` | Calling WS is not the `attachedClaude` connection (not the coordinator) |

---

### Phase 3A Implementation Status

- [x] `protocol.ts` — added `SUPERVISOR_ALREADY_ATTACHED`, `SUPERVISOR_ATTACH_FORBIDDEN` to `ErrorReceiptPayload.code`
- [x] `control-protocol.ts` — added `supervisor_attach`, `supervisor_detach` client messages; `supervisor_attach_result`, `supervisor_detach_result` server messages
- [x] `daemon.ts` — supervisor state (`supervisorSocket`, `supervisorEndpoint`, `supervisorEverAttached`, `supervisorBuffer`); `emitObservable`; `handleSupervisorAttach` (synchronous, eligibility gate, atomic flush); `handleSupervisorDetach` (idempotent); `releaseSupervisor`; WS close → implicit release; all observable emitters updated to use `emitObservable`
- [x] Phase 3A integration tests — 8 tests, 30 expect(), all green

### Phase 3A Gates

**Happy path:**
1. Coordinator sends `supervisor_attach` → success; subsequent observables route to coordinator WS
2. Child spawned via `launch_peer` connects with `post_envelope` (no `supervisor_attach`) → does NOT capture observable sink
3. Coordinator sends `supervisor_detach` → sink released; observables buffer until new supervisor attaches
4. New supervisor attaches after detach → buffered observables flushed in order

**Sad path:**
1. Two clients both send `supervisor_attach` → second gets `SUPERVISOR_ALREADY_ATTACHED`
2. Supervisor socket closes → implicit release; observables buffer
3. `supervisor_detach` when not attached → no-op success (idempotent)

---

## Phase 3B — Task/Trigger Orchestration Primitives

> Requires Phase 3A to be complete and green.

### Goals

- Define the minimum event surface for coordinator → worker task assignment.
- Introduce `task_id` correlation so observables can be tied to specific tasks.
- Define macro/micro loop state model (start / tick / complete / timeout observables).
- Connect Phase 2's lifecycle events into the orchestration context.

### Non-Goals

- No complex scheduling strategy (load balancing, priority queues)
- No autonomous scheduler policy
- No fully automatic loop retry / restart
- No UI-layer workflow orchestration

---

### ID Layers

Three distinct ID layers; do not mix:

| Layer | Field | Scope | Producer |
|---|---|---|---|
| Control RPC | `requestId` | One assign_task call | Caller |
| Task correlation | `task_id` | Full task lifetime (trigger → completion) | Coordinator |
| Loop instance | `loop_id` | Single execution run | Worker (at execution start) |

`task_id` is the primary correlation handle between `assign_task` and `LoopEvent` observables. `loop_id` links a specific execution run within a task; absent in daemon-generated events (e.g. timeout with no worker response).

### Task Assignment Contract

```ts
interface TaskAssignment {
  task_id: string;          // stable correlation handle; must be unique among in-flight tasks
  assigned_to: EndpointId;  // target worker endpoint
  role?: string;            // optional metadata only — daemon does NOT validate endpoint/role match
  payload: unknown;         // task body (opaque to daemon)
  timeout_ms?: number;      // optional per-task timeout (async; fires LoopEvent{state:'timeout'})
}

interface TaskAssignmentResult {
  success: boolean;
  task_id: string;
  // success=true: daemon has relayed assignment to worker. NOT a task completion signal.
  // success=false: immediate control-plane rejection (see error codes below).
  error?: ErrorReceiptPayload;
}
```

**assign_task authority**: Only the coordinator WS (`ws === attachedClaude`) may call `assign_task`. Other callers receive `TASK_ASSIGN_FORBIDDEN`. (Same eligibility gate as `supervisor_attach`; authority is from coordinator connection, not supervisor observability role.)

**task_id uniqueness**: Daemon maintains an `activeTasks` registry (`Map<task_id, ActiveTask>`). If a `task_id` is already in-flight when `assign_task` arrives, return `TASK_ID_CONFLICT` immediately. A task exits `activeTasks` when `LoopEvent{state:'completed'|'timeout'|'failed'}` is received from the worker, or when the per-task timeout fires.

Delivered via new control message:
```ts
| { type: "assign_task"; requestId: string; assignment: TaskAssignment }
| { type: "assign_task_result"; requestId: string; result: TaskAssignmentResult }
```

### Loop State Model (minimum event surface)

`idle` is a peer lifecycle status (registry), not a loop event state. Loop events are:

```ts
type LoopState = 'running' | 'completed' | 'timeout' | 'failed';

interface LoopEvent {
  loop_id?: string;         // worker-generated at execution start; absent in daemon-generated events
  task_id: string;          // required: correlation to TaskAssignment
  endpoint: EndpointId;     // worker that owns the loop
  state: LoopState;
  observed_at: number;
  details?: Record<string, unknown>;
}
```

**loop_id producer**: Worker generates `loop_id` when execution actually starts (first `running` event). For daemon-generated timeout events, `loop_id` is absent — `task_id` alone is sufficient for coordinator correlation.

**Timeout path**: When `timeout_ms` fires, daemon emits `LoopEvent{state:'timeout', task_id, endpoint, observed_at}` via supervisor sink (no `loop_id`), removes task from `activeTasks`. This is async — not part of `assign_task_result`.

**Observable relay path**: Worker sends `LoopEvent` as a `post_envelope` work message (intent: `loop_event`). Daemon recognizes the intent and relays via `emitObservable` to supervisor sink.

### Immediate vs Async Error Separation

| Error | Path | When |
|---|---|---|
| `TASK_TARGET_NOT_FOUND` | `assign_task_result` (immediate) | `assigned_to` endpoint not in registry or not routable |
| `TASK_ASSIGN_FORBIDDEN` | `assign_task_result` (immediate) | Calling WS is not coordinator (`attachedClaude`) |
| `TASK_ID_CONFLICT` | `assign_task_result` (immediate) | `task_id` already in-flight in `activeTasks` |
| Timeout | `LoopEvent{state:'timeout'}` (async observable) | Per-task `timeout_ms` fired before completion |

`TASK_TIMEOUT` is NOT an `assign_task_result` error. It is only observable via `LoopEvent.state='timeout'`.

### New Error Codes (Phase 3B)

| Code | When |
|---|---|
| `TASK_TARGET_NOT_FOUND` | Assigned endpoint not in registry or not routable |
| `TASK_ASSIGN_FORBIDDEN` | Calling WS is not the coordinator connection |
| `TASK_ID_CONFLICT` | `task_id` already in-flight |

---

### Phase 3B Implementation Status

- [x] `protocol.ts` — added `TASK_TARGET_NOT_FOUND`, `TASK_ASSIGN_FORBIDDEN`, `TASK_ID_CONFLICT`; `TaskAssignment`, `TaskAssignmentResult`, `LoopState`, `LoopEvent`
- [x] `control-protocol.ts` — added `assign_task` client message; `assign_task_result` server message
- [x] `daemon.ts` — `activeTasks` registry; `handleAssignTask` (authority gate, conflict check, relay, timeout timer); `handleLoopEventIntent` (terminal state cleanup); `failTasksForEndpoint` (worker death → in-flight tasks fail); hooked into `handleChildExit`, stall escalation, `handleTerminatePeer`, and `shutdown`
- [x] Phase 3B integration tests — 8 tests, 26 expect(), all green

### Phase 3B Gates

**Happy path:**
1. Coordinator sends `assign_task` → daemon validates (endpoint routable, task_id not in-flight, caller authorized) → relays TaskAssignment envelope to worker → `TaskAssignmentResult{success:true}` (relay success, not task completion)
2. Worker receives assignment, starts execution, emits `LoopEvent{state:'running', loop_id, task_id}` → coordinator receives via supervisor sink
3. Worker emits `LoopEvent{state:'completed', task_id}` → coordinator receives via supervisor sink; daemon removes `task_id` from `activeTasks`

**Sad path:**
1. `assign_task` to terminated/unknown endpoint → `TASK_TARGET_NOT_FOUND` (immediate)
2. `assign_task` with duplicate in-flight `task_id` → `TASK_ID_CONFLICT` (immediate)
3. `assign_task` from non-coordinator WS → `TASK_ASSIGN_FORBIDDEN` (immediate)
4. Per-task timeout fires → `LoopEvent{state:'timeout', task_id}` observable via supervisor sink; task removed from `activeTasks`

---

## Phase 3 Non-Goals (full set)

- No multi-coordinator per room (Phase 4)
- No cross-room / cross-host (Phase 4+)
- No complex scheduling optimization
- No autonomous scheduler policy
- No fully automatic retry/restart (Phase 4)
- No advanced GC beyond what Phase 2 established
- No UI-layer workflow orchestration

---

## Phase 3 Error Code Registry (full set, Phase 3 additions)

| Code | When |
|---|---|
| `SUPERVISOR_ALREADY_ATTACHED` | Supervisor ownership already held by another client |
| `SUPERVISOR_ATTACH_FORBIDDEN` | Calling WS is not the coordinator (`attachedClaude`) connection |
| `TASK_TARGET_NOT_FOUND` | Task assigned to non-routable or unknown endpoint |
| `TASK_ASSIGN_FORBIDDEN` | Calling WS is not the coordinator connection |
| `TASK_ID_CONFLICT` | `task_id` already in-flight in `activeTasks` |
