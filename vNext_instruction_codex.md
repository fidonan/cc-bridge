# cc-bridge vNext Instruction

## Goal

Design the next version of `cc-bridge` so it can evolve from:

- `Claude window A <-> cc-bridge <-> Claude window B`

into a more complete multi-agent coding workflow system where:

- `A` is the main user-facing control window
- `B` is the default technical planner / critic
- additional windows such as `C/D/E/...` are launched dynamically based on task complexity
- the system can plan, assign work, coordinate execution, review, test, recover from stalls, and report results back to the user

This is no longer just a communication bridge problem. It is a workflow orchestration problem built on top of the existing `cc-bridge` messaging layer.

## Existing Constraints

- `A` is a directly logged-in Claude Code window and is not driven by `.env` model switching.
- `B` should be the first peer launched by `A`, typically with `sub2api_codex` (`gpt-5.4`).
- More windows should be launched only when justified by the task.
- `cc-bridge` already supports:
  - multi-instance MCP registration
  - peer-to-peer messaging
  - pull-mode operation
  - `wait_for_messages`
  - targeted launch of peer windows
- The system should not rely on bypassing Claude permission safety features.

## Problem To Solve

Define an implementation path for a production-capable workflow layer on top of `cc-bridge`, including:

1. How `A` should work with `B` to form technical consensus and a machine-usable plan
2. How additional windows should be selected, launched, assigned, and coordinated
3. How the system should represent task state and workflow state
4. How to design:
   - big loops
   - small loops
   - triggers
   - watchdog / anti-stall recovery
5. How `B/C/D/E` should communicate without turning into uncontrolled group chat
6. How execution, review, testing, and final reporting should be stitched into one coherent system

## Core Design Questions

Please analyze and propose a concrete architecture for the following.

### 1. System Roles

What should be the default responsibilities of:

- `A` = user-facing coordinator / orchestrator
- `B` = planner / critic / technical lead
- `C` = implementer
- `D` = reviewer
- `E` = tester / debugger
- optional future roles such as summarizer / docs / verifier

Please distinguish between:

- mandatory roles
- optional roles
- when each role should be launched

### 2. Big Loop and Small Loop

The system should likely have:

- a **big loop** around the overall user goal
- multiple **small loops** around individual tasks

Please propose:

- state definitions for the big loop
- state definitions for the small loop
- transition rules
- which transitions should require human confirmation through `A`

Suggested areas to consider:

- `goal_received`
- `planning`
- `execution`
- `review`
- `testing`
- `blocked`
- `done`

and task states such as:

- `assigned`
- `in_progress`
- `needs_input`
- `ready_for_review`
- `changes_requested`
- `ready_for_test`
- `passed`
- `failed`

### 3. Trigger Mechanism

We want the workflow to keep moving even when windows do not proactively continue on their own.

Please design a trigger system for:

- time-based triggers
- state-based triggers
- result-based triggers
- dependency-based triggers

Examples:

- if no status update for N minutes, notify / escalate
- when implementer marks `ready_for_review`, automatically notify reviewer
- when tests fail, automatically notify implementer
- when all dependent tasks complete, automatically unlock the next task

### 4. Watchdog / Anti-Stall Mechanism

We need a way to prevent windows from silently stopping, ignoring new work, or stalling the overall workflow.

Please propose:

- heartbeat / liveness rules
- timeout and retry policies
- escalation rules
- how `A` should be notified
- whether stalled windows should be replaced, retried, or manually resumed

### 5. BCDE Communication Topology

`B/C/D/E` should not be limited to talking only through `A`, but also should not devolve into uncontrolled many-to-many chatter.

Please propose a controlled communication model:

- `control` messages
- `peer` messages
- `broadcast` messages

Clarify:

- which roles may talk directly to which other roles
- which interactions must always be copied back to `A`
- what kinds of messages should be direct vs escalated

### 6. Data Model / Schema

Please define the minimum useful machine-readable structures for:

- workflow state
- plan
- task definitions
- agent role assignments
- events
- task results
- blocking conditions

JSON-like schema sketches are welcome.

### 7. Orchestrator Layer

Assume `cc-bridge` remains the communication layer.

What additional orchestrator layer should be added on top?

Please propose responsibilities for a future `workflow engine`, such as:

- reading structured plans
- launching agents
- routing tasks
- managing state transitions
- firing triggers
- collecting summaries
- deciding when to involve the user through `A`

### 8. Incremental Implementation Path

Do not propose a “boil the ocean” rewrite.

Please give a staged implementation path, for example:

- Phase 1: A+B consensus and structured plan output
- Phase 2: single implementer + reviewer + tester workflow
- Phase 3: trigger/watchdog automation
- Phase 4: richer dynamic role assignment and optional broadcast/group coordination

Each phase should describe:

- what new capability is added
- why it matters
- what files or modules are likely to be introduced

## External Inspiration

Use external open source agent orchestration ideas as inspiration where helpful, especially from systems resembling:

- LangGraph
- CrewAI
- AutoGen
- OpenHands

But do not simply copy their architecture. The design must be adapted to `cc-bridge` and to Claude Code windows as the execution surface.

## Deliverable Format

Please produce:

1. A concise architecture proposal
2. A recommended state machine model
3. A trigger/watchdog design
4. A communication topology for A/B/C/D/E
5. A phased implementation plan
6. A short “recommended v1 scope” section

When reasoning, optimize for:

- practicality
- controllability
- recoverability
- minimal operator burden on `A`
- compatibility with future IM entry points such as WeChat / Telegram driven orchestration

