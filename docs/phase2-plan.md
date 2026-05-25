# Phase 2 Plan — Process Lifecycle & Termination

> Consensus reached by A (Coordinator) + B (Planner/Critic) on 2026-03-27.
> Supersedes Phase 1, which is fully closed and green.

---

## Goals

- **Real process spawn**: `launch_peer` transitions from endpoint pre-allocation to actual child process spawn. Coordinator receives a spawn result (success or structured failure) before the child registers.
- **Spawn contract**: `bootstrap_message` and peer identity (endpoint, role, workdir) are reliably passed to the child process via environment variables or CLI flags at spawn time.
- **Termination lifecycle**: Peers can be explicitly terminated via `terminate_peer`. Peer process exit is directly observed and drives the `terminated` state transition, distinct from heartbeat-based stall detection.
- **Stalled → terminated escalation**: `stalled` peers escalate to `terminated` after a configurable escalation timer, completing the lifecycle state machine.

## Non-Goals

- No macro/micro loop scheduler (Phase 3)
- No task orchestration policy (Phase 3)
- No multi-room / multi-host routing (Phase 3+)
- No advanced registry GC policy (Phase 2 minimal rule: terminated peers remain queryable until session end, then released)
- No retry-on-spawn-failure (caller retries if desired)
- No process supervision / restart policy

---

## Control-Plane Contracts

### SpawnConfig (passed to child at spawn time)

```ts
interface SpawnConfig {
  endpoint: EndpointId;     // pre-allocated; child must register with this endpoint
  role: string;             // child's assigned role
  workdir?: string;         // resolved workdir (coordinator workdir if omitted in LaunchRequest)
  model?: string;           // model override, if provided
  coordinator: EndpointId;  // so child knows who launched it
  bootstrap_message?: string; // optional first task; child may use as first user turn
}
```

Delivered via env vars: `CC_BRIDGE_ENDPOINT`, `CC_BRIDGE_ROLE`, `CC_BRIDGE_WORKDIR`, `CC_BRIDGE_MODEL`, `CC_BRIDGE_COORDINATOR`, `CC_BRIDGE_BOOTSTRAP_MESSAGE`.

### Updated LaunchResult

```ts
interface LaunchResult {
  success: boolean;
  endpoint?: EndpointId;     // pre-allocated endpoint
  peer?: PeerMetadata;       // initial metadata snapshot (status: 'launching')
  pid?: number;              // OS pid of spawned process (if spawn succeeded)
  error?: ErrorReceiptPayload;
}
```

### TerminatePeerRequest / TerminatePeerResult

```ts
interface TerminatePeerRequest {
  endpoint: EndpointId;
  signal?: 'SIGTERM' | 'SIGKILL'; // default: SIGTERM
  reason?: string;                 // logged, not transmitted to peer
}

interface TerminatePeerResult {
  success: boolean;
  endpoint: EndpointId;
  error?: ErrorReceiptPayload;
}
```

### SpawnExitObservable (emitted to coordinator when child exits)

```ts
interface SpawnExitObservable {
  endpoint: EndpointId;
  role: string;
  pid: number;
  exit_code: number | null;
  signal: string | null;
  observed_at: number;
}
```

This is emitted as a `codex_to_claude` message (same path as `BootstrapAck`).

### New control channel messages

```ts
// Client → Daemon
| { type: "terminate_peer"; requestId: string; request: TerminatePeerRequest }

// Daemon → Client
| { type: "terminate_peer_result"; requestId: string; result: TerminatePeerResult }
```

---

## State Machine Extensions

### Spawn lifecycle additions

```
                    spawn fails
launch_peer ──────────────────────────────► (no registry entry, error result)
     │
     │ spawn ok
     ▼
  launching ──► (child registers) ──► connected ──► bootstrapped ──► idle / busy
     │
     │ child exits before register
     ▼
  terminated
```

### Termination paths

| Trigger | From state | To state | Notes |
|---|---|---|---|
| `terminate_peer` (SIGTERM/SIGKILL) | any | `terminated` | Immediate; clears bootstrap + escalation timers |
| Child process exit observed (exit event) | `launching` / `connected` / bootstrap incomplete | `terminated` + `bootstrap_state='failed'` | "bootstrap未完成即终止" |
| Child process exit observed (exit event) | `bootstrapped` / `idle` / `busy` / `stalled` | `terminated`, `bootstrap_state` unchanged | bootstrap already completed |
| `stalled` escalation timer fires | `stalled` | `terminated` | After `STALL_ESCALATION_MS`; **timer callback must re-read state and no-op if no longer `stalled`** |

### bootstrap_state: 'failed' semantics (Phase 2 activation)

`'failed'` is activated in Phase 2 with a narrow definition:
- **spawn failed before child exists**: no registry entry created → `LaunchResult{success:false, error:{code:'SPAWN_FAILED'}}`. `bootstrap_state` is never written.
- **spawn ok, child exits before bootstrap completes** (before `bootstrap_ack`): `status='terminated'`, `bootstrap_state='failed'`. Preserves observability of why termination happened during bootstrap.
- **child exits after bootstrap acked**: `status='terminated'`, `bootstrap_state` stays `'acked'`. `'failed'` is NOT retroactively applied.

### Stalled → terminated escalation (new)

`STALL_ESCALATION_MS` (default: `30000`). Timer starts when peer enters `stalled`.

**Recovery guard**: If a heartbeat arrives before the timer fires, the escalation timer is cleared and status recovers to `idle` or `busy` (per heartbeat payload). The timer callback **must re-read current state before acting** — if status is no longer `stalled`, it is a no-op. This prevents the race where a heartbeat arrives between timer fire and callback execution.

---

## Validation Invariants

| Rule | Detail |
|---|---|
| `spawn_command` | Required in daemon config; must be a non-empty string |
| Spawn failure | If spawn throws or exits non-zero before register, LaunchResult{success:false} with `SPAWN_FAILED` error code |
| terminate_peer unknown endpoint | `ENDPOINT_NOT_FOUND` error |
| terminate_peer already terminated | No-op, success=true (idempotent) |
| exit observed for unknown pid/endpoint | Logged, no registry mutation |

---

## New Error Codes (Phase 2 additions)

| Code | When |
|---|---|
| `SPAWN_FAILED` | Child process failed to start (exec error, command not found, etc.) |
| `TERMINATE_FAILED` | Signal delivery failed (process not found, permission error) |

## Implementation Status

- [x] `protocol.ts` — added `SPAWN_FAILED`, `TERMINATE_FAILED` error codes; `LaunchResult.pid`; `TerminatePeerRequest`, `TerminatePeerResult`, `SpawnExitObservable`
- [x] `control-protocol.ts` — added `terminate_peer` client message, `terminate_peer_result` server message
- [x] `daemon.ts` — `SPAWN_COMMAND`/`STALL_ESCALATION_MS` config; `spawnedProcesses`/`escalationTimers` state; `handleLaunchPeer` real spawn; `handleChildExit`; `emitSpawnExitObservable`; `startEscalationTimer`/`clearEscalationTimer`; `handleTerminatePeer`; stall escalation in `checkStalledPeers`; recovery in `handleHeartbeatIntent`; shutdown cleanup
- [ ] Phase 2 integration tests

---

## Phase 2 Gates

### Happy Path

1. Coordinator sends `launch_peer` → daemon spawns real child process → returns `LaunchResult{success:true, pid}` with pre-allocated endpoint
2. Child process registers with pre-allocated endpoint → `bootstrap_state: pending`, bootstrap timer starts
3. Child sends `bootstrap_ack` → `bootstrap_state: acked`, `status: bootstrapped`, `BootstrapAck` observable
4. Coordinator sends `terminate_peer` → daemon sends SIGTERM → child exits → `status: terminated`, `SpawnExitObservable`
5. Registry query after termination → peer still visible (`terminated`, queryable) but not routable

### Sad Path

1. Spawn fails (bad command / permission error) → `LaunchResult{success:false, error:{code:'SPAWN_FAILED'}}`
2. Child exits before registering → `status: terminated`, `SpawnExitObservable` observable
3. Child exits after registering but before bootstrap ack → `status: terminated`, bootstrap timer cleared
4. Child goes stalled → escalation timer fires → `status: terminated`
5. `terminate_peer` unknown endpoint → `ENDPOINT_NOT_FOUND`
6. `terminate_peer` already-terminated endpoint → idempotent success

---

## Spawn Implementation Notes

- **Spawn command**: Daemon reads `CC_BRIDGE_SPAWN_COMMAND` (e.g. `claude`) or `CC_BRIDGE_SPAWN_ARGS` for additional flags.
- **Child exit detection**: Use `subprocess.on('exit', ...)` (Bun `spawn` API's `exited` promise or event).
- **Stdin/stdout**: Inherit or redirect to log file (consistent with current daemon log pattern).
- **Phase 2 does NOT implement process supervision or restart.** Restart policy is Phase 3.

---

## Phase 1 Carry-Over Constraint

> From Phase 1 close: `bootstrap_state: 'failed'` is reserved for future process-lifecycle phases (e.g. spawn failure before register). Phase 2 should use `'failed'` for this case if it fits, or extend the union — decide at implementation time.

---

## Required Tests

**Process spawn (integration):**
1. `launch_peer` with valid spawn command → real child process created, pid returned
2. `launch_peer` with invalid spawn command → `SPAWN_FAILED` error, no registry entry

**Termination:**
3. `terminate_peer` → child exits → `SpawnExitObservable`, registry `status: terminated`
4. Child exits without `terminate_peer` → same observable, same state transition
5. `terminate_peer` unknown endpoint → `ENDPOINT_NOT_FOUND`
6. `terminate_peer` already terminated → idempotent success

**bootstrap_state:'failed':**
7. Child exits before `bootstrap_ack` → `status='terminated'`, `bootstrap_state='failed'`
8. Child exits after successful bootstrap → `status='terminated'`, `bootstrap_state='acked'` (unchanged)

**Escalation:**
9. Peer goes stalled → escalation timer fires → `terminated` (no manual terminate); timer callback is a no-op if status already changed
10. Peer recovers heartbeat before escalation timer fires → timer cleared, status recovers to `idle`/`busy`

**Spawn contract:**
11. `bootstrap_message` present in `SpawnConfig` → child receives it as env var `CC_BRIDGE_BOOTSTRAP_MESSAGE`
