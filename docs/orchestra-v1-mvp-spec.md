# Orchestra v1 MVP Spec

> A+B (Conductor+Concertmaster) consensus reached 2026-03-30.
> Based on current cc-bridge codebase capabilities.

---

## 1. Scope

Orchestra v1 is a **constrained orchestration layer** on top of cc-bridge. It uses existing bridge primitives (rooms, relay, launch_peers, broadcastGlobal) and adds orchestration governance in A's logic — not in the transport.

### What v1 IS
- A (Conductor) + B (Concertmaster) deliberation → consensus → task group spawn → execution → acceptance
- Single task group preferred; multi-group only when truly necessary
- Multi-model enforcement at launch time
- Best-effort world broadcast
- Fail-stop on B death (report to user, no auto-recovery)

### What v1 is NOT
- Durable cross-room message delivery
- Enforced communication topology at the transport level
- Auto-failover or re-election
- DAG/barrier dependency enforcement as a bridge primitive

---

## 2. Roles

| Role | Model | Responsibilities |
|------|-------|------------------|
| **A — Conductor** | opus (fixed) | Plan, arrange roles/groups/channels, final acceptance. Does NOT write code. |
| **B — Concertmaster** | gpt-5.4 (fixed) | Challenge A's plan, reach consensus, can serve as group leader. |
| **Leader** | B or model pool | Lead group implementation, code/review/test |
| **Challenger** | kimi preferred | Independent challenge within group, code/review/test |
| **Extra coders** | minimax / doubao | Additional implementation capacity (optional) |
| **Watchdog** | minimax (optional) | Health monitoring, world channel posts |

---

## 3. Workflow

```
User → A: provide highest goal with details
         ↓
A probes user for specifics (A must pursue detail)
         ↓
A drafts plan + arrangement
         ↓
A → B: send plan for challenge (orchestra room)
         ↓
B challenges from multiple angles
         ↓
A ↔ B: iterate until consensus
         ↓
Consensus = plan + arrangement locked
         ↓
B spawns C (and optionally D) into worker room(s)
         ↓
Group executes: leader+challenger consensus on sub-goal
         ↓
B relays group result to A
         ↓
A + B: final acceptance → merge into highest-goal path
         ↓
Repeat for next sub-goal or declare complete
```

---

## 4. Plan Structure (A+B consensus required)

1. **Highest goal** — user-confirmed, with specifics A probed for
2. **Implementation path** — sequence of milestones
3. **Sub-goals** — each with **quantified acceptance criteria**
4. **Arrangement** — group composition, model assignments, channel topology

---

## 5. Task Groups

- Each sub-goal maps to one group
- **Prefer 1 group** unless project is truly complex
- Max **4 CC windows** per group
- Required roles: **leader + challenger** (both also code/review/test)
- Optional: +1-2 extra windows

### Multi-model Policy

Every window in a group **must use a different model**. This is enforced by A's arrangement logic at launch time, not by the transport.

- Default model pool: kimi, minimax, doubao
- Challenger preference: **kimi first**
- Simple config: leader=B(gpt-5.4), challenger=kimi, extras from minimax/doubao

### Typical Configurations

| Config | Windows | Layout |
|--------|---------|--------|
| Simple | 3 | A(B)C — B=concertmaster+leader, C=challenger(kimi) |
| Medium | 4 | A B C D — B=leader, C=challenger, D=coder |
| Complex | 5+ | AB + (BC) + (DE) — B=concertmaster+group1 leader |

---

## 6. Channels

| Channel | Endpoints | Room | Purpose |
|---------|-----------|------|---------|
| Conductor-Concertmaster | A ↔ B | orchestra | Plan, arrangement, final acceptance |
| Group internal | B ↔ C (↔ D) | group-1 | Implementation, review, test |
| World | A → all | broadcastGlobal | Global announcements |

### v1 Channel Constraints
- A and C **never communicate directly**. A coordinates via B.
- Cross-room delivery (B↔A across rooms) requires **live coordinator** in target room — not durable.
- World broadcast is **best-effort** with `delivered_rooms` / `skipped_rooms` semantics.

---

## 7. Execution Rules

1. Multi-group serial/parallel depends on sub-goal dependencies
2. **Resolve ALL dependencies** before downstream groups start — no rework tails (orchestration governance, not bridge primitive)
3. Within group: leader + challenger reach consensus → report to A+B
4. A+B final acceptance → merge into highest-goal path
5. Health monitoring: A detects B death via peer registry timeout → reports to user

---

## 8. Implementation on cc-bridge

### Existing primitives used
| Primitive | Code location | Purpose |
|-----------|---------------|---------|
| Rooms | daemon.ts Phase 4A | Isolate orchestra, group-1, etc. |
| Relay (file-based) | daemon.ts pollMessages | Intra-room message delivery |
| launch_peers | window-launcher.ts | A spawns B, B spawns C |
| broadcastGlobal | daemon.ts Phase 5B | World channel |
| Cross-room P2P | daemon.ts Phase 4D-1 | B↔A across rooms (live coordinator required) |
| Peer registry | daemon.ts peerRegistry | Health/liveness detection |
| Profile system | .env + load-profile-env.sh | Multi-model via sub2api profiles |

### Implementation steps (A's orchestration logic)
1. A spawns B via `launch_peers` with `target_room=orchestra`, `profile=sub2api_codex`
2. A sends plan to B, iterates until consensus
3. On consensus, B spawns C via `launch_peers` with `target_room=group-1`, `profile=kimi_code`
4. B joins group-1 as leader, communicates with C
5. B relays results to A via orchestra room (cross-room P2P)
6. A performs final acceptance with B

### Launch command pattern
```bash
# A spawns B
bash scripts/launch-claude-peer.sh B sub2api_codex $WORKDIR "$PROMPT_B64" orchestra

# B spawns C
bash scripts/launch-claude-peer.sh C kimi_code $WORKDIR "$PROMPT_B64" group-1
```

---

## 9. Known Limitations (v1)

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| Worker rooms are **live-session**, not durable mailboxes | Messages lost if coordinator disconnects | Keep coordinator alive during group work |
| World broadcast is **best-effort** | Some rooms may not receive announcements | Check `delivered_rooms` / `skipped_rooms` |
| B is a **SPOF** (concertmaster + possible group leader) | B death halts orchestration | A detects and reports; user restarts |
| No auto-failover/re-election | Manual recovery required | v2 feature |
| No transport-level topology enforcement | Peers can technically message anyone | Orchestration logic must enforce discipline |
| No dependency/barrier primitives | Cross-group deps managed by A's logic | A sequences group starts manually |

---

## 10. v2+ Roadmap (priority order)

1. **Durable cross-room delivery** — relay-file based, survives coordinator disconnection
2. **Topology enforcement** — bridge validates allowed communication edges per room config
3. **Auto-failover** — re-elect concertmaster or leader on death
4. **Launch-time model uniqueness validation** — bridge rejects duplicate models in a group
5. **Dependency barriers** — bridge primitive for "group X must complete before group Y starts"
6. **Cross-room envelope provenance** — clearer senderId on forwarded messages

---

## Appendix: A+B Discussion Summary

**B's challenge (6 angles):**
1. Feasibility: rooms, relay, launch_peers available; arbitrary channel graph and durable mesh NOT supported
2. Fault tolerance: partition/cleanup real; cross-room forwarding fragile (live coordinator dependency)
3. Complexity: sweet spot is AB + one worker room; more groups add cost faster than bridge justifies
4. Edge cases: B dual role = SPOF; cross-group deps = governance only; "resolve all deps" not a primitive
5. Multi-model: not enforced by bridge; must be launcher policy
6. Missing: durable xroom, topology enforcement, auto-failover, barriers, model validation, provenance

**A's response:** Accepted all points. Proposed constrained v1 scope.

**Consensus:** Both A and B agree on v1 scope with two explicit caveats documented (live-session rooms, best-effort broadcast).
