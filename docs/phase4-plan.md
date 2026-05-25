# Phase 4 Plan — Multi-Room & Multi-Coordinator

> Consensus reached by A (Coordinator) + B (Planner/Critic) on 2026-03-28.
> Supersedes Phase 3, which is fully closed and green.
> Baseline: `docs/phase0-3-checkpoint.md`.

---

## Structure

Phase 4 is split into three sequential sub-phases:

- **Phase 4A**: Multi-room infrastructure (per-room state, room lifecycle, `claude_connect` room field)
- **Phase 4B**: Multi-coordinator ownership & arbitration contract (prerequisite for scheduling)
- **Phase 4C**: Richer task routing (direct worker-WS delivery, task hand-off, load-aware assignment)

Phase 4C requires Phase 4B to be complete and green.

---

## Phase 4A — Multi-Room Infrastructure

### Goals

- Replace daemon-global singletons with a per-room `Room` object.
- `claude_connect` gains a required `room` field to route WS connections to specific rooms.
- All Phase 3 handlers become room-scoped (`handleX(room, ...)`).

### Non-Goals

- Multi-coordinator: deferred to 4B.
- Cross-room routing: deferred to 4C+.

### Core change: `Room` struct

```ts
interface Room {
  id: RoomId;
  // Coordinator candidates (have called claude_connect for this room):
  coordinators: Set<ServerWebSocket<ControlSocketData>>;
  // Phase 3 per-room equivalents:
  supervisorSocket: ServerWebSocket<ControlSocketData> | null;  // → replaced by partitions in 4B
  supervisorEverAttached: boolean;
  supervisorBuffer: BridgeMessage[];  // Phase 4A: room-level (same topology as Phase 3); per-slot buffer is Phase 4B+ deferred
  activeTasks: Map<string, ActiveTask>;
  peers: Map<EndpointId, PeerEntry>;
  // Phase 4B additions (see below):
  partitions: Map<string, CoordinatorSlot>;        // partition_id → CoordinatorSlot
  partitionMembership: Map<EndpointId, string>;    // worker endpoint → partition_id
}
```

Daemon maintains `rooms: Map<RoomId, Room>`. A room is created on first `claude_connect({ room })` and GC'd when the last coordinator and peer disconnect.

### `claude_connect` semantics (Phase 4A)

```ts
// Phase 3: { type: "claude_connect" }
// Phase 4A:
{ type: "claude_connect"; room: RoomId }
```

- Registers WS as a coordinator candidate in `room.coordinators`.
- Multiple WS may call `claude_connect({ room })` for the same room (multi-coordinator supported in 4B).
- Does NOT automatically claim a supervisor partition — must call `supervisor_attach` explicitly.
- On WS disconnect: removed from `room.coordinators`; see Phase 4B cleanup for partition consequences.
- `attachedClaude` daemon-global singleton is replaced by `room.coordinators` set.

### Phase 4A Non-Goals Recap

- `claude_connect` is NOT renamed in Phase 4A. Renaming to `join_room` or similar is Phase 5+ if desired.
- Cross-room message routing is not addressed.

---

## Phase 4B — Multi-Coordinator Ownership & Arbitration Contract

> Requires Phase 4A to be complete and green.
> **Arbitration model is locked before any richer scheduling. No implementation may proceed without this contract.**

### Goals

- Define a stable, per-room partition ownership model supporting N coordinators.
- Ground `assign_task` and `bind_worker` authority in daemon-maintained partition state.
- Define explicit cleanup semantics for coordinator disconnect.

### Non-Goals

- Task hand-off between coordinators on disconnect (Phase 4C+).
- Preemptive partition takeover (Phase 4C+).
- Load balancing / priority queues.
- Autonomous scheduler policy.

---

### Coordinator Admission

**Gate**: WS must have called `claude_connect({ room })` for the target room.

```
room.coordinators = { ws | ws has called claude_connect({ room: R }) }
supervisor_attach eligibility = ws ∈ room.coordinators
```

Workers do NOT call `claude_connect`. Spawned children only call `register`. The admission ritual therefore naturally excludes workers without a separate ACL layer.

This replaces Phase 3's `ws === attachedClaude` (daemon-global) with `ws ∈ room.coordinators` (per-room set).

---

### Partition Claim Contract

```ts
// Coordinator → Daemon
{ type: "supervisor_attach"; requestId: string; room: RoomId; partition_id: string; endpoint: EndpointId }

// Daemon → Coordinator
{ type: "supervisor_attach_result"; requestId: string; success: boolean; error?: ErrorReceiptPayload }
```

> **`endpoint` field**: Coordinator identity metadata / routing label only. Claim authority is always determined by the calling WS socket object — NOT by `payload.endpoint`. A mismatched or spoofed endpoint field does not grant or affect claim ownership.

#### Claim rules

| Rule | Value |
|---|---|
| Acquisition | First-writer-wins: first eligible WS to call `supervisor_attach` with this `partition_id` claims it |
| Conflict | `partition_id` already held by another WS → `SUPERVISOR_PARTITION_CONFLICT` (no preemption) |
| Eligibility | Caller WS must be in `room.coordinators` |
| Cardinality (Phase 4B) | One WS ↔ one partition; a WS that already holds a partition must detach before claiming another |
| Release — explicit | `supervisor_detach({ room, partition_id })` by owning WS → atomic release (see cleanup below) |
| Release — implicit | Owning WS disconnects → same atomic cleanup path as explicit detach |
| Reuse | Released `partition_id` can be claimed by any eligible WS immediately after release |

#### CoordinatorSlot struct

```ts
interface CoordinatorSlot {
  partition_id: string;       // unique per room
  socket: ServerWebSocket;    // auth identity (claim authority)
  endpoint: EndpointId;       // routing/correlation identity (metadata only)
}
```

#### New error codes (Phase 4B)

| Code | When |
|---|---|
| `SUPERVISOR_PARTITION_CONFLICT` | `partition_id` already held by another WS |
| `COORDINATOR_ALREADY_HAS_PARTITION` | Calling WS already holds a partition (Phase 4B one-per-WS limit) |
| `BIND_NOT_AUTHORIZED` | Caller does not hold the named partition |
| `BIND_TARGET_NOT_FOUND` | Endpoint not in peer registry |
| `TASK_NOT_IN_PARTITION` | Task assigned to worker not in caller's partition |

---

### Worker Binding Contract

```ts
// Coordinator → Daemon
{ type: "bind_worker"; requestId: string; partition_id: string; endpoint: EndpointId }

// Daemon → Coordinator
{ type: "bind_worker_result"; requestId: string; success: boolean; error?: ErrorReceiptPayload }
```

- Worker `register` envelope is unchanged: workers declare only facts (endpoint, role, model, workdir). **No `partition_id` in register.**
- Only the coordinator WS holding `partition_id` may call `bind_worker` for that partition.
- A worker may belong to at most one partition at a time; rebind replaces previous binding.
- Worker membership does NOT survive coordinator disconnect (see cleanup below).

Daemon maintains per-room:
```
room.partitionMembership: Map<EndpointId, partition_id>
```

`TASK_NOT_IN_PARTITION` is grounded in this daemon-maintained map, not self-assertion.

---

### Task Assignment Authority

`assign_task` authority rule (Phase 4B):

```
assign_task(task) is authorized iff:
  ws ∈ room.coordinators
  AND room.partitions[partition_id].socket === ws  (caller holds a partition)
  AND room.partitionMembership[task.assigned_to] === partition_id  (target worker is in caller's partition)
```

Violations:
- `TASK_ASSIGN_FORBIDDEN` — caller WS is not a room coordinator
- `TASK_NOT_IN_PARTITION` — target worker not bound to caller's partition

---

### Coordinator Disconnect → Full Ownership Cleanup

When a coordinator WS disconnects OR calls `supervisor_detach`, the following steps execute **atomically in this order**:

1. **Release partition slot**: remove `room.partitions[partition_id]`
2. **Fail in-flight tasks**: for every `task_id` in `activeTasks` owned by this partition:
   - `removeActiveTask(task_id)` (clearTimeout + delete)
   - emit `LoopEvent { state: 'failed', task_id, endpoint: assigned_to, observed_at, details: { reason: 'coordinator_disconnected' } }` to all room coordinators
3. **Clear worker bindings**: remove all entries from `partitionMembership` where value === `partition_id`
4. **Emit room events**: for each now-unbound worker, emit `room_event { event: 'worker_orphaned', endpoint }` to all room coordinators
5. **Workers remain in peer registry**: lifecycle state unchanged; workers continue heartbeating; they are unrouted until explicitly rebound or terminated

**No task ownership survives coordinator disconnect.** A task owned by the disconnecting coordinator's partition is unconditionally failed. No task hand-off in Phase 4B — that is Phase 4C+.

This follows the same pattern as Phase 3's `failTasksForEndpoint` but scoped to partition.

---

### Observable Routing (Phase 4B)

Two routing tiers:

| Event scope | Routing |
|---|---|
| Worker-sourced events (`LoopEvent`, `BootstrapAck`, `lifecycle_ack`, `SpawnExitObservable`) | Route to coordinator whose partition contains the source endpoint (`room.partitionMembership[endpoint]`) |
| Room/system events (`room_event` — including `worker_orphaned`, `partition_released`, coordinator join/leave) | Broadcast to all WS in `room.coordinators` |

**Unbound worker events** (worker not in `partitionMembership`): broadcast to all room coordinators until bound.

New observable type:
```ts
interface RoomEvent {
  type: "room_event";
  event: "partition_released" | "worker_orphaned" | "coordinator_joined" | "coordinator_left";
  room: RoomId;
  endpoint?: EndpointId;       // affected worker (for worker_orphaned)
  partition_id?: string;       // affected partition (for partition_released)
  observed_at: number;
}
```

---

### Backward Compatibility

Phase 4A/4B must preserve Phase 0–3 test behavior:

- `claude_connect` without `room` field: daemon assigns to a default room (e.g., `"default"`), preserving Phase 3 single-room behavior.
- `supervisor_attach` without `partition_id` (Phase 3 call shape): treated as claiming partition `"default"` within the room.
- Phase 3 tests (61 tests) must remain green throughout Phase 4 implementation.

---

## Phase 4C — Richer Task Routing

> Requires Phase 4B to be complete and green.

### Goals

- Direct worker-WS delivery for `assign_task` relay (currently via `emitObservable`).
- Task hand-off: when coordinator disconnects, option to reassign orphaned tasks to another coordinator (explicit policy, not automatic).
- Load-aware assignment hints (advisory, not enforced by daemon).

### Non-Goals

- Autonomous scheduler policy.
- Cross-host routing.
- Priority queues.

---

## Phase 4 Error Code Registry (additions)

| Code | Phase | When |
|---|---|---|
| `SUPERVISOR_PARTITION_CONFLICT` | 4B | `partition_id` already held by another WS |
| `COORDINATOR_ALREADY_HAS_PARTITION` | 4B | Calling WS already holds a partition |
| `BIND_NOT_AUTHORIZED` | 4B | Caller does not hold the named partition |
| `BIND_TARGET_NOT_FOUND` | 4B | Endpoint not in peer registry |
| `TASK_NOT_IN_PARTITION` | 4B | Target worker not in caller's partition |

---

## Phase 4 Entry Points (dismantling Phase 3 scope assumptions)

| Phase 3 assumption | Phase 4 replacement |
|---|---|
| `attachedClaude` daemon-global singleton | `room.coordinators` per-room set |
| `supervisor_attach` eligibility: `ws === attachedClaude` | `ws ∈ room.coordinators` |
| `activeTasks` daemon-global map | `room.activeTasks` per-room map |
| `supervisorBuffer` single daemon-level buffer | Per-room buffer in Phase 4A; per-coordinator-slot buffer is Phase 4B+ (when `CoordinatorSlot` gains buffer + flush/replay/cleanup contract) |
| Single room per daemon | `rooms: Map<RoomId, Room>` |
| Multi-coordinator: not supported | N coordinators per room via partition model |

---

## Open Items (non-blocking for Phase 4A/4B planning)

- Race condition hardening test: timeout timer fires simultaneously with worker termination (Phase 3 carry-forward)
- Cross-room routing (Phase 4C+)
- Task hand-off policy on coordinator disconnect (Phase 4C)
- Preemptive partition takeover (Phase 4C+)
- `claude_connect` rename to `join_room` (Phase 5+)
