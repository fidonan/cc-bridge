# cc-bridge

English version: [README.md](README.md)

用于同一台机器上两个 Claude Code 窗口点对点协作的本地 Bridge。

当前目标架构：

`Claude Code A <-> cc-bridge <-> Claude Code B`

如果你想最快开始，请先看：

- [QUICKSTART.md](QUICKSTART.md)

## 致谢

这个项目是基于 [`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge) 修改而来的 fork。

感谢原作者和贡献者搭建了最初的 bridge 架构，并证明了本地 agent 协作这条路线的价值。当前这个 fork 是在那个基础之上，面向另一类使用场景做的延伸和实验。

## 原项目的价值

这个仓库最初来自 [`raysonmeng/agent-bridge`](https://github.com/raysonmeng/agent-bridge) 的本地 fork。

原项目的价值非常明确，而且值得保留：

- 它证明了本地多 Agent 协作不是概念演示，而是可以真正落地的开发工作流。
- 它建立了一个很干净的双进程模型：
  - `bridge.ts` 作为前台 MCP 进程
  - `daemon.ts` 作为常驻本地后台进程
- 它把 Claude 侧的 MCP 逻辑和底层传输/运行时逻辑分离开了。
- 它把 bridge 定位成一个本地开发工具，而不是托管式编排平台。

原始设计中的主链路是：

`Claude Code <-> AgentBridge <-> Codex`

这个设计依然有价值，因为当前 fork 继续沿用了它的控制面思路。

## 当前 fork 改了什么

这个 fork 已经不再以 Codex 为中心，而是改造成了 Claude-to-Claude bridge。

当前目标是：

- 两个 Claude Code 窗口通过各自独立的 MCP 实例交换消息
- 每个 Claude 窗口绑定自己的 bridge 实例
- 消息通过 `/tmp/cc-bridge` 下的本地 room relay 转发
- 支持 API key 模式下的 pull 工作方式
- 支持长轮询等待，使对话不必每一轮都靠手工 `get_messages`

## 当前架构

```text
┌──────────────────┐      MCP stdio      ┌────────────────────┐
│ Claude Code A    │ ───────────────────▶│ bridge.ts          │
│ 实例 1           │ ◀───────────────────│ 前台客户端          │
└──────────────────┘                     └─────────┬──────────┘
                                                   │
                                                   │ 本地控制 WS
                                                   ▼
                                         ┌────────────────────┐
                                         │ daemon.ts          │
                                         │ 实例 1 后台进程     │
                                         └─────────┬──────────┘
                                                   │
                                                   │ 文件 relay room
                                                   ▼
                                         /tmp/cc-bridge/<room>
                                                   ▲
                                                   │
                                         ┌─────────┴──────────┐
                                         │ daemon.ts          │
                                         │ 实例 2 后台进程     │
                                         └─────────┬──────────┘
                                                   │
                                                   │ 本地控制 WS
                                                   ▼
┌──────────────────┐      MCP stdio      ┌────────────────────┐
│ Claude Code B    │ ───────────────────▶│ bridge.ts          │
│ 实例 2           │ ◀───────────────────│ 前台客户端          │
└──────────────────┘                     └────────────────────┘
```

## 为什么这次 fork 还需要额外改造

原来 `Codex` 那条链路看起来更“自动”，是因为 Codex 能提供持续事件流，bridge 可以把这些事件主动推给 Claude。

但 `Claude <-> Claude` 不一样：

- 两边都是 MCP 客户端
- 两边经常运行在 pull 模式
- Claude 的 MCP 前端通常是短生命周期进程

这意味着单纯的 `get_messages` 不足以形成自然连续的对话。所以当前 fork 额外补了：

- daemon 持有的未读消息队列
- 可重连的 pull 投递
- `wait_for_messages` 长轮询能力

## 当前状态

已经实现：

- 多实例 MCP 配置（`cc-bridge-1`、`cc-bridge-2`）
- 每个实例独立端口、pid 文件、日志
- `/tmp/cc-bridge` 下的本地 room relay
- daemon 侧未读消息队列
- 可重连的 `reply`
- `get_messages`
- `wait_for_messages`
- 两个 Claude 自动讨论的本地验证

已经本地验证通过：

- A 可以发消息给 B
- B 可以回复 A
- 双方可以继续多轮交互，直到各自输出 `Current consensus:`

当前约束：

- 仍然只适用于本机
- 每个实例同一时刻仍只支持一个前台 Claude 连接
- 不是托管式多租户系统
- 不是任意 Agent 提供方的通用总线

## 关键文件

- [src/bridge.ts](src/bridge.ts)
- [src/daemon.ts](src/daemon.ts)
- [src/daemon-client.ts](src/daemon-client.ts)
- [src/claude-adapter.ts](src/claude-adapter.ts)
- [src/control-protocol.ts](src/control-protocol.ts)
- [src/instance-config.ts](src/instance-config.ts)
- [MULTI_CLAUDE_WINDOWS.md](MULTI_CLAUDE_WINDOWS.md)
- [SOP.md](SOP.md)

## 快速开始

安装依赖：

```bash
cd cc-bridge
bun install
```

注册两个 MCP 实例：

```bash
bash ./scripts/cc-bridge-register-instance.sh 1 cc-bridge-1
bash ./scripts/cc-bridge-register-instance.sh 2 cc-bridge-2
```

检查注册：

```bash
claude mcp get cc-bridge-1
claude mcp get cc-bridge-2
```

然后参考：

- [QUICKSTART.md](QUICKSTART.md)
- [MULTI_CLAUDE_WINDOWS.md](MULTI_CLAUDE_WINDOWS.md)
- [SOP.md](SOP.md)
- [PROMPTS.md](PROMPTS.md)
- [PUBLISHING.md](PUBLISHING.md)

## 日志与 relay 状态

日志：

- 实例 1：`/tmp/cc-bridge-1.log`
- 实例 2：`/tmp/cc-bridge-2.log`

relay 状态目录：

- `/tmp/cc-bridge/default`

## 与上游项目的关系

上游 `agent-bridge` 作为 `Claude Code ↔ Codex` 协作桥仍然有明确价值。

这个 fork 不是在否定那个方向，而是把同样的本地 bridge 模式重用到另一种场景：

- 上游：Claude Code ↔ Codex
- 当前 fork：Claude Code A ↔ Claude Code B
