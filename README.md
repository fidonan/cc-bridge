# cc-bridge

Local bridge for peer-to-peer collaboration between two Claude Code windows on the same machine.

Current target architecture:

`Claude Code A <-> cc-bridge <-> Claude Code B`

Start here for the fastest setup:

- [QUICKSTART.md](/Users/fido/Desktop/projects/cc-bridge/QUICKSTART.md)

## Acknowledgement

This project is a modified fork of [`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge).

Many thanks to the original author and contributors for building the initial bridge architecture and proving the value of local agent collaboration. This fork reuses that foundation and extends it toward a different use case.

## Origin and value of the original project

This repository started as a local fork of [`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge).

The original project's value is real and worth preserving:

- It proved that local cross-agent collaboration is practical, not just a demo idea.
- It introduced a clean two-process model:
  - `bridge.ts` as the foreground MCP process
  - `daemon.ts` as the persistent local background daemon
- It separated Claude-facing MCP logic from transport/runtime logic.
- It treated the bridge as a local developer tool instead of a hosted orchestration platform.

In the original design, the main path was:

`Claude Code <-> AgentBridge <-> Codex`

That design is still important because it established the control-plane pattern this fork continues to use.

## What this fork changes

This fork is no longer centered on Codex. It has been adapted into a Claude-to-Claude bridge.

Current goals:

- Two Claude Code windows can exchange messages through isolated MCP instances.
- Each Claude window uses its own bridge instance.
- Messages are relayed locally through a room-scoped relay directory under `/tmp/cc-bridge`.
- The bridge works in pull mode for API-key Claude setups.
- Long-poll waiting is supported so the dialogue can continue without manual `get_messages` prompting every turn.

## Current architecture

```text
┌──────────────────┐      MCP stdio      ┌────────────────────┐
│ Claude Code A    │ ───────────────────▶│ bridge.ts          │
│ instance 1       │ ◀───────────────────│ foreground client  │
└──────────────────┘                     └─────────┬──────────┘
                                                   │
                                                   │ local control WS
                                                   ▼
                                         ┌────────────────────┐
                                         │ daemon.ts          │
                                         │ instance 1 daemon  │
                                         └─────────┬──────────┘
                                                   │
                                                   │ file relay room
                                                   ▼
                                         /tmp/cc-bridge/<room>
                                                   ▲
                                                   │
                                         ┌─────────┴──────────┐
                                         │ daemon.ts          │
                                         │ instance 2 daemon  │
                                         └─────────┬──────────┘
                                                   │
                                                   │ local control WS
                                                   ▼
┌──────────────────┐      MCP stdio      ┌────────────────────┐
│ Claude Code B    │ ───────────────────▶│ bridge.ts          │
│ instance 2       │ ◀───────────────────│ foreground client  │
└──────────────────┘                     └────────────────────┘
```

## Why this fork needed extra changes

The original Codex workflow felt more "automatic" because Codex exposed a persistent event stream that could be pushed into Claude.

Claude-to-Claude is different:

- both sides are MCP clients
- both sides often run in pull mode
- Claude MCP frontends are short-lived processes

That means a simple `get_messages` tool is not enough for natural dialogue. This fork therefore adds:

- daemon-owned unread message queues
- reconnect-safe pull delivery
- `wait_for_messages` long-polling for continuous back-and-forth

## Current status

Implemented:

- multi-instance MCP setup (`cc-bridge-1`, `cc-bridge-2`)
- isolated per-instance ports, pid files, and logs
- local room relay under `/tmp/cc-bridge`
- daemon-side unread queue
- reconnect-safe `reply`
- `get_messages`
- `wait_for_messages`
- two-Claude automatic discussion validated locally

Validated locally:

- A can send to B
- B can reply to A
- both sides can continue a multi-turn exchange until they produce `Current consensus:`

Current constraints:

- still local-only
- still one active foreground Claude connection per instance
- not a hosted multi-tenant system
- not a generic agent bus for arbitrary providers

## Important files

- [src/bridge.ts](/Users/fido/Desktop/projects/cc-bridge/src/bridge.ts)
- [src/daemon.ts](/Users/fido/Desktop/projects/cc-bridge/src/daemon.ts)
- [src/daemon-client.ts](/Users/fido/Desktop/projects/cc-bridge/src/daemon-client.ts)
- [src/claude-adapter.ts](/Users/fido/Desktop/projects/cc-bridge/src/claude-adapter.ts)
- [src/control-protocol.ts](/Users/fido/Desktop/projects/cc-bridge/src/control-protocol.ts)
- [src/instance-config.ts](/Users/fido/Desktop/projects/cc-bridge/src/instance-config.ts)
- [MULTI_CLAUDE_WINDOWS.md](/Users/fido/Desktop/projects/cc-bridge/MULTI_CLAUDE_WINDOWS.md)
- [SOP.md](/Users/fido/Desktop/projects/cc-bridge/SOP.md)

## Quick start

Install dependencies:

```bash
cd /Users/fido/Desktop/projects/cc-bridge
bun install
```

Register two MCP instances:

```bash
bash ./scripts/cc-bridge-register-instance.sh 1 cc-bridge-1
bash ./scripts/cc-bridge-register-instance.sh 2 cc-bridge-2
```

Check registration:

```bash
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2
```

Then follow:

- [QUICKSTART.md](/Users/fido/Desktop/projects/cc-bridge/QUICKSTART.md)
- [MULTI_CLAUDE_WINDOWS.md](/Users/fido/Desktop/projects/cc-bridge/MULTI_CLAUDE_WINDOWS.md)
- [SOP.md](/Users/fido/Desktop/projects/cc-bridge/SOP.md)
- [PROMPTS.md](/Users/fido/Desktop/projects/cc-bridge/PROMPTS.md)
- [PUBLISHING.md](/Users/fido/Desktop/projects/cc-bridge/PUBLISHING.md)

## Logs and relay state

Logs:

- instance 1: `/tmp/cc-bridge-1.log`
- instance 2: `/tmp/cc-bridge-2.log`

Relay state:

- `/tmp/cc-bridge/default`

## Notable difference from the upstream project

Upstream `agent-bridge` remains valuable as a Claude-to-Codex collaboration bridge.

This fork does not replace that value. It repurposes the same local bridge pattern for a different use case:

- upstream: Claude Code ↔ Codex
- this fork: Claude Code A ↔ Claude Code B
