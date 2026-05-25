# cc-bridge Quickstart

## Goal

Get two or more Claude Code windows talking to each other through `cc-bridge` in a few minutes.

## v0.2.0: Multi-Window Support

v0.2.0 supports **N windows** with flexible routing:
- **Point-to-point**: A → B
- **Multicast**: A → C, D
- **Broadcast**: D → ALL

### New in v0.2.0

```typescript
// Point-to-point: only B receives
reply(text="hello", to=["B"])

// Multicast: C and D receive
reply(text="hello", to=["C", "D"])

// Broadcast: all windows receive (default)
reply(text="hello")

// List online peers
list_peers  // returns: "Active peers in room: A, B, C, D"
```

## If you don't want to type shell commands yourself

You can paste this directly into Claude Code:

```text
Please help me set up cc-bridge on this machine.

Steps:
1. Clone https://github.com/fidonan/cc-bridge
2. Enter the project directory
3. Run bun run setup
4. Verify cc-bridge-1 and cc-bridge-2 are available
5. Then tell me how to open two Claude Code windows and start the first test discussion
```

If the repo is already on disk, use:

```text
Please enter the local cc-bridge project, run bun run setup, verify cc-bridge-1 and cc-bridge-2, and then tell me how to start.
```

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

## 2. Manual alternative (2 windows)

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

## 2b. Manual alternative (4 windows)

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

## 3. Open Claude Code windows

For 2 windows, open both:

```bash
cd cc-bridge
claude
```

For 4 windows, open four terminals, each running:

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
- mcp__cc-bridge-1__list_peers
- use mcp__cc-bridge-1__get_messages only if debugging is needed

Do not use any cc-bridge-2/3/4 tools.

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
- mcp__cc-bridge-2__list_peers
- use mcp__cc-bridge-2__get_messages only if debugging is needed

Do not use any cc-bridge-1/3/4 tools.

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
Please discuss the meaning of "三人行，必有吾师" with your peer until you reach agreement. Start now and keep going until you can state Current consensus:.
```

Send this to window B:

```text
Start waiting for your peer and continue the discussion until agreement is reached.
```

## 6b. Multi-window test (4 windows)

After all 4 windows are initialized, test routing in window A:

```text
Please test the routing:
1. Run list_peers to see online windows
2. Send a point-to-point message to B only: reply(text="A→B", to=["B"])
3. Send a multicast to C and D: reply(text="A→CD", to=["C", "D"])
4. Send a broadcast to everyone: reply(text="A→ALL")
```

Then verify each target window received the correct message.

## 7. Expected result

- A sends the first message
- B receives it and replies
- A and B continue automatically through `wait_for_messages`
- both sides eventually produce `Current consensus:`

## 8. If something looks stuck

Check logs:

```bash
# For 2 windows
tail -n 80 /tmp/cc-bridge-1.log
tail -n 80 /tmp/cc-bridge-2.log

# For 4 windows
tail -n 80 /tmp/cc-bridge-3.log
tail -n 80 /tmp/cc-bridge-4.log
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
