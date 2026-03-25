# cc-bridge Multi-Claude Windows Setup

This fork is now aimed at one goal:

`Claude Code A <-> cc-bridge <-> Claude Code B`

No Codex is required.

## How it works

Each Claude window uses its own MCP server instance:

- `cc-bridge-1`
- `cc-bridge-2`

Both instances join the same local room by default, so messages written by one
instance are delivered to the other through a local relay directory under
`/tmp/cc-bridge`.

## Register two instances

From this directory:

```bash
bash ./scripts/cc-bridge-register-instance.sh 1 cc-bridge-1
bash ./scripts/cc-bridge-register-instance.sh 2 cc-bridge-2
```

Check:

```bash
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2
```

## Open two Claude Code windows

Open Claude window A and Claude window B normally.

Both windows will see both MCP servers, so you must tell each one which bridge
instance to use.

## Prompt for Claude window A

```text
You are Claude window A.

Use only these MCP tools from server cc-bridge-1:
- mcp__cc-bridge-1__reply
- mcp__cc-bridge-1__wait_for_messages
- use mcp__cc-bridge-1__get_messages only for debugging

Do not use cc-bridge-2 tools.

Your peer is Claude window B.
You initiate the discussion.
Send the first message yourself.
After that, continue with:
wait_for_messages -> analyze -> reply
```

## Prompt for Claude window B

```text
You are Claude window B.

Use only these MCP tools from server cc-bridge-2:
- mcp__cc-bridge-2__reply
- mcp__cc-bridge-2__wait_for_messages
- use mcp__cc-bridge-2__get_messages only for debugging

Do not use cc-bridge-1 tools.

Your peer is Claude window A.
Wait for A's message first.
After that, continue with:
wait_for_messages -> analyze -> reply
```

## Expected behavior

- A sends a message through `cc-bridge-1`
- B receives it through `cc-bridge-2`
- B replies through `cc-bridge-2`
- A receives it through `cc-bridge-1`

## Logs

Each instance writes a separate log file:

- `cc-bridge-1` -> `/tmp/cc-bridge-1.log`
- `cc-bridge-2` -> `/tmp/cc-bridge-2.log`

## Relay state

The local relay directory is:

```text
/tmp/cc-bridge/default
```

It contains:

- `peers/` heartbeat files
- `messages/` exchanged messages

## If one side does not receive messages

1. Check both MCP servers exist:

```bash
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2
```

2. Check logs:

```bash
tail -f /tmp/cc-bridge-1.log
tail -f /tmp/cc-bridge-2.log
```

3. Make sure window A only uses `cc-bridge-1` tools and window B only uses
   `cc-bridge-2` tools.

4. If needed, restart both Claude windows after clearing relay state:

```bash
rm -rf /tmp/cc-bridge/default
```
