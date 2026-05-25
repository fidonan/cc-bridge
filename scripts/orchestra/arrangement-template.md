# Orchestra v1 Arrangement Template

> Fill this template and send to B for challenge before spawning any windows.
> This is a structured contract — A and B must reach consensus before execution.

---

## GOAL

<!-- User-provided highest goal with specifics A probed for -->

**Highest Goal:** [describe what success looks like]

**Specifics Confirmed with User:**
- [ ] Detail 1:
- [ ] Detail 2:
- [ ] Detail 3:

---

## IMPLEMENTATION_PATH

<!-- Sequence of milestones from start to completion -->

1. [Milestone 1: initial state / setup]
2. [Milestone 2: first deliverable]
3. [Milestone 3: ...]
4. [Milestone N: final acceptance]

---

## MILESTONES

| # | Milestone | Definition of Done | Group Responsible |
|---|-----------|-------------------|-------------------|
| 1 | [name] | [quantifiable criteria] | [group-N] |
| 2 | [name] | [quantifiable criteria] | [group-N] |
| 3 | [name] | [quantifiable criteria] | [group-N] |

---

## SUB_GOALS

<!-- Each sub-goal maps to one task group. Prefer 1 group unless complexity demands more. -->

### Sub-Goal 1: [name]
- **Maps to:** group-1
- **Acceptance Criteria (quantified):**
  - [ ] Criterion 1: [measurable condition]
  - [ ] Criterion 2: [measurable condition]
- **Dependencies:** [none | sub-goal X must complete first]
- **Estimated Complexity:** [low | medium | high]

### Sub-Goal 2: [name] (if needed)
- **Maps to:** group-2
- **Acceptance Criteria:**
  - [ ] Criterion 1:
  - [ ] Criterion 2:
- **Dependencies:** [sub-goal 1 must resolve all deps first]

<!--
NOTE: v1 constraint — downstream groups must start ONLY after
upstream dependencies are fully resolved. No rework tails.
-->

---

## WINDOWS

<!-- Max 4 windows per group. Simple projects: use 1 group with 3 windows (A(B)C). -->

| Endpoint | Role | Model | Room | Notes |
|----------|------|-------|------|-------|
| A | Conductor | opus | orchestra | User-facing, no code |
| B | Concertmaster + Leader | gpt-5.4 | orchestra | Challenge A, lead group-1 remotely via cross-room P2P |
| C | Challenger | kimi | group-1 | Independent challenge, code/review/test |
| D | Coder (optional) | minimax/doubao | group-1 | Extra capacity if needed |

<!--
GUIDANCE: For simple projects, use A(B)C — 3 windows total.
B dual-roles as concertmaster + group-1 leader.
-->

---

## ROOMS

<!-- v1 uses live-session rooms. Coordinator must stay alive during group work. -->

| Room | Purpose | Coordinator | Participants | Persistence |
|------|---------|-------------|--------------|-------------|
| orchestra | A↔B deliberation, final acceptance | A | A, B | Live-session |
| group-1 | Implementation, review, test | C (local) / B (remote via cross-room P2P) | C, [D] | Live-session |
| group-2 | [if multi-group] | [leader] | [members] | Live-session |

<!--
WARNING: Rooms are live-session, not durable mailboxes.
If coordinator disconnects, messages are lost.
Keep coordinator alive during group work.
-->

---

## ROLES

| Agent | Primary Role | Secondary Role | Can Code? | Reports To |
|-------|-------------|----------------|-----------|------------|
| A (opus) | Conductor | Plan, arrange, acceptance | NO | User |
| B (gpt-5.4) | Concertmaster | Challenge A, lead group | YES | A |
| C (kimi) | Challenger | Code, review, test | YES | B |
| D (minimax/doubao) | Coder | Implement, test | YES | B |

<!--
MULTI-MODEL RULE: All windows in a group MUST use different models.
This is launcher policy, not bridge-enforced.
Challenger priority: kimi first (when available).
-->

---

## PROFILES

<!-- Profile names from .env or load-profile-env.sh -->

| Endpoint | Model | Profile Name | Launch Command |
|----------|-------|--------------|----------------|
| A | claude-opus-4-6 | claude_api | [manual or scripted] |
| B | gpt-5.4 | sub2api_codex | bash scripts/launch-claude-peer.sh B sub2api_codex $PWD "$PROMPT_B_B64" orchestra |
| C | kimi-k2.5 | kimi_code | bash scripts/launch-claude-peer.sh C kimi_code $PWD "$PROMPT_C_B64" group-1 |
| D | MiniMax-M2.7 | minimax_code | bash scripts/launch-claude-peer.sh D minimax_code $PWD "$PROMPT_D_B64" group-1 |

---

## EDGES

<!-- Communication topology. A and C NEVER communicate directly. -->

```
orchestra room:
  A <-> B  [plan, challenge, consensus, final acceptance]

group-1 room (intra-group only):
  C <-> D  [peer review] (optional, if D exists)

cross-room P2P (B stays in orchestra, live coordinator required):
  B (in orchestra) <-> C (in group-1)  [design challenge, code review, work packages, results relay]
  B (in orchestra) <-> D (in group-1)  [implementation coordination] (if D exists)

world broadcast (best-effort):
  A -> all  [global announcements via scope="global"]
```

<!--
TOPOLOGY RULES:
- A never talks to C directly — coordination flows through B
- Cross-room delivery requires live coordinator in target room
- World broadcast is best-effort; check delivered_rooms / skipped_rooms
-->

---

## RULES

### Group Composition
- [ ] Max 4 windows per group
- [ ] Prefer 1 worker group unless project is truly complex
- [ ] Required per group: 1 leader + 1 challenger (both code/review/test)
- [ ] Optional: +1-2 extra coders

### Multi-Model Enforcement
- [ ] All windows in a group use DIFFERENT models
- [ ] Challenger preference: kimi first
- [ ] Simple config: B(gpt-5.4) + C(kimi) + D(minimax|doubao)

### Dependency Management
- [ ] Downstream groups start ONLY after upstream deps resolved
- [ ] No rework tails — verify closure before proceeding
- [ ] v1: manual sequencing by A (no bridge barrier primitive)

### Communication Discipline
- [ ] A never communicates directly with C
- [ ] All group results relay to A through B
- [ ] Use explicit consensus language: "Current consensus:"
- [ ] Cross-room P2P: note live-session fragility

### Execution Flow
1. A fills this template
2. A sends to B for challenge (orchestra room)
3. A ↔ B iterate until "Current consensus:"
4. B spawns C [+ D] into group-1
5. B stays in orchestra, leads C remotely via cross-room P2P
6. B relays C's result to A in orchestra room
7. A + B final acceptance

---

## DONE_WHEN

Arrangement is ready for execution when:

- [ ] GOAL has specifics A probed from user
- [ ] IMPLEMENTATION_PATH is sequenced
- [ ] Each SUB_GOAL has quantified acceptance criteria
- [ ] WINDOWS table shows ≤4 per group, models unique within group
- [ ] ROOMS account for live-session constraints
- [ ] EDGES respect no-direct-A↔C rule
- [ ] RULES checklist reviewed
- [ ] B has challenged and output: "Current consensus from my side:"

---

## POST-CONSENSUS ACTIONS

Once A+B reach consensus:

1. **Spawn B** (if not already active):
   ```bash
   bash scripts/launch-claude-peer.sh B sub2api_codex $PWD "$PROMPT_B_B64" orchestra
   ```

2. **Spawn C** (and D if needed):
   ```bash
   bash scripts/launch-claude-peer.sh C kimi_code $PWD "$PROMPT_C_B64" group-1
   ```

3. **B stays in orchestra**, leads C remotely via cross-room P2P

4. **Monitor:** A watches B liveness via peer registry

5. **Final acceptance:** B relays result to A; A+B confirm merge into highest goal

---

<!--
v1 CONSTRAINTS SUMMARY (for A to remember):
- Rooms are live-session: coordinator must stay alive
- World broadcast is best-effort: check delivered_rooms/skipped_rooms
- B is SPOF: B death halts orchestration, A detects and reports
- No auto-failover: manual recovery required
- No topology enforcement at bridge level: orchestration logic must enforce discipline
-->
