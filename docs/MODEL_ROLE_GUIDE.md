# Model Role Guide

## Default Workflow

- Window A: `claude_api` (`claude-opus-4-6`)
  - Role: user-facing coordinator
  - Responsibility: clarify requirements, negotiate scope, keep user in the loop, decide when to ask follow-up questions

- Window B: `sub2api_codex` (`gpt-5.4`)
  - Role: technical path planner
  - Responsibility: decompose the task, challenge assumptions, produce implementation plans, identify technical risks

Default sequence:
1. User talks to A
2. A decides whether the task needs peer collaboration
3. If yes, A launches B with `gpt-5.4`
4. A and B discuss until they reach `Current consensus:`
5. A reports back to the user

## Suggested Role Assignment By Project Size

### Small Tasks

- A (`claude_api`): user coordination
- B (`sub2api_codex`): planning + implementation review

Use when:
- bugfixes
- small refactors
- single-file changes
- quick code review

### Medium Tasks

- A (`claude_api`): user coordination / final decision
- B (`sub2api_codex`): architecture + implementation plan
- C (`kimi_code`): context reader / repo summarizer / documentation synthesizer

Use when:
- multi-file features
- moderate refactors
- technical design discussions
- implementation + review split

### Large Tasks

- A (`claude_api`): user liaison / scope control
- B (`sub2api_codex`): lead architect / task breakdown
- C (`kimi_code`): long-context reader / requirement extraction / codebase map
- D (`doubao`): fast alternative generation / risk enumeration / test case brainstorming
- E (`minimax_code`): secondary implementer / independent checker / compare-and-contrast reviewer

Use when:
- large refactors
- migrations
- project bootstraps
- multi-step delivery with review and testing phases

## Model Strengths And Weaknesses

These are initial role recommendations based on model positioning and practical engineering fit. They are not a formal benchmark yet.

### `claude_api` -> `claude-opus-4-6`

Strengths:
- strong requirement understanding
- good at ambiguity resolution
- usually better at writing clear user-facing summaries
- good coordinator for multi-step tasks

Weaknesses:
- can over-deliberate
- slower and more expensive to use as every-window default
- not always the best choice for aggressive task decomposition

Best fit:
- window A
- architecture review
- final consensus writing

### `sub2api_codex` -> `gpt-5.4`

Strengths:
- strong decomposition and engineering structure
- good at identifying edge cases and implementation order
- good fit for planning, code review, test planning
- strong “challenger” model for A

Weaknesses:
- can be more rigid than A in ambiguous product discussions
- may need A to translate user intent into a cleaner task frame

Best fit:
- window B by default
- planner / critic / technical reviewer

### `kimi_code` -> `kimi-k2.5`

Strengths:
- good Chinese interaction
- good for reading and summarizing large amounts of context
- useful as a “repo reader” or “requirements condenser”

Weaknesses:
- less ideal than B as the main technical arbiter
- should not be the only reviewer on risky implementation paths

Best fit:
- context extraction
- documentation synthesis
- background analysis

### `doubao` -> `Doubao-Seed-2.0-pro`

Strengths:
- useful as a fast secondary opinion
- good for brainstorming variants and test ideas
- good low-cost expansion role in larger workflows

Weaknesses:
- not ideal as the primary architecture owner
- consistency on complex technical decisions may be weaker than A/B

Best fit:
- test brainstorming
- alternative approaches
- risk enumeration

### `minimax_code` -> `MiniMax-M2.7`

Strengths:
- useful as another independent implementation/review voice
- can be used as a contrast model against B and D

Weaknesses:
- role fit still needs more hands-on validation in this workflow
- I would not make it the only planner or only reviewer yet

Best fit:
- secondary checker
- alternative implementation suggestions
- compare-with-B review

## Recommended Policy

- Always start with:
  - A = `claude_api`
  - B = `sub2api_codex`

- Add C only when:
  - the repo is large
  - requirements are messy
  - a lot of files must be read before planning

- Add D only when:
  - you need broader alternative generation
  - you want more test ideas or risk coverage

- Add E only when:
  - the task is large enough to justify a second independent technical opinion

## What Still Needs Live Evaluation

The following should be validated with real window-to-window runs:

- whether `doubao` is better used as fast critic or test designer
- whether `minimax_code` is better as implementer or reviewer
- whether `kimi_code` is strong enough to act as a planning assistant, not just a context reader

Current recommendation:
- do not change the default A/B pairing
- use A + B as the mandatory base
- add C/D/E only when task scale justifies it

---

## Collaboration Protocol (Learned from Live Sessions)

These patterns emerged from extended A/B implementation sessions and produced reliable results. Apply them whenever two or more windows are working on the same technical problem.

### Fundamental Principle: All Multi-Agent Collaboration Is Bilateral

Regardless of how many agents are involved, every meaningful collaboration reduces to a sequence of **bilateral challenge cycles**. N agents do not hold simultaneous N-way negotiations — they run pairwise exchanges that converge one edge at a time.

```
N-agent collaboration = directed graph of bilateral (A↔B) cycles
- Each edge runs the same protocol: propose → challenge → agree/disagree → consensus
- Consensus on one edge becomes the input contract for the next
- Final multi-party consensus = intersection of all bilateral agreements
```

Practical rule: **never add a third agent to a live debate**. Instead, resolve A↔B first, then feed that consensus to C as a fixed input. C challenges the consensus as a unit, not the internal A/B reasoning.

This means the A/B protocol below is not just for two windows — it is the **atomic unit** of all larger workflows.

### Role Asymmetry

A and B are **not symmetric debaters**. They have distinct responsibilities:

| | Window A | Window B |
|---|---|---|
| Primary role | Implementer / Coordinator | Challenger / Verifier |
| Initiates | Proposals, diff summaries | Challenges, code-grounded objections |
| Owns | Implementation, test writing, consensus writing | Independent verification, gap identification |
| Guards against | Scope creep, under-testing | Unverified assumptions, hidden coupling |

B's job is to find problems, not to agree. A should expect pushback; B should provide evidence.

### Explicit Language Framework

Use these exact phrases to reduce ambiguity across turns:

```
My independent view is: ...      ← state a position before seeing the other's
I agree on: ...                  ← acknowledge specific points of agreement
I disagree on: ...               ← name the specific disagreement, not just "I disagree"
Current consensus: ...           ← only when both sides have confirmed it
```

A consensus is not reached until B explicitly says "Current consensus from my side: X". A saying it alone is not enough.

### Challenge-Before-Implement Gate

Design challenges happen **before** code is written, not after. The sequence is:

1. A proposes contract/design
2. B reads relevant code and challenges from the code, not from memory
3. Both state "I agree on / I disagree on" until the design is settled
4. A implements; B reviews the diff
5. B challenges the diff with code evidence; A responds
6. Repeat until "Current consensus: X is good to merge"

Skip step 2–3 and you get implementation-stage rewrites.

### Code-Verification Requirement

Opinions must be grounded in actual code reads. Before stating a position on existing behavior, read the relevant function. Format: `"I verified in code: [function] at src/file.ts:LINE does X"`. Assertions without line references are lower-confidence and should be flagged as such.

### Scope Discipline

Each phase has a clear entry and exit condition. When a phase is complete:
- State it explicitly: `"Phase X complete. Moving to Phase X+1."`
- Do not carry unfinished work silently into the next phase
- Do not add scope to a phase mid-implementation without B's agreement

### Non-Blocking Gap Pattern

Not every identified gap is a blocker. When B finds a gap that is correct by inspection but not worth stopping for:

```
"Coverage gap: [description]. Not blocking — treat as follow-up hardening."
```

A acknowledges it, neither side silently drops it. The gap goes on a named follow-up list, not into the current phase.

### Consensus Format

A valid consensus message includes:
1. What was agreed
2. What was explicitly NOT in scope
3. Any named follow-up items

Example:
```
Current consensus: Phase X is good to merge.
Out of scope: [Y, Z].
Follow-up hardening: [coverage gap description].
```

### Anti-Patterns to Avoid

| Anti-pattern | Why it fails |
|---|---|
| B says "looks good" without reading the code | Misses implementation bugs caught by phase4b test 8 |
| A proposes design and implements before B challenges | Forces rewrites at review stage |
| Disagreement without code evidence | Devolves into preference debate |
| Consensus before both sides confirm | One-sided merge |
| Scope addition mid-phase without agreement | Breaks test invariants, delays delivery |
| "I'll fix it later" for non-blocking gaps | Gaps disappear silently |
