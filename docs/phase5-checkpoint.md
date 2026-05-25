# Phase 5 Architecture Checkpoint

> Consensus reached by A (Coordinator) + B (Planner/Critic) on 2026-03-28.
> Phase 5 builds on the Phase 4 baseline (`docs/phase4-checkpoint.md`).

---

## Legend

- **`[Contract]`** — Locked decision. Continues to hold in Phase 6+ unless explicitly superseded.
- **`[Scope assumption]`** — Phase 5 implementation choice. Phase 6+ may revisit.

---

## 1. Phase 5A — Global Peer Discovery `[Contract]`

Extended `query_registry` RPC with per-peer `room` field. No new daemon RPC.

**Change to `PeerSnapshotEntry`:**
```ts
export interface PeerSnapshotEntry extends PeerMetadata {
  active_task_count: number;
  room?: string; // Phase 5A: room this endpoint registered from (undefined if not yet in endpointToRoom)
}
```

**Daemon change (`handleQueryRegistry`):**
```ts
const room = endpointToRoom.get(meta.endpoint);
return { ...meta, active_task_count: count, ...(room ? { room } : {}) };
```

**MCP layer (`ClaudeAdapter`):**
- Added `list_all_peers` tool — calls `queryRegistry()` via `RegistryReader` callback, formats per-peer summary with `endpoint`, `status`, `role`, `room`, `tasks`.
- `setRegistryReader(reader: RegistryReader)` added to `ClaudeAdapter`.

**Key constraint:** `room` is `undefined` for peers not yet in `endpointToRoom` (pre-register state). Consumers must handle absence.

---

## 2. Phase 5B — Cross-Room Broadcast `[Contract]`

Added `scope?: "room" | "global"` to `post_message` control message.

**Control protocol changes:**
```ts
| { type: "post_message"; ...; scope?: "room" | "global" }

| {
    type: "post_message_result";
    ...
    delivered_rooms?: string[];  // rooms that received the broadcast
    skipped_rooms?: string[];    // rooms with no live coordinator (skipped)
  }
```

**Routing rules:**
- `scope` absent / `"room"` → existing `postPeerMessage` (room-scoped, unchanged).
- `scope === "global"` → `broadcastGlobal`:
  - Iterates `relayActiveRooms`.
  - Default room (`ROOM`) → `emitToClaude` (preserves supervisorBuffer semantics).
  - Non-default rooms → fan out to ALL live WS in `room.coordinators`.
  - Returns `{ delivered_rooms, skipped_rooms }`.
- `success = delivered_rooms.length > 0 || skipped_rooms.length === 0`.

**MCP layer:**
- `reply` tool gains optional `scope` param (`"room"` | `"global"`).
- Result text includes `delivered_rooms` and `skipped_rooms` when present.

---

## 3. Phase 5C — Bootstrap Room Routing `[Contract]`

Allows a coordinator to launch a peer into a specific (non-default) room.

**`LaunchPeerTarget` extension:**
```ts
export interface LaunchPeerTarget {
  endpoint: string;
  role?: string;
  profile?: string;
  workdir?: string;
  bootstrap_message?: string;
  target_room?: string; // Phase 5C: override the room the peer should join
}
```

**`renderTemplate` values — new key:**
- `target_room` — resolved from `target.targetRoom ?? room` (falls back to caller's room).

**Bootstrap message routing:**
- `enqueueBootstrapMessage` uses `targetRoom` (not caller's room) as the relay directory.
- Message written to `<STATE_DIR>/<targetRoom>/messages/`.

**`launch-claude-peer.sh` change:**
- Accepts arg 5 `[target_room]`.
- If non-empty, injects `CC_BRIDGE_ROOM=<target_room>` before launching Claude.
- The launched peer's daemon defaults to `target_room`, so `claude_connect` routes correctly.

**MCP schema:**
- `peer_targets[].target_room` field exposed in `launch_peers` tool.

---

## 4. Test Coverage

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
| Phase 5 integration | `phase5-integration.test.ts` | 6 |
| 4-window routing | `integration-4window.test.ts` | 5 |
| Relay routing | `relay-routing.test.ts` | 13 |
| Dual-mode transport | `dual-mode.test.ts` | 17 |
| Message filter | `message-filter.test.ts` | 10 |
| Codex adapter | `codex-adapter.test.ts` | 9 |
| TUI connection state | `tui-connection-state.test.ts` | 9 |
| Window launcher | `window-launcher.test.ts` | 5 |
| Hardening | `hardening.test.ts` | 6 |
| Role patterns | `role-patterns.test.ts` | 5 |
| **Total** | **21 files** | **187** |

---

## 5. Open Items (non-blocking for Phase 5 close)

- Task hand-off on coordinator disconnect (Phase 6+).
- Preemptive partition takeover (Phase 6+).
- `claude_connect` rename to `join_room` (Phase 6+).
- Per-coordinator-slot supervisor buffer (Phase 6+).
- Global broadcast deduplication across rooms sharing message IDs (Phase 6+).
