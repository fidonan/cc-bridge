# cc-bridge Quickstart

## Goal

Get two Claude Code windows talking to each other through `cc-bridge` in a few minutes.

## 1. Run setup

```bash
cd cc-bridge
bun run setup
```

This will:

- install dependencies
- register `cc-bridge-1`
- register `cc-bridge-2`
- verify both MCP entries

## 2. Manual alternative

```bash
bun install
bash ./scripts/cc-bridge-register-instance.sh 1 cc-bridge-1
bash ./scripts/cc-bridge-register-instance.sh 2 cc-bridge-2
```

Check:

```bash
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2
```

## 3. Open two Claude Code windows

In both windows:

```bash
cd cc-bridge
claude
```

## 4. Initialize window A

Paste this into Claude window A:

```text
You are Claude window A.

Use only these MCP tools:
- mcp__cc-bridge-1__reply
- mcp__cc-bridge-1__wait_for_messages
- use mcp__cc-bridge-1__get_messages only if debugging is needed

Do not use any cc-bridge-2 tools.

Behavior:
1. You start the discussion yourself.
2. After sending a message, continue with:
   wait_for_messages(timeout_ms=30000) -> read -> reply
3. Keep replies short.
4. When agreement is reached, output:
   Current consensus:
```

## 5. Initialize window B

Paste this into Claude window B:

```text
You are Claude window B.

Use only these MCP tools:
- mcp__cc-bridge-2__reply
- mcp__cc-bridge-2__wait_for_messages
- use mcp__cc-bridge-2__get_messages only if debugging is needed

Do not use any cc-bridge-1 tools.

Behavior:
1. Do not speak first.
2. Wait for A's message.
3. Then continue with:
   wait_for_messages(timeout_ms=30000) -> read -> reply
4. Keep replies short.
5. When agreement is reached, output:
   Current consensus:
```

## 6. Start a test discussion

Send this to window A:

```text
Please discuss the meaning of “三人行，必有吾师” with your peer until you reach agreement. Start now and keep going until you can state Current consensus:.
```

Send this to window B:

```text
Start waiting for your peer and continue the discussion until agreement is reached.
```

## 7. Expected result

- A sends the first message
- B receives it and replies
- A and B continue automatically through `wait_for_messages`
- both sides eventually produce `Current consensus:`

## 8. If something looks stuck

Check logs:

```bash
tail -n 80 /tmp/cc-bridge-1.log
tail -n 80 /tmp/cc-bridge-2.log
```

Reset relay state if needed:

```bash
rm -rf /tmp/cc-bridge/default
```

Then reopen both Claude windows and try again.

## 9. Where to go next

- Full usage guide: [SOP.md](SOP.md)
- Multi-window notes: [MULTI_CLAUDE_WINDOWS.md](MULTI_CLAUDE_WINDOWS.md)
- Project overview: [README.md](README.md)
- Prompt templates: [PROMPTS.md](PROMPTS.md)
