# cc-bridge

Local bridge for sustained collaboration between multiple Claude Code windows on the same machine.

中文文档：[README.zh-CN.md](README.zh-CN.md)

## Architecture

```text
┌──────────────────┐      MCP stdio      ┌────────────────────┐
│ Claude Code A    │ ────────────────────▶│ bridge.ts          │
│                  │ ◀────────────────────│ (MCP frontend)     │
└──────────────────┘                      └─────────┬──────────┘
                                                    │ local WS
                                                    ▼
                                          ┌────────────────────┐
                                          │ daemon.ts          │
                                          │ (background)       │
                                          └─────────┬──────────┘
                                                    │ file relay
                                                    ▼
                                          /tmp/cc-bridge/<room>
                                                    ▲
                                                    │
                                          ┌─────────┴──────────┐
                                          │ daemon.ts          │
                                          │ (background)       │
                                          └─────────┬──────────┘
                                                    │ local WS
                                                    ▼
┌──────────────────┐      MCP stdio      ┌────────────────────┐
│ Claude Code B    │ ────────────────────▶│ bridge.ts          │
│                  │ ◀────────────────────│ (MCP frontend)     │
└──────────────────┘                      └────────────────────┘
```

Supports 2–N windows with point-to-point, multicast, and broadcast routing.

## Quick Start

```bash
git clone https://github.com/fidonan/cc-bridge
cd cc-bridge
bun run setup
```

This installs dependencies and registers `cc-bridge-1` + `cc-bridge-2` as MCP servers.

Then open two Claude Code windows in the project directory and start collaborating. See [QUICKSTART.md](QUICKSTART.md) for step-by-step instructions.

## MCP Tools

| Tool | Description |
|------|-------------|
| `reply(text, to?, scope?)` | Send a message. Omit `to` to broadcast. `scope="global"` sends across rooms. |
| `get_messages` | Pull unread messages. |
| `wait_for_messages(timeout_ms?)` | Long-poll for new messages. |
| `list_peers` | List online peers in the current room. |
| `list_all_peers` | List all peers across all rooms. |
| `launch_peers(targets?)` | Launch peer Claude Code windows. |

## Multi-Window Routing

```typescript
// Point-to-point
reply(text="hello", to=["B"])

// Multicast
reply(text="hello", to=["C", "D"])

// Broadcast (default)
reply(text="hello")
```

## 4-Window Roles

The recommended 4-window setup assigns each window a role:

| Window | Instance | Role | Responsibility |
|--------|----------|------|----------------|
| A | cc-bridge-1 | PM / Initiator | Starts discussions, proposes designs, drives tasks |
| B | cc-bridge-2 | Programmer / Challenger | Reviews code, challenges assumptions, verifies implementations |
| C | cc-bridge-3 | Consultant / Reviewer | Provides independent analysis, catches blind spots |
| D | cc-bridge-4 | **Messenger / Relay** | Relays messages, wakes up idle windows via SendKeys |

### Messenger Role (Window D) — Important

The Messenger is a **critical relay role**. Because Claude Code windows on Windows do not automatically receive keystroke notifications when messages arrive, the Messenger uses `SendKeys` to wake up idle windows so they check for new messages.

**Core rules:**

1. **Always include the Messenger in `to`** — every `reply` call must include `"D"` in the `to` field, even when sending to a single peer:

   ```typescript
   // Correct: Messenger included
   reply(text="[TO:A] report...", to=["A", "D"])

   // Wrong: Messenger missing — target may not wake up
   reply(text="[TO:A] report...", to=["A"])
   ```

2. **Broadcast already includes everyone** — `reply(text="...")` without `to` is fine.

3. **Messenger parses `[TO:X]` tags** — when the Messenger receives a message containing `[TO:A]`, `[TO:B]`, or `[TO:ALL]`, it invokes the wake script to activate the target window.

4. **Wake mechanism** — the Messenger calls `bridge-waker-run.ps1` via Bash:

   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bridge-waker-run.ps1 -MessagesText "[TO:A] your message here"
   ```

   This uses `WScript.Shell.AppActivate` + `SendKeys` to bring the target window to focus and inject a wake-up keystroke.

5. **Window title mapping** — edit `$script:WindowTitles` in `scripts/bridge-waker.ps1` to match your terminal titles:

   ```powershell
   $script:WindowTitles = @{
       'A' = 'Claude-A'
       'B' = 'Codex-B'
       'C' = 'Mimo-C'
   }
   ```

6. **Permission allowlist** — add this pattern to the Messenger's `.claude/settings.local.json` to avoid repeated prompts:

   ```json
   "Bash(powershell -NoProfile -ExecutionPolicy Bypass -File */bridge-waker-run.ps1 *)"
   ```

**Messenger prompt template:**

```text
You are Claude window D — the Messenger.

Use only these MCP tools:
- mcp__cc-bridge-4__reply
- mcp__cc-bridge-4__wait_for_messages
- mcp__cc-bridge-4__list_peers
- mcp__cc-bridge-4__get_messages (for debugging only)

Do not use cc-bridge-1/2/3 tools.

Your role:
1. Relay messages between other windows.
2. When you receive a message with a [TO:X] tag, wake up window X by running:
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bridge-waker-run.ps1 -MessagesText "<the message text>"
3. When replying, always include yourself in the to field: to=["A", "D"] or to=["B", "D"] etc.
4. Keep relay messages brief.
5. You do not participate in technical discussions — you only relay and wake.
```

See [SOP.md](SOP.md) for the full operating procedure.

## Key Files

- [src/bridge.ts](src/bridge.ts) — MCP frontend, connects Claude to daemon
- [src/daemon.ts](src/daemon.ts) — Background process, manages rooms and message relay
- [src/claude-adapter.ts](src/claude-adapter.ts) — MCP server tool definitions
- [src/control-protocol.ts](src/control-protocol.ts) — WebSocket control protocol types
- [src/instance-config.ts](src/instance-config.ts) — Per-instance port/pid/log config

## Documentation

- [QUICKSTART.md](QUICKSTART.md) — Get running in 5 minutes
- [MULTI_CLAUDE_WINDOWS.md](MULTI_CLAUDE_WINDOWS.md) — Multi-window setup guide
- [SOP.md](SOP.md) — Standard operating procedures
- [PROMPTS.md](PROMPTS.md) — Prompt templates for peer windows
- [PUBLISHING.md](PUBLISHING.md) — How to publish new versions

## Logs

```
/tmp/cc-bridge-1.log    # instance 1
/tmp/cc-bridge-2.log    # instance 2
/tmp/cc-bridge/<room>/  # relay state
```

## Credits

This project is a fork of [`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge). The original project established the local bridge architecture and the dual-process model (foreground MCP + background daemon) that cc-bridge continues to build on.

## License

[MIT](LICENSE)
