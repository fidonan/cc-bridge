# Phase 4 Architecture Checkpoint

> Consensus reached by A (Coordinator) + B (Planner/Critic) on 2026-03-28.
> Phase 4 is fully closed and green (181 tests).
> Baseline: `docs/phase0-3-checkpoint.md`.
> This document is the authoritative baseline for Phase 5+ planning.

---

## Legend

- **`[Contract]`** — Locked decision. Continues to hold in Phase 5+ unless explicitly superseded.
- **`[Scope assumption]`** — Phase 4 implementation choice. Phase 5+ may revisit.

---

## 1. Multi-Room Infrastructure `[Contract]`

Phase 4A dismantled the Phase 3 `attachedClaude` daemon-global singleton.

```ts
interface Room {
  id: string;
  coordinators: Set<ServerWebSocket<ControlSocketData>>;
  supervisorSocket: ServerWebSocket<ControlSocketData> | null;
  supervisorEndpoint: EndpointId | null;
  supervisorEverAttached: boolean;
  supervisorBuffer: BridgeMessage[];
  activeTasks: Map<string, ActiveTask>;
  partitions: Map<string, CoordinatorSlot>;
  partitionMembership: Map<EndpointId, string>;
}
```

- `rooms: Map<string, Room>` — daemon-level registry.
- `claude_connect({ room })` routes a WS into a specific room. Room is created lazily on first connect; GC'd when last coordinator and task are gone (non-default rooms only).
- Default room (`ROOM` env var) is never GC'd.
- One-coordinator-per-room invariant: new `claude_connect` to a room that already has a coordinator closes the old WS.

---

## 2. Partition Ownership Contract `[Contract]`

Phase 4B introduced `supervisor_attach` / `supervisor_detach` with first-writer-wins partition arbitration.

```ts
interface CoordinatorSlot {
  partition_id: string;
  socket: ServerWebSocket<ControlSocketData>; // claim authority (not endpoint)
  endpoint: EndpointId;                        // metadata only
}
```

**Claim rules:**
- Eligibility: calling WS must be in `room.coordinators`.
- First-writer-wins; no preemption in Phase 4B.
- One WS ↔ one partition (rebind requires detach first).
- Claim authority is the WS socket object, NOT `payload.endpoint`.

**Disconnect cleanup (5 steps, atomic):**
1. Release partition slot.
2. Fail all in-flight tasks in the partition (emit `LoopEvent{state:'failed'}`).
3. Clear `partitionMembership` entries for the partition.
4. Emit `room_event{worker_orphaned}` for each now-unbound worker.
5. Workers remain in `peerRegistry`; lifecycle state unchanged.

**Error codes added:**
`SUPERVISOR_PARTITION_CONFLICT`, `COORDINATOR_ALREADY_HAS_PARTITION`, `BIND_NOT_AUTHORIZED`, `BIND_TARGET_NOT_FOUND`, `TASK_NOT_IN_PARTITION`.

---

## 3. Task Assignment Authority `[Contract]`

Phase 4B: `assign_task` is authorized iff:
```
ws ∈ room.coordinators
AND room.partitions[partition_id].socket === ws
AND room.partitionMembership[task.assigned_to] === partition_id
```

Phase 4C-1 added direct worker WS delivery for `assign_task` relay (bypasses file relay when worker has a registered WS connection).

---

## 4. Worker Connect Contract `[Contract]`

Phase 4C-1: Workers may optionally register a direct WS via `worker_connect`:
```ts
{ type: "worker_connect"; requestId: string; endpoint: string }
```
- Requires endpoint pre-registered in `peerRegistry` via `register` envelope.
- One WS ↔ one endpoint invariant enforced.
- Direct WS delivery path is transport-only; partition/authority checks unchanged.
- `emitObservable` fallback used when no WS, WS closed, or send fails.

---

## 5. Task Hand-Off `[Scope assumption]`

**Not implemented in Phase 4.** When a coordinator disconnects, tasks are unconditionally failed. No hand-off. Hand-off is Phase 5+ scope.

---

## 6. Cross-Room Control-Plane Forwarding `[Contract]`

Phase 4D-1 introduced daemon-mediated coordinator-to-coordinator forwarding.

**Routing index:**
```ts
const endpointToRoom = new Map<EndpointId, string>();
```
Written at `register` (value = `ws.data.roomId`). Deleted at all three termination paths (exit, stall escalation, explicit terminate).

**Cross-room send contract:**
- Point-to-point only (`to.length === 1`).
- Requires a live coordinator WS in the target room.
- Delivers directly to coordinator WS via `trySendBridgeMessage`; does NOT write to target room's `messagesDir`.
- Relies on one-coordinator-per-room invariant.
- Forwarded `RelayEnvelope` carries `sender_room` and `target_endpoint` for semantic traceability.

**Error codes added:** `PEER_TERMINATED`, `COORDINATOR_OFFLINE`.

**RelayEnvelope additions:**
```ts
sender_room?: string;     // originating coordinator room
target_endpoint?: string; // explicit destination endpoint
```

---

## 7. Per-Room Relay Filesystem `[Contract]`

Phase 4D-2 replaced module-level relay path constants with a lazy per-room helper:

```ts
function roomRelayPaths(roomId: string) {
  const base = join(STATE_ROOT, roomId);
  return { peersDir: join(base, "peers"), messagesDir: join(base, "messages"), acksDir: join(base, "acks") };
}
```

**Two-class relay participation model:**

| Class | Activation | Deactivation |
|---|---|---|
| Default room (`ROOM`) | Daemon startup (always active) | Never |
| Non-default rooms | First `claude_connect` for that room | Last coordinator disconnects |

**Relay active rooms registry:**
```ts
const relayActiveRooms = new Set<string>([ROOM]); // seeded with default room at startup
const roomKnownPeers = new Map<string, string[]>([[ROOM, []]]);
```

**Activation priming** (`activateRelayRoom`): synchronously calls `ensureRelayDirs + writeHeartbeat + refreshPeers + pollMessages + janitorMessages` to avoid first-send empty-cache race.

**Timer loops** iterate `relayActiveRooms`:
```ts
for (const r of relayActiveRooms) { writeHeartbeat(r); refreshPeers(r); }
for (const r of relayActiveRooms) { pollMessages(r); janitorMessages(r); }
```

**`refreshPeers` edge detection** for non-default rooms: captures `prevPeerCount` before updating `roomKnownPeers`, emits `peer_joined` / `peer_left` only on 0→N or N→0 transitions.

---

## 8. Observable Routing `[Contract]`

Phase 4B: Two routing tiers:
- **Worker-sourced events**: route to coordinator whose partition contains the source endpoint.
- **Room/system events**: broadcast to all WS in `room.coordinators`.
- **Unbound worker events** (not in `partitionMembership`): broadcast to all room coordinators.

Phase 4D-1: Cross-room forwarded messages bypass `emitObservable`/`supervisorBuffer`; delivered directly to coordinator WS.

---

## 9. Backward Compatibility `[Contract]`

All Phase 0–3 tests (61 tests) remain green throughout Phase 4.

- `claude_connect` without `room` → defaults to `ROOM` (env-configured default room).
- `supervisor_attach` without `partition_id` → treated as claiming partition `"default"`.
- Phase 3 single-room topology continues to work without change.

---

## 10. Test Coverage Summary

| Phase | Test File | Count |
|---|---|---|
| Phase 1 handlers | `phase1-handlers.test.ts` | 17 |
| Phase 1 integration | `phase1-integration.test.ts` | 9 |
| Phase 2 integration | `phase2-integration.test.ts` | 8 |
| Phase 3A integration | `phase3a-integration.test.ts` | 8 |
| Phase 3B integration | `phase3b-integration.test.ts` | 11 |
| Phase 4B integration | `phase4b-integration.test.ts` | 11 |
| Phase 4C integration | `phase4c-integration.test.ts` | 7 |
| Phase 4C-2 integration | `phase4c2-integration.test.ts` | 7 |
| Phase 4C-3 integration | `phase4c3-integration.test.ts` | 6 |
| Phase 4D-1 integration | `phase4d1-integration.test.ts` | 6 |
| Phase 4D-2 integration | `phase4d2-integration.test.ts` | 6 |
| 4-window routing | `integration-4window.test.ts` | 5 |
| Relay routing | `relay-routing.test.ts` | 13 |
| Dual-mode transport | `dual-mode.test.ts` | 17 |
| Message filter | `message-filter.test.ts` | 10 |
| Codex adapter | `codex-adapter.test.ts` | 9 |
| TUI connection state | `tui-connection-state.test.ts` | 9 |
| Window launcher | `window-launcher.test.ts` | 5 |
| Hardening | `hardening.test.ts` | 6 |
| Role patterns | `role-patterns.test.ts` | 5 |
| **Total** | **20 files** | **181** |

---

## 11. Open Items (non-blocking for Phase 4 close)

- Task hand-off on coordinator disconnect (Phase 5+).
- Preemptive partition takeover (Phase 5+).
- `claude_connect` rename to `join_room` (Phase 5+).
- Per-coordinator-slot supervisor buffer (Phase 5+; current supervisorBuffer is room-level).
- Cross-room broadcast (Phase 4D-1 is point-to-point only; broadcast is Phase 5+).
