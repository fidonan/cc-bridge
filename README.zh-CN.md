# cc-bridge

同一台机器上多个 Claude Code 窗口的本地协作 Bridge。

English: [README.md](README.md)

## 架构

```text
┌──────────────────┐      MCP stdio      ┌────────────────────┐
│ Claude Code A    │ ────────────────────▶│ bridge.ts          │
│                  │ ◀────────────────────│ (MCP 前端)          │
└──────────────────┘                      └─────────┬──────────┘
                                                    │ 本地 WS
                                                    ▼
                                          ┌────────────────────┐
                                          │ daemon.ts          │
                                          │ (后台进程)          │
                                          └─────────┬──────────┘
                                                    │ 文件 relay
                                                    ▼
                                          /tmp/cc-bridge/<room>
                                                    ▲
                                                    │
                                          ┌─────────┴──────────┐
                                          │ daemon.ts          │
                                          │ (后台进程)          │
                                          └─────────┬──────────┘
                                                    │ 本地 WS
                                                    ▼
┌──────────────────┐      MCP stdio      ┌────────────────────┐
│ Claude Code B    │ ────────────────────▶│ bridge.ts          │
│                  │ ◀────────────────────│ (MCP 前端)          │
└──────────────────┘                      └────────────────────┘
```

支持 2–N 个窗口，点对点、多播、广播路由。

## 快速开始

```bash
git clone https://github.com/fidonan/cc-bridge
cd cc-bridge
bun run setup
```

自动安装依赖并注册 `cc-bridge-1` 和 `cc-bridge-2` 为 MCP 服务器。

然后在项目目录打开两个 Claude Code 窗口即可开始协作。详见 [QUICKSTART.md](QUICKSTART.md)。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `reply(text, to?, scope?)` | 发送消息。省略 `to` 则广播。`scope="global"` 跨房间发送。 |
| `get_messages` | 拉取未读消息。 |
| `wait_for_messages(timeout_ms?)` | 长轮询等待新消息。 |
| `list_peers` | 列出当前房间在线 peer。 |
| `list_all_peers` | 列出所有房间的 peer。 |
| `launch_peers(targets?)` | 启动 peer Claude Code 窗口。 |

## 多窗口路由

```typescript
// 点对点
reply(text="hello", to=["B"])

// 多播
reply(text="hello", to=["C", "D"])

// 广播（默认）
reply(text="hello")
```

## 四窗口角色设定

推荐的四窗口配置中，每个窗口承担一个角色：

| 窗口 | 实例 | 角色 | 职责 |
|------|------|------|------|
| A | cc-bridge-1 | PM / 发起者 | 发起讨论、提出设计方案、驱动任务 |
| B | cc-bridge-2 | 程序员 / 挑战者 | 审查代码、挑战假设、验证实现 |
| C | cc-bridge-3 | 顾问 / 审阅者 | 提供独立分析、发现盲区 |
| D | cc-bridge-4 | **Messenger / 信使** | 中继消息、通过 SendKeys 唤醒空闲窗口 |

### Messenger 角色（窗口 D）— 重点说明

Messenger 是一个**关键的中继角色**。由于 Windows 上的 Claude Code 窗口在收到消息时不会自动获得键盘通知，Messenger 需要使用 `SendKeys` 来唤醒空闲窗口，让它们检查新消息。

**核心规则：**

1. **所有 reply 调用都必须在 `to` 中包含 Messenger** — 即使只发给单个 peer，也要加上 `"D"`：

   ```typescript
   // 正确：包含了 Messenger
   reply(text="[TO:A] 汇报...", to=["A", "D"])

   // 错误：没有 Messenger — 目标窗口可能不会被唤醒
   reply(text="[TO:A] 汇报...", to=["A"])
   ```

2. **广播天然包含所有人** — 不带 `to` 的 `reply(text="...")` 没问题。

3. **Messenger 解析 `[TO:X]` 标签** — 当 Messenger 收到包含 `[TO:A]`、`[TO:B]` 或 `[TO:ALL]` 的消息时，调用唤醒脚本激活目标窗口。

4. **唤醒机制** — Messenger 通过 Bash 调用 `bridge-waker-run.ps1`：

   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bridge-waker-run.ps1 -MessagesText "[TO:A] 你的消息内容"
   ```

   脚本使用 `WScript.Shell.AppActivate` + `SendKeys` 将目标窗口切到前台，并注入一条唤醒按键。

5. **窗口标题映射** — 编辑 `scripts/bridge-waker.ps1` 中的 `$script:WindowTitles` 以匹配你的终端标题：

   ```powershell
   $script:WindowTitles = @{
       'A' = 'Claude-A'
       'B' = 'Codex-B'
       'C' = 'Mimo-C'
   }
   ```

6. **权限白名单** — 在 Messenger 的 `.claude/settings.local.json` 中添加此模式，避免反复弹出确认：

   ```json
   "Bash(powershell -NoProfile -ExecutionPolicy Bypass -File */bridge-waker-run.ps1 *)"
   ```

**Messenger Prompt 模板：**

```text
你是 Claude 窗口 D — Messenger（信使）。

只能使用以下 MCP 工具：
- mcp__cc-bridge-4__reply
- mcp__cc-bridge-4__wait_for_messages
- mcp__cc-bridge-4__list_peers
- mcp__cc-bridge-4__get_messages（仅调试用）

不要使用 cc-bridge-1/2/3 的工具。

你的职责：
1. 在其他窗口之间中继消息。
2. 当你收到带有 [TO:X] 标签的消息时，运行以下命令唤醒窗口 X：
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bridge-waker-run.ps1 -MessagesText "<消息文本>"
3. 回复时，必须把自己包含在 to 字段中：to=["A", "D"] 或 to=["B", "D"] 等。
4. 中继消息保持简短。
5. 你不参与技术讨论 — 只负责中继和唤醒。
```

详见 [SOP.md](SOP.md)。

## 关键文件

- [src/bridge.ts](src/bridge.ts) — MCP 前端，连接 Claude 与 daemon
- [src/daemon.ts](src/daemon.ts) — 后台进程，管理房间和消息中继
- [src/claude-adapter.ts](src/claude-adapter.ts) — MCP 工具定义
- [src/control-protocol.ts](src/control-protocol.ts) — WebSocket 控制协议类型
- [src/instance-config.ts](src/instance-config.ts) — 实例端口/pid/日志配置

## 文档

- [QUICKSTART.md](QUICKSTART.md) — 5 分钟快速上手
- [MULTI_CLAUDE_WINDOWS.md](MULTI_CLAUDE_WINDOWS.md) — 多窗口配置指南
- [SOP.md](SOP.md) — 标准操作流程
- [PROMPTS.md](PROMPTS.md) — Peer 窗口的 Prompt 模板
- [PUBLISHING.md](PUBLISHING.md) — 版本发布说明

## 日志

```
/tmp/cc-bridge-1.log    # 实例 1
/tmp/cc-bridge-2.log    # 实例 2
/tmp/cc-bridge/<room>/  # relay 状态
```

## 致谢

本项目 fork 自 [`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge)。原项目建立了本地 bridge 架构和双进程模型（前台 MCP + 后台 daemon），cc-bridge 在此基础上继续发展。

## 许可证

[MIT](LICENSE)
