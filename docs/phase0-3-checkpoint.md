# Phase 0–3 Architecture Checkpoint

> Consensus reached by A (Coordinator) + B (Planner/Critic) on 2026-03-27.
> This document captures all locked contracts, constraints, and architectural decisions
> from Phase 0 through Phase 3B. It is the authoritative baseline for Phase 4 planning.

## Legend

- **`[Contract]`** — Locked decision. Continues to hold in Phase 4 unless explicitly superseded.
- **`[Scope assumption]`** — Phase 3 implementation choice. Phase 4 must revisit and likely dismantle.

---

## 1. Scope Constraint `[Scope assumption]`

**One daemon instance = one room.**

In Phase 3, `attachedClaude` (the WS that called `claude_connect`) IS the room-associated
coordinator connection. Daemon-global and room-scoped are equivalent in Phase 3.

**Phase 4 must dismantle**: multi-room requires per-room coordinator tracking. The
`attachedClaude` daemon-global assumption must be replaced with a per-room registry.

---

## 2. Peer Registry & Lifecycle States

### LifecycleStatus

```
launching → connected → bootstrapped → idle / busy → stalled → terminated
```

| Transition | Trigger |
|---|---|
| `launching` | `launch_peer` pre-allocates endpoint |
| `connected` | Child sends `register` envelope |
| `bootstrapped` | Child sends `bootstrap_ack` |
| `idle` / `busy` | Heartbeat payload |
| `stalled` | No heartbeat for `PEER_STALE_MS` |
| `terminated` | Process exit / `terminate_peer` / stall escalation |

### bootstrap_state

| Value | Meaning |
|---|---|
| `pending` | Registered, waiting for bootstrap_ack |
| `acked` | bootstrap_ack received before any exit |
| `timeout` | BOOTSTRAP_TIMEOUT_MS fired before ack |
| `failed` | Child exited before bootstrap_ack (spawn ok, exit early) |

`'failed'` is NOT applied retroactively after `'acked'`. Spawn failures don't create registry entries.

### Stall Escalation

`STALL_ESCALATION_MS` timer starts on `stalled`. Callback re-reads state before acting (no-op if recovered). Recovery clears the timer.

---

## 3. Supervisor Ownership Contract `[Contract]` (eligibility gate is `[Scope assumption]`)

### Identity Layers

| Layer | Bound to | Purpose |
|---|---|---|
| Auth identity | WS socket object | Only the acquiring socket may detach |
| Routing identity | `supervisor_attach.endpoint` (EndpointId) | Observable tagging, task correlation |

### Eligibility Gate (Phase 3)

Only `attachedClaude` WS (the coordinator, via `claude_connect`) may call `supervisor_attach`.
All other WS → `SUPERVISOR_ATTACH_FORBIDDEN`.

### Ownership State Machine

```
'unattached'
    │ supervisor_attach (from attachedClaude WS)
    ▼
'attached(socket, owner_endpoint)'
    │ supervisor_detach (same socket) OR socket close
    ▼
'unattached'
```

- Explicit detach is idempotent (non-owning socket → success, no-op)
- Socket close triggers implicit release (same as explicit detach)
- `supervisorEverAttached` flag persists across detach cycles

### Backward Compatibility

If `supervisor_attach` has never been called (`supervisorEverAttached = false`), observables
fall back to `attachedClaude` (Phase 0/1/2 behavior). Phase 0–2 tests continue working without change.

---

## 4. Observable Routing `[Contract]` (single-supervisor per room is `[Scope assumption]`)

All observables route through a single `emitObservable(message)` function with three paths:

| Condition | Routing |
|---|---|
| `supervisorSocket !== null && WS open` | Live push to supervisor WS |
| `supervisorEverAttached === false` | Backward compat: push to `attachedClaude` (or `bufferedMessages`) |
| `supervisorEverAttached === true`, supervisor detached | Buffer in `supervisorBuffer` (max 200, drop-oldest) |

### Observable Types → Supervisor Sink

| Event | Emitter |
|---|---|
| `lifecycle_ack` | `emitLifecycleAck` |
| `BootstrapAck` | `emitBootstrapAck` |
| `SpawnExitObservable` | `emitSpawnExitObservable` |
| Error receipts | `emitObservable` directly |
| Relay messages (`post_envelope` non-control) | `emitObservable` |
| `LoopEvent` | `emitLoopEvent` |

### Supervisor Buffer Flush Contract

**Hard constraint: attach flush path is fully synchronous (no `await`)**. Steps:

1. Freeze: set `state='attached'`, store socket+endpoint — synchronously
2. Flush: send all buffered events (FIFO) via synchronous `ws.send()`
3. Clear: discard buffer — synchronously
4. Return: handler exits; subsequent observables route live

No duplicate delivery: single-threaded event loop guarantees atomic state transition.

---

## 5. ID Layers

Three distinct ID layers — do not mix:

| Layer | Field | Scope | Producer |
|---|---|---|---|
| Control RPC | `requestId` | One control call | Caller |
| Task correlation | `task_id` | Full task lifetime | Coordinator |
| Loop instance | `loop_id` | Single execution run | Worker (at execution start) |

`task_id` is the primary correlation handle between `assign_task` and `LoopEvent` observables.
`loop_id` is absent in daemon-generated events (timeout, worker_terminated).

---

## 6. Task/Loop Contract `[Contract]`

### Layering

| Layer | Messages | Meaning |
|---|---|---|
| Trigger / control plane | `assign_task` / `assign_task_result` | "Relay succeeded" — NOT task completion |
| Execution observability | `LoopEvent` via supervisor sink | Worker execution state transitions |

`assign_task_result.success = true` means daemon relayed assignment to worker. It does not
mean the task has started or will complete.

### assign_task Authority

Only the coordinator WS (`ws === attachedClaude`) may call `assign_task`.
Non-coordinator → `TASK_ASSIGN_FORBIDDEN`.

### LoopState

```ts
type LoopState = 'running' | 'completed' | 'timeout' | 'failed';
```

`idle` is a peer lifecycle status (registry), NOT a loop event state.

### activeTasks Lifecycle

```
assign_task (success)
    → activeTasks.set(task_id, {assigned_to, timeoutTimer})

Terminal events (any one):
  LoopEvent{state:'completed'|'timeout'|'failed'} from worker
  OR: per-task timeout timer fires (daemon emits LoopEvent{state:'timeout'})
  OR: worker terminated/crashed/stall-escalated (daemon emits LoopEvent{state:'failed'})
    → removeActiveTask(task_id)   // clearTimeout + activeTasks.delete
    → emitLoopEvent(...)
```

**Single-winner rule**: `removeActiveTask` deletes the entry first. Concurrent paths (timeout
timer vs worker death) check `activeTasks.get(task_id)` and no-op if already removed.
Single-threaded event loop makes this safe without explicit locks.

### Worker Death → Task Cleanup

`failTasksForEndpoint(endpoint)` is called from:
- `handleChildExit` (process exit / crash)
- Stall escalation timer callback
- `handleTerminatePeer` (explicit termination)
- `shutdown` (daemon exit)

Emits `LoopEvent{state:'failed', details:{reason:'worker_terminated'}}`, no `loop_id`.

---

## 7. Control Message Authority Matrix `[Contract]` (eligibility rules are `[Scope assumption]`)

### Control caller authority

| Message | Authorized caller | Error if unauthorized |
|---|---|---|
| `claude_connect` | Any WS | — (replaces previous) |
| `supervisor_attach` | `attachedClaude` WS only | `SUPERVISOR_ATTACH_FORBIDDEN` |
| `supervisor_detach` | Any WS (idempotent) | — |
| `launch_peer` | Any WS | — |
| `terminate_peer` | Any WS | — |
| `assign_task` | `attachedClaude` WS only | `TASK_ASSIGN_FORBIDDEN` |
| `query_registry` | Any WS | — |
| `post_envelope` | Any WS | — |

### Producer / sink / control-caller distinction

| Role | Who | Notes |
|---|---|---|
| **Event producer** | Worker peer (via `post_envelope` / process lifecycle) | Generates `lifecycle_ack`, `BootstrapAck`, `LoopEvent`, etc. |
| **Daemon-generated events** | Daemon | Timeout, worker_terminated `LoopEvent`; `SpawnExitObservable` |
| **Observable sink** | Supervisor WS (coordinator, via `supervisor_attach`) | Receives all observables; exclusive |
| **Control caller** | Coordinator WS (`attachedClaude`) | `supervisor_attach`, `assign_task`, `launch_peer`, etc. |

In Phase 3: observable sink = control caller = `attachedClaude` WS (same socket).
**Phase 4**: these roles may diverge (multiple coordinators; separate sink vs caller identity).

---

## 8. Error Code Registry (Phase 0–3)

| Code | Phase | When |
|---|---|---|
| `MISSING_FIELD` | 0 | Required envelope field absent |
| `INVALID_FORMAT` | 0 | Envelope field wrong type/format |
| `ROLE_NOT_FOUND` | 0 | No peer registered with requested role |
| `ROLE_AMBIGUOUS` | 0 | Multiple peers match requested role |
| `WORKDIR_INVALID` | 0 | Workdir does not exist or not absolute |
| `ENDPOINT_NOT_FOUND` | 0 | Endpoint not in peer registry |
| `BOOTSTRAP_TIMEOUT` | 1 | bootstrap_ack received after timeout |
| `BOOTSTRAP_DUPLICATE_ACK` | 1 | bootstrap_ack received twice |
| `SPAWN_FAILED` | 2 | Child process failed to start |
| `TERMINATE_FAILED` | 2 | Signal delivery failed |
| `SUPERVISOR_ALREADY_ATTACHED` | 3A | Another client holds supervisor slot |
| `SUPERVISOR_ATTACH_FORBIDDEN` | 3A | Caller is not coordinator WS |
| `TASK_TARGET_NOT_FOUND` | 3B | Assigned endpoint not routable |
| `TASK_ASSIGN_FORBIDDEN` | 3B | Caller is not coordinator WS |
| `TASK_ID_CONFLICT` | 3B | task_id already in-flight |

---

## 9. Test Coverage Summary

| File | Tests | Expects | Scope |
|---|---|---|---|
| `phase1-handlers.test.ts` | 29 | — | Unit: envelope validation, routing, bootstrap |
| `phase1-integration.test.ts` | 4 | — | Integration: launch, register, bootstrap, routing |
| `phase2-integration.test.ts` | 8 | — | Integration: real spawn, termination, escalation |
| `phase3a-integration.test.ts` | 8 | — | Integration: supervisor attach/detach/buffer/flush |
| `phase3b-integration.test.ts` | 8 | — | Integration: assign_task, loop_event, task lifecycle |
| **Total** | **61** | **177** | **Phase 0–3** |

---

## 10. Phase Boundaries / Non-Goals Recap

What each phase solved and intentionally did NOT solve:

| Phase | Solved | Intentionally deferred |
|---|---|---|
| 0 | Envelope validation, peer registry, heartbeat/stall detection | Spawn, termination, routing beyond broadcast |
| 1 | `launch_peer` (endpoint pre-allocation), semantic role routing, bootstrap handshake | Real process spawn, task orchestration |
| 2 | Real process spawn (`CC_BRIDGE_SPAWN_COMMAND`), lifecycle tracking, SIGTERM/SIGKILL termination, stall escalation | Supervisor model, task assignment |
| 3A | Supervisor attachment contract, observable routing to supervisor sink, buffering | Multi-coordinator, cross-room, task orchestration |
| 3B | Task/trigger control plane (`assign_task`), loop execution observability (`LoopEvent`), `activeTasks` lifecycle | Advanced scheduling, retry/restart, autonomous policy |

**Still not implemented (as of Phase 3):**
- Multi-coordinator per room
- Multi-room / cross-host routing
- Complex scheduling (load balancing, priority queues)
- Autonomous scheduler / retry / restart policy
- Advanced GC / registry compaction
- Direct worker-WS targeting for task relay (currently via `emitObservable`)
- UI-layer workflow orchestration

---

## 11. Carry-Forward Risks & Extension Points

| Item | Risk / Action |
|---|---|
| `attachedClaude` daemon-global | Must be replaced with per-room coordinator registry in Phase 4 |
| Supervisor eligibility (`ws === attachedClaude`) | Must become per-room WS check in Phase 4 |
| `activeTasks` daemon-global map | Must become per-room task registry in Phase 4 |
| `supervisorBuffer` single buffer | Must become per-room buffer in Phase 4 |
| Single-room assumption | All Phase 3 contracts assume 1 room per daemon; Phase 4 dismantles this |
| Race: task timeout + worker death simultaneously | Tested separately; simultaneous-firing explicit test is a hardening item |
| Task relay via `emitObservable` | Current relay sends TaskAssignment to supervisor sink (coordinator sees it); Phase 4 should add direct worker-WS delivery |
| Multi-coordinator ownership/arbitration | Phase 4: must lock arbitration contract before richer scheduling (no "any coordinator supervises everything") |

---

## 12. Phase 4 Entry Constraints

Before Phase 4 planning, the following Phase 3 assumptions must be revisited:

| Assumption | Phase 3 value | Phase 4 change needed |
|---|---|---|
| Rooms per daemon | 1 | N rooms per daemon |
| `attachedClaude` | Daemon-global singleton | Per-room coordinator registry |
| Supervisor eligibility | `ws === attachedClaude` | Per-room coordinator WS check |
| `activeTasks` | Daemon-global map | Per-room task registry |
| `supervisorBuffer` | Single daemon-level buffer | Per-room buffer |
| Multi-coordinator | Not supported | Phase 4 goal |

**Arbitration-first rule (hard constraint for Phase 4)**:

Multi-coordinator support requires a locked ownership/arbitration contract **before** any implementation begins. Specifically:

1. **Define arbitration model first**: Must decide whether multiple coordinators share a room or each owns a partition — before allowing multiple WS connections to call `supervisor_attach` or `assign_task` within the same room.
2. **No "any coordinator supervises everything"**: An open-subscription model where every coordinator receives all observables is explicitly prohibited until the arbitration boundary is specified. Fanout policy must be derived from the ownership model.
3. **Acquire/preempt/queue semantics must be explicit**: Phase 4 must choose one: (a) first-claim exclusive lock, (b) arbitrated handoff, or (c) per-domain partitioning. Mixing these ad hoc is not permitted.
4. **Authority matrix is derived, not assumed**: Per-room `assign_task` authority must follow from the arbitration model. Phase 4 cannot expand `assign_task` callers without first establishing the authority derivation.

**Known pending items (non-blocking for Phase 4 planning)**:
- Race condition test: timeout timer fires simultaneously with worker termination
- Direct worker-WS targeting for `assign_task` relay (currently via `emitObservable`)
