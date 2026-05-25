# cc-bridge SOP

## Goal

Use two or more Claude Code windows to carry on a continuous dialogue through `cc-bridge` until they reach a clear conclusion.

## v0.2.0: N-Window Routing

New in v0.2.0:

```typescript
// Point-to-point (only B receives)
reply(text="hello", to=["B"])

// Multicast (C and D receive)
reply(text="hello", to=["C", "D"])

// Broadcast (all windows receive)
reply(text="hello")

// List online peers
list_peers
```

## 1. Check MCP registration

```bash
# 2 windows
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2

# 4 windows
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2
claude mcp get cc-bridge-3
claude mcp get cc-bridge-4
```

## 2. Clean old relay state when needed

```bash
pkill -f 'cc-bridge/src/daemon.ts'
rm -rf /tmp/cc-bridge/default
rm -f /tmp/cc-bridge-*.log
```

## 3. Open Claude Code windows

For 2 windows, open two terminals:

```bash
cd cc-bridge
claude
```

For 4 windows, open four terminals:

```bash
cd cc-bridge
claude
```

## 4. Initialize window A

```text
You are Claude window A.

Use only these MCP tools:
- mcp__cc-bridge-1__reply
- mcp__cc-bridge-1__wait_for_messages
- mcp__cc-bridge-1__list_peers
- use mcp__cc-bridge-1__get_messages only for debugging

Do not use any cc-bridge-2/3/4 tools.

Behavior:
1. You initiate the discussion.
2. Send the first message yourself.
3. Then repeat:
   wait_for_messages(timeout_ms=30000) -> read -> reply
4. Keep each reply concise.
5. When agreement is reached, output a final message beginning with:
   Current consensus:
```

## 5. Initialize window B

```text
You are Claude window B.

Use only these MCP tools:
- mcp__cc-bridge-2__reply
- mcp__cc-bridge-2__wait_for_messages
- mcp__cc-bridge-2__list_peers
- use mcp__cc-bridge-2__get_messages only for debugging

Do not use any cc-bridge-1/3/4 tools.

Behavior:
1. Do not speak first.
2. Wait for A's message.
3. Then repeat:
   wait_for_messages(timeout_ms=30000) -> read -> reply
4. Keep each reply concise.
5. When agreement is reached, output a final message beginning with:
   Current consensus:
```

## 5b. Initialize windows C and D (for 4-window setup)

**Window C:**
```text
You are Claude window C.

Use only these MCP tools:
- mcp__cc-bridge-3__reply
- mcp__cc-bridge-3__wait_for_messages
- mcp__cc-bridge-3__list_peers
- use mcp__cc-bridge-3__get_messages only for debugging

Do not use any cc-bridge-1/2/4 tools.

Behavior:
1. Do not speak first.
2. Wait for messages.
3. Then continue with wait_for_messages -> reply.
```

**Window D:**
```text
You are Claude window D.

Use only these MCP tools:
- mcp__cc-bridge-4__reply
- mcp__cc-bridge-4__wait_for_messages
- mcp__cc-bridge-4__list_peers
- use mcp__cc-bridge-4__get_messages only for debugging

Do not use any cc-bridge-1/2/3 tools.

Behavior:
1. Do not speak first.
2. Wait for messages.
3. Then continue with wait_for_messages -> reply.
```

## 6. Start a task

Send a concrete task to window A, for example:

```text
Please discuss the concrete meaning of "三人行，必有吾师" with your peer until you reach agreement. Start the conversation now and continue through wait_for_messages -> reply until you can state Current consensus:.
```

Then tell window B:

```text
Start waiting for your peer and continue the discussion until agreement is reached.
```

## 6b. Multi-window routing test

After all 4 windows are initialized, send this to window A:

```text
Test the routing capabilities:
1. Run list_peers to see online windows
2. Send a point-to-point message to B only
3. Send a multicast message to C and D
4. Send a broadcast message to everyone
```

## 7. Recommended operating pattern

- A speaks first.
- B (and others) wait with `wait_for_messages`.
- All windows stay in `wait_for_messages -> reply`.
- Do not manually alternate `get_messages` every turn unless debugging.

## 8. Code review usage

Window A:

```text
Discuss a code review with your peer. Start by sending the files under review, your initial findings, and what you want challenged. Continue until you reach Current consensus:.

Use this language:
- "My independent view is: ..." before stating any position
- "I agree on: ..." / "I disagree on: ..." for specific points
- "Current consensus:" only when both sides have confirmed

Do not merge or proceed until B says "Current consensus from my side:".
```

Window B:

```text
Wait for the review request. Then respond as a challenger: read the actual code before stating any position, cite line numbers, and distinguish blockers from non-blocking gaps.

Use "My independent view is:" before responding. Identify gaps that are "not blocking — follow-up hardening" vs gaps that require changes before merge.

Output "Current consensus from my side:" only when you have verified the diff is good.
```

## 8b. Implementation with challenge cycles (recommended for feature work)

Window A:

```text
You are implementing [FEATURE]. Propose your design contract to B before writing any code. Wait for B's challenge. Only start implementing after you reach "Current consensus:" on the design. After implementation, send a diff summary and wait for B's review challenge. Repeat until B outputs "Current consensus from my side: good to merge".
```

Window B:

```text
You are the challenger for [FEATURE]. When A proposes a design: read the relevant existing code first, then state "My independent view is:" with specific objections grounded in code evidence. When A sends a diff summary: verify the implementation against the agreed contract and identify any gaps. Output "Current consensus from my side: good to merge" only when you are satisfied.
```

## 9. E2E testing usage

Window A:

```text
Discuss an end-to-end test plan with your peer. Start by proposing the entrypoint, sample input, expected output, and success criteria. Continue until you reach Current consensus:.
```

Window B:

```text
Wait for the proposed test plan. Then challenge missing preconditions, failure modes, and validation gaps. Continue until you reach Current consensus:.
```

## 10. Debugging

Check logs:

```bash
# 2 windows
tail -n 80 /tmp/cc-bridge-1.log
tail -n 80 /tmp/cc-bridge-2.log

# 4 windows
tail -n 80 /tmp/cc-bridge-3.log
tail -n 80 /tmp/cc-bridge-4.log
```

Check relay state:

```bash
find /tmp/cc-bridge/default -maxdepth 2 -type f | sort
cat /tmp/cc-bridge/default/messages/*.json
```

Check daemon health:

```bash
curl -s http://127.0.0.1:4512/healthz  # cc-bridge-1
curl -s http://127.0.0.1:4522/healthz  # cc-bridge-2
curl -s http://127.0.0.1:4532/healthz  # cc-bridge-3
curl -s http://127.0.0.1:4542/healthz  # cc-bridge-4
```

## 11. Messenger role rule

When using a 4-window setup with role assignments (PM, Programmer, Consultant, Messenger), **always include the Messenger in the `to` field** of every `reply` call. The Messenger is responsible for message relay and waking up other windows via `SendKeys`.

Example:
```typescript
// Good: Messenger (D) is included
reply(text="[TO:A] report...", to=["A", "D"])

// Good: Broadcast already includes everyone
reply(text="status update")

// Bad: Messenger is missing — target may not be woken up
reply(text="[TO:A] report...", to=["A"])
```

This rule applies regardless of the primary recipient. Even when replying to a single peer, include the Messenger so it can relay and wake the target window if needed.

## 11b. Wake mechanism (Windows SendKeys)

On Windows, the Messenger can wake up other windows by injecting a keystroke via `SendKeys`. This project includes two scripts in `scripts/`:

- `bridge-waker.ps1` — core library: `Wake-Target`, `Parse-Targets`, `Invoke-WakerCheck`
- `bridge-waker-run.ps1` — fixed entry point wrapper (use this for all invocations)

### Why a wrapper?

Do **not** run inline PowerShell like `. script; $text = '...'; Invoke-WakerCheck ...`. Inline commands have dynamic content each time, so permission patterns cannot match reliably. Use the fixed wrapper instead.

### Correct invocation

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bridge-waker-run.ps1 -MessagesText "[TO:A] your message here"
```

### Permission allowlist

Add this pattern to the Messenger's `.claude/settings.local.json`:

```json
"Bash(powershell -NoProfile -ExecutionPolicy Bypass -File */bridge-waker-run.ps1 *)"
```

Select "Yes, and don't ask again" on first use to persist.

### Window title mapping

Edit `$script:WindowTitles` in `bridge-waker.ps1` to match your window titles:

```powershell
$script:WindowTitles = @{
    'A' = 'Claude-A'
    'B' = 'Codex-B'
    'C' = 'Mimo-C'
}
```

## 12. Key rule

- window A only uses `cc-bridge-1`
- window B only uses `cc-bridge-2`
- window C only uses `cc-bridge-3`
- window D only uses `cc-bridge-4`
- prefer `wait_for_messages`
- use `get_messages` only to debug or recover
- **always include Messenger in `to` when replying** (see §11)

## 13. MCP Port Mapping

| Instance | Control Port | Endpoint |
|----------|-------------|----------|
| cc-bridge-1 | 4512 | A |
| cc-bridge-2 | 4522 | B |
| cc-bridge-3 | 4532 | C |
| cc-bridge-4 | 4542 | D |

Ports are calculated as: `4500 + instance * 10 + 2`
