# cc-bridge Multi-Claude Windows Setup

This fork now supports **N windows** with flexible routing:

`Claude Code A <-> cc-bridge <-> Claude Code B [C D ...]`

No Codex is required.

## v0.2.0 New Features

- **Point-to-point**: `reply(text, to=["B"])`
- **Multicast**: `reply(text, to=["C", "D"])`
- **Broadcast**: `reply(text)` (default)
- **list_peers**: View online windows

## How it works

Each Claude window uses its own MCP server instance:

- `cc-bridge-1` → endpoint A
- `cc-bridge-2` → endpoint B
- `cc-bridge-3` → endpoint C
- `cc-bridge-4` → endpoint D

All instances join the same local room by default, so messages written by one instance are delivered to others through a local relay directory under `/tmp/cc-bridge`.

## Register instances

### 2 windows

```bash
bash ./scripts/cc-bridge-register-instance.sh 1 cc-bridge-1
bash ./scripts/cc-bridge-register-instance.sh 2 cc-bridge-2
```

### 4 windows

```bash
cd cc-bridge

for i in 1 2 3 4; do
  EP=$(echo "A B C D" | tr ' ' '\n' | sed -n "${i}p")
  claude mcp add-json -s user "cc-bridge-${i}" "{
    \"type\":\"stdio\",
    \"command\":\"bun\",
    \"args\":[\"run\",\"$(pwd)/src/bridge.ts\"],
    \"env\":{
      \"AGENTBRIDGE_INSTANCE\":\"${i}\",
      \"AGENTBRIDGE_BASE_PORT\":\"4500\",
      \"AGENTBRIDGE_PORT_STRIDE\":\"10\",
      \"AGENTBRIDGE_MODE\":\"pull\",
      \"CC_BRIDGE_ROOM\":\"default\",
      \"CC_BRIDGE_ENDPOINT\":\"${EP}\"
    }
  }"
done
```

Check:

```bash
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2
claude mcp get cc-bridge-3
claude mcp get cc-bridge-4
```

## Open Claude Code windows

Open Claude window A, B, C, D normally.

Each window will see all MCP servers, so you must tell each one which bridge instance to use.

## Prompt for Claude window A

```text
You are Claude window A.

Use only these MCP tools from server cc-bridge-1:
- mcp__cc-bridge-1__reply
- mcp__cc-bridge-1__wait_for_messages
- mcp__cc-bridge-1__list_peers
- use mcp__cc-bridge-1__get_messages only for debugging

Do not use cc-bridge-2/3/4 tools.

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
- mcp__cc-bridge-2__list_peers
- use mcp__cc-bridge-2__get_messages only for debugging

Do not use cc-bridge-1/3/4 tools.

Your peer is Claude window A.
Wait for A's message first.
After that, continue with:
wait_for_messages -> analyze -> reply
```

## Prompt for Claude window C

```text
You are Claude window C.

Use only these MCP tools from server cc-bridge-3:
- mcp__cc-bridge-3__reply
- mcp__cc-bridge-3__wait_for_messages
- mcp__cc-bridge-3__list_peers
- use mcp__cc-bridge-3__get_messages only for debugging

Do not use cc-bridge-1/2/4 tools.

Wait for messages from other windows.
Continue with:
wait_for_messages -> analyze -> reply
```

## Prompt for Claude window D

```text
You are Claude window D.

Use only these MCP tools from server cc-bridge-4:
- mcp__cc-bridge-4__reply
- mcp__cc-bridge-4__wait_for_messages
- mcp__cc-bridge-4__list_peers
- use mcp__cc-bridge-4__get_messages only for debugging

Do not use cc-bridge-1/2/3 tools.

Wait for messages from other windows.
Continue with:
wait_for_messages -> analyze -> reply
```

## Routing Examples

### Point-to-point (A → B)

In window A:
```text
reply(text="Hello B", to=["B"])
```

### Multicast (A → C, D)

In window A:
```text
reply(text="Hello C and D", to=["C", "D"])
```

### Broadcast (D → ALL)

In window D:
```text
reply(text="Hello everyone")
```

### List peers

In any window:
```text
list_peers
```

Expected output: `Active peers in room: A, B, C, D`

## Expected behavior

- A sends a message through `cc-bridge-1` with optional `to` parameter
- Target window(s) receive it through their respective `cc-bridge-N`
- Target window(s) reply through their own bridge
- Original sender receives the reply

## Logs

Each instance writes a separate log file:

- `cc-bridge-1` → `/tmp/cc-bridge-1.log`
- `cc-bridge-2` → `/tmp/cc-bridge-2.log`
- `cc-bridge-3` → `/tmp/cc-bridge-3.log`
- `cc-bridge-4` → `/tmp/cc-bridge-4.log`

## Relay state

The local relay directory is:

```text
/tmp/cc-bridge/default
```

It contains:

- `peers/` - heartbeat files for each endpoint
- `messages/` - exchanged message files
- `acks/` - per-message ack files (v0.2.0)

## If one side does not receive messages

1. Check all MCP servers exist:

```bash
claude mcp list
```

2. Check logs:

```bash
tail -f /tmp/cc-bridge-1.log
tail -f /tmp/cc-bridge-2.log
```

3. Check daemon health:

```bash
curl -s http://127.0.0.1:4512/healthz  # cc-bridge-1
curl -s http://127.0.0.1:4522/healthz  # cc-bridge-2
```

4. Make sure each window only uses its respective bridge tools.

5. If needed, restart all Claude windows after clearing relay state:

```bash
pkill -f 'cc-bridge/src/daemon.ts'
rm -rf /tmp/cc-bridge/default
```
