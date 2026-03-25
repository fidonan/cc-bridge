# cc-bridge SOP

## Goal

Use two Claude Code windows to carry on a continuous dialogue through `cc-bridge` until they reach a clear conclusion.

## 1. Check MCP registration

```bash
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2
```

## 2. Clean old relay state when needed

```bash
pkill -f 'cc-bridge/src/daemon.ts'
rm -rf /tmp/cc-bridge/default
rm -f /tmp/cc-bridge-1.log /tmp/cc-bridge-2.log
```

## 3. Open two Claude Code windows

In both windows:

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
- use mcp__cc-bridge-1__get_messages only for debugging

Do not use any cc-bridge-2 tools.

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
- use mcp__cc-bridge-2__get_messages only for debugging

Do not use any cc-bridge-1 tools.

Behavior:
1. Do not speak first.
2. Wait for A's message.
3. Then repeat:
   wait_for_messages(timeout_ms=30000) -> read -> reply
4. Keep each reply concise.
5. When agreement is reached, output a final message beginning with:
   Current consensus:
```

## 6. Start a task

Send a concrete task to window A, for example:

```text
Please discuss the concrete meaning of “三人行，必有吾师” with your peer until you reach agreement. Start the conversation now and continue through wait_for_messages -> reply until you can state Current consensus:.
```

Then tell window B:

```text
Start waiting for your peer and continue the discussion until agreement is reached.
```

## 7. Recommended operating pattern

- A speaks first.
- B waits with `wait_for_messages`.
- A and B both stay in `wait_for_messages -> reply`.
- Do not manually alternate `get_messages` every turn unless debugging.

## 8. Code review usage

Window A:

```text
Discuss a code review with your peer. Start by sending the files under review, your initial findings, and what you want challenged. Continue until you reach Current consensus:.
```

Window B:

```text
Wait for the review request. Then respond as a reviewer focusing on bugs, regressions, interface mismatches, and missing tests. Continue until you reach Current consensus:.
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
tail -n 80 /tmp/cc-bridge-1.log
tail -n 80 /tmp/cc-bridge-2.log
```

Check relay state:

```bash
find /tmp/cc-bridge/default -maxdepth 2 -type f | sort
cat /tmp/cc-bridge/default/messages/*.json
```

## 11. Key rule

- window A only uses `cc-bridge-1`
- window B only uses `cc-bridge-2`
- prefer `wait_for_messages`
- use `get_messages` only to debug or recover
