# Orchestra v1 — Quickstart

> Multi-agent orchestration on cc-bridge. Zero code changes — prompt-driven only.

## Prerequisites

- cc-bridge built and working (`bun run src/daemon.ts` starts cleanly)
- Profiles configured in `.env` (minimax, kimi, doubao, sub2api_codex, claude_api)
- Terminal.app available (peer windows launch via AppleScript)

## Files

| File | Purpose |
|------|---------|
| `arrangement-template.md` | Structured contract A fills before spawning any windows |
| `conductor.md` | A's role prompt (Conductor — plan, arrange, accept) |
| `concertmaster.md` | B's role prompt (Concertmaster — challenge, coordinate, relay) |
| `challenger.md` | C's role prompt (Challenger — independent review, code, test) |
| `leader.md` | Group leader role prompt (coordinate group, verify, relay) |

## Quick Start (Simple A+B+C config)

### 1. Start A (Conductor)

A is your current Claude Code session. Load the conductor role:

```bash
# A runs in your main terminal — no special launch needed.
# Use --append-system-prompt-file to load the conductor role:
claude --append-system-prompt-file scripts/orchestra/conductor.md
```

### 2. Fill the Arrangement

Copy `arrangement-template.md` and fill in:
- **GOAL**: user's highest goal with specifics
- **IMPLEMENTATION_PATH**: milestone sequence
- **SUB_GOALS**: each with quantified acceptance criteria
- **WINDOWS**: A(opus) + B(gpt-5.4) + C(kimi) — 3 windows
- **ROOMS**: orchestra (A,B) + group-1 (B,C)

### 3. Spawn B (Concertmaster)

```bash
# Encode B's initial prompt (the filled arrangement + challenge request)
PROMPT_B_B64=$(echo -n "Read scripts/orchestra/concertmaster.md for your role. Then read the arrangement I'm sending and challenge it from multiple angles. Use explicit consensus language." | base64)

# Launch B with gpt-5.4 via sub2api
bash scripts/launch-claude-peer.sh B sub2api_codex "$PWD" "$PROMPT_B_B64" orchestra
```

### 4. A ↔ B Consensus

In your A session:
1. Send the filled arrangement to B via bridge
2. B challenges from multiple angles
3. Iterate until both state `Current consensus:`
4. Do NOT spawn workers until consensus is locked

### 5. Spawn C (Challenger)

After A+B consensus, B spawns C:

```bash
# Encode C's initial prompt
PROMPT_C_B64=$(echo -n "Read scripts/orchestra/challenger.md for your role. Call get_messages to receive your work package from B. Follow the message loop protocol." | base64)

# Launch C with kimi into group-1
bash scripts/launch-claude-peer.sh C kimi_code "$PWD" "$PROMPT_C_B64" group-1
```

### 6. Execution

- B sends C the work package with acceptance criteria via cross-room P2P
- C implements, tests, and reports back to B
- B reviews C's output, then relays to A
- A does final acceptance

### 7. Completion

A accepts when all sub-goal acceptance criteria are met with evidence.

## Topology

```
orchestra room:
  A <-> B  [plan, challenge, consensus, acceptance]

group-1 room:
  B <-> C  [work packages, code review, test results]

A never talks to C directly — all coordination flows through B.
```

## Model Assignments

| Endpoint | Model | Profile | Role |
|----------|-------|---------|------|
| A | claude-opus-4-6 | claude_api | Conductor |
| B | gpt-5.4 | sub2api_codex | Concertmaster |
| C | kimi-k2.5 | kimi_code | Challenger |
| D (optional) | MiniMax-M2.7 | minimax_code | Extra coder |

**Rule:** All windows in a group must use different models.

## Monitoring

Check peer health:
```bash
# From A's session — list peers in orchestra
AGENTBRIDGE_CONTROL_PORT=4512 CC_BRIDGE_ROOM=orchestra CC_BRIDGE_ENDPOINT=A \
  bun run scripts/cc-bridge-cli.ts list-peers

# Check for messages
AGENTBRIDGE_CONTROL_PORT=4512 CC_BRIDGE_ROOM=orchestra CC_BRIDGE_ENDPOINT=A \
  bun run scripts/cc-bridge-cli.ts get-messages
```

If B dies (0% CPU, no response), orchestration halts. Report to user and restart B manually.

## Known Limitations (v1)

- **Rooms are live-session**: messages lost if coordinator disconnects
- **B is SPOF**: B death halts orchestration, manual recovery only
- **World broadcast is best-effort**: check `delivered_rooms`/`skipped_rooms`
- **No transport-level topology enforcement**: discipline is in the prompts
- **Cross-room P2P requires live coordinator**: B must be alive for A↔C relay

## Reference

- Full spec: `docs/orchestra-v1-mvp-spec.md`
- Arrangement template: `scripts/orchestra/arrangement-template.md`
