# Orchestra 编排系统 — 用户原始需求与最高目的

## 最高目的

基于 cc-bridge 现有代码，构建一个 **多 Agent 自动编排系统 (Orchestra)**，实现：

1. **Conductor (A/opus)** 与用户确认最高目标后，自动呼出 Concertmaster (B/gpt-5.4) 窗口
2. A 与 B **自治讨论**，对 plan 和 arrangement 达成共识
3. 共识达成后，自动呼出更多 CC 窗口组建大角色小组，建立信道
4. 小组内 leader+challenger 协作完成子目标，验收后交由 A+B 做最终验收
5. 全流程自动化，用户只需提供最高目标的细节，不需要在旁看管

---

## 角色定义

| 角色 | 模型 | 职责 |
|------|------|------|
| **A — Conductor** | opus (固定) | 整体 plan、角色/小组/信道安排、追问用户确认最高目标细节、最终验收。**不写代码。** |
| **B — Concertmaster (首席)** | gpt-5.4 (固定) | Challenge A 的 plan 和安排、与 A 达成共识、可兼任一个小组的 leader |
| **Leader** | 由 A 分配 (B 或模型池) | 小组内主导实现、代码/审查/测试 |
| **Challenger** | 优先 kimi | 小组内独立 challenge、代码/审查/测试 |
| **Coder/Extra** | minimax / doubao | 额外编码窗口 (可选) |
| **Watchdog** | minimax (廉价模型) | 健康监控、世界频道消息 (可选) |

---

## Plan 结构 (A+B 共识必需)

1. **最高目标** — 带有细节，A 必须追问用户
2. **实现路径** — A+B 讨论形成
3. **里程碑**
4. **分解的小目标** — 每个小目标有 **量化的验收标准**

---

## 大角色小组 (Task Group)

- 每个小目标映射一个小组
- 非特别复杂项目 → **尽量只安排一个小组**
- 每组最多 **4 个 CC 窗口**
- 必须角色：**leader** + **challenger** (两者同时也是 coder/reviewer/tester)
- 可选：+1-2 个额外窗口

### Multi-model 策略 (强制)

小组内每个窗口 **必须使用不同模型**，防止单一模型偏差放大。

- 模型池：kimi / minimax / doubao
- Challenger 优先选 kimi
- 非复杂项目：leader=B(gpt-5.4), challenger=kimi, 其余从 minimax/doubao 选

---

## 信道 (Channels)

| 信道 | 端点 | 用途 |
|------|------|------|
| Conductor-Concertmaster | A ↔ B | Plan、安排、最终验收 |
| Conductor-Leader | A ↔ 每个 leader | 状态、方向 |
| 组内信道 | leader ↔ challenger ↔ 成员 | 实现、审查、测试 |
| Leader-Leader | 所有 leader 之间 | 跨组协调 |
| 世界频道 | A 广播 (+ watchdog) | 全局公告 |

**注意：A 和 C 不直接通信。** A 通过 B(leader) 间接协调组内。

---

## 典型配置

### 简单 (3 窗口): `A (B) C`
- A=conductor(opus), B=concertmaster+leader(gpt-5.4), C=challenger(kimi)
- 信道: A↔B, B↔C

### 中等 (4 窗口): `A B C D`
- A=conductor, B=concertmaster+leader, C=challenger, D=coder
- 信道: A↔B, B↔C↔D

### 复杂 (多组): `AB + (BC) + (DE)`
- B 只有一个实例，兼任 concertmaster 和 group1 leader
- D 是 group2 的 leader
- 信道: A↔B, A↔D, B↔C, D↔E, B↔D (leader-leader), 世界频道

---

## 执行规则

1. 多组串行/并行视子目标依赖而定
2. **必须保证后续组开始时，前置依赖已全部解决** — 不留返工尾巴
3. 组内：leader+challenger 达成共识验收 → 报告 A+B 做最终验收
4. A+B 验收通过后拼入最高目标实现路径
5. 监控健康

---

## 通信拓扑

- 在 orchestra 编制时决定哪些 peer 之间可以沟通
- cc-bridge 是稳定底层通信基座 — **不改 cc-bridge 副本项目**
- Orchestra 层在 cc-bridge 之上声明参与者、角色和 **通信矩阵**

---

## 实现手段

1. A 自动呼出 B 窗口 (launch_peers / launch-claude-peer.sh)
2. A 与 B 自治讨论达成共识 (A 15分钟轮询, B 10分钟轮询)
3. 共识后自动呼出 C 或更多窗口
4. 建立信道与小组
5. plan 阶段动态生成所有配置

---

## 用户原话 (完整保留)

### 原话 1 — 整体设计
> 我希望整个orchestra是这样，A也就是你，是整个orch的conductor，负责整体任务的plan和角色、小组和信道的安排，你在做plan的时候需要和用户确定具体要实现的最高目标，需要带有细节，你要好好追问用户；B是首席，他在你得到用户细节开始制定plan和安排的时候，负责对你自己的plan和安排进行分析和challenge，你们两个人在plan和安排上需要达成共识。plan应包含项目的最高目标，你们讨论形成的实现最高目标的路径、里程碑和分解的小目标以及小目标量化的验收标准。安排应包含实现各个小目标你们讨论所需的大agent数量成为大角色小组，大角色小组中应有一名leader，一个challenger，这两个角色可以都是coder和reviewer以及tester，大角色小组视任务可以多加1-2个cc窗口。大角色小组中一定要保证multi-model，这样可以解决某一单一模型代码、审查和测试过程中偏差的放大问题。信道的安排应该是A和B、A和所有的leader、所有单独分组中的leader和challenger以及其他成员、所有leader之间应该有信道，还应该有一个世界频道，A可以发世界频道消息，你也可以视项目大小看看需不需要安排一个watchdog，可以在世界频道发消息。B也可以担任某个小组的leader。

### 原话 2 — 约束和细节
> 1.B固定用gpt-5.4；2.小组最多有4窗口，如果不是特别特别复杂的项目，你应该尽量只安排一个小组进行工作；3.multi-model策略小组内不同窗口应该都是各自不同的模型，不是特别复杂的项目，leader可以就是B，其他角色可以从模型池kimi/minimax/doubao中选择，challenger优先选kimi；如果有多小组，串行并行策略应该视小目标路径的依赖而定，一定要保证后面项目开始时，前一个项目或几个小目标把所有的依赖都解决掉，不要留返工的尾巴；5.leader和challenger达成共识验收后，由conductor和concertmaster讨论进行最终验收并拼入实现最高目标的路径；6.监控健康。默认的conductor是opus，concertmaster是gpt-5.4。一个简单典型的orchestra可以有3个cc窗口，（A（B）C）这个形式，你能理解吧

### 原话 3 — 澄清
> A不写代码，2.你理解的对，ac不直接通信。3.plan阶段动态生成。再复杂就多组：(A(B1)C1) + (A(B2)C2)，这个理解不对，复杂的情况是AB+(BC)+(DE),B只有一个，但可以兼职一个组长

### 原话 4 — 通信拓扑
> 有时候也需要多方广播，我的思路是在设计orchestra编制的时候，要决定哪些peer之间是可以沟通的

### 原话 5 — 实现手段
> 你看一下现在的项目，然后告诉我我们可以怎么利用这个基座实现orchestra，我要实现的手段是通过A自动呼出B窗口，然后有共识后自动呼出C或更多窗口建立信道与小组

### 原话 6 — 自治讨论
> 你清一下环境，把现在的B关了，重新开始发起讨论，你自己10分钟轮询，让B 5分钟轮询，讨论直至取得共识后停止，你汇报给我基于现在的代码形成orchestra的plan

> A每15分钟轮询一次，B可以每10分钟
