# 编排设计 — 模型驱动主循环（as-built）

> 本文描述**当前实现**的编排架构。它取代了早期的固定流水线（意图分析 → 规划 → 分层执行 → 总结），
> 该流水线已被移除——机械感来自硬编码控制流，且其"观察"环节（StepResult）是硬编码假数据，循环实际开环。

## 形态

**Supervisor 会话即控制流。** 用户输入任务 = 对 supervisor Pi 会话的一次 `session.prompt()`。
模型在 agent 循环里自主决定：分析任务、规划步骤、调用 `delegate` 工具派发、根据真实结果继续决策、
最终输出 markdown 总结。编排层退化为**工具执行器 + 护栏**，不再拥有控制流。

被此形态吸收并删除的阶段化机制：

| 旧机制（已删除） | 现在的归属 |
|---|---|
| 意图分析 `analyzeIntent`（JSON 分类） | 模型在主循环里自然判断 |
| 澄清 `clarify`（至多一轮问答） | unclear 任务 = 模型直接发问的一轮对话 |
| 规划 `planSteps`（≤6 步 JSON） | 模型按批构造 delegate 入参 |
| 路由匹配 `matchAgent`（LLM 输出 agent name） | 模型在 delegate 入参里直接指定 `agent` |
| 总结 `summarize`（喂结果 JSON） | 收尾时模型自然输出，实时流式 |
| 自执行兜底 `executeTask` | 模型不派发、自己在主会话做（花名册引导） |

## delegate 工具

经 `createAgentSession` 的 `customTools` 注册（仅当注册表非空且有 stepExecutor 时注册）。

- **入参**：`{ steps: [{ id, goal, agent, dependsOn? }] }`，`agent` 必须取系统提示花名册中的 name。
- **执行**：按 `dependsOn` 分层（`dependencyLayers`），层内经 worker pool 并行（≤4），
  每步经 `Supervisor.run` → 长驻子 agent 会话执行。
- **出参**：每步真实记录的 JSON（状态、changedFiles、error、截断摘要）——这是模型下一轮决策的观察输入。
- **上下文传递**：批内被依赖步骤完成后，其状态行 + 截断摘要注入下游步骤 goal。
- **校验失败**（未注册 agent / 步骤超批 / id 重复 / 超总预算）返回纠正性文本，不消耗预算、不执行任何步骤。

## 护栏（`src/core/task-run.ts` 的 `BUDGET_LIMITS`）

| 护栏 | 值 | 越界行为 |
|---|---|---|
| 单批步骤数 | ≤ 6 | 拒绝执行，提示拆批 |
| 批内并发 | ≤ 4 | pool 排队 |
| 每步超时 | 10 分钟 | `session.abort()` 硬中断，按可重试错误处理 |
| delegate 调用次数 | ≤ 8/任务 | 返回"预算耗尽，请收尾"，任务标记 `budget_exhausted` |
| 任务总步骤数 | ≤ 24 | 拒绝超出部分 |
| 可重试错误自动重试 | 1 次 | 同会话带失败反馈继续；仍失败返回 failed/timeout 记录 |

完成判定：`session.prompt` 自然返回，最终流式文本即总结，无独立总结阶段。
v1 中断 = 进程级 Ctrl+C；`steer()` API 已确认为公开 seam，优雅取消/转向留待后续。

## 观察采集（事件侧 ground truth）

`ToolObservationCollector`（`src/core/tool-observation.ts`）订阅会话事件：

- `tool_execution_end` → 计数、记录 `isError`；
- `edit`/`write` 的 `args.path` → changedFiles（bash 不猜测）；
- `session.getLastAssistantText()` → 叙述性摘要。

模型自报文本被记录但仅作叙述；与事件事实并存，冲突以事件为准。集成 gate 只留 `StepRecord` 上的 seam。

## TaskRun（编排状态）

```
TaskRun  { id, goal, status: running|completed|budget_exhausted, steps: StepRecord[], budget: { delegateCalls, stepsUsed }, createdAt }
StepRecord { id, agent, goal, status: completed|failed|timeout, summary, changedFiles, toolCalls, error? }
```

- 仅内存，随 `runTask()` 创建/清理；类型可序列化，落盘只需加一个 store（留 seam，与 s1 会话持久化边界一致）。
- 完整 assistant 文本保存在 `StepRecord.summary`（delegate 返回给模型的是截断版）。

## 失败恢复分层

- **可重试错误**（`isRetryableError`：网络、超时、429/5xx）：同一子 agent 会话内带错误反馈自动重试 1 次，保留已积累的代码上下文。
- **语义失败**：以 `failed` 记录原样返回给模型，由它决定换 agent 重派、改目标或放弃——重规划不是独立机制，就是主循环的下一个回合。

## 模块落点

| 位置 | 职责 |
|---|---|
| `src/core/task-run.ts` | TaskRun/StepRecord 类型、预算常量、dependencyLayers、错误分类、格式化 |
| `src/core/tool-observation.ts` | 事件侧观察采集（纯函数，可独立测试） |
| `src/core/supervisor.ts` | runner 注册表 + 单步执行 + 失败收容 + 事件发布 |
| `src/pi/agent.ts` | 唯一的 `Agent` 类（门面）：prompt 循环、timeout/abort/重试（runStep）、runTask 换入 TaskRun |
| `src/pi/session-host.ts` | 会话生命周期、工具装配、事件扇出与流式闸门 |
| `src/pi/model-settings.ts` | provider/model/thinking/容量偏好与持久化 |
| `src/pi/delegate-tool.ts` | delegate 工具：校验→分层→并发池→观察汇总→预算执行 |
| `src/pi/agent-factory.ts` | 唯一的 `createAgent` 工厂：协调者（delegate 花名册 + 准则）与子 agent（身份行 + tools 允许名单 + 模型/thinking 拉取）都是能力组合 |
| `src/core/session/session-flows.ts` | 会话用例核心：openDraft / switch（含指针回滚）/ delete（同位顶替）/ dispatchTask（草稿物化、touch 记账） |
| `src/cli/commands.ts` | 命令注册表（唯一真相：元数据 + 分发 + 补全）与参数解析；会话用例经端口委托给 core 流程 |
| `src/cli/output-router.ts` | agent 事件流 / 日志 / 提示的唯一输出出口（REPL 或 console 降级）+ 状态栏轮询 |
| `src/cli/main.ts` | 装配：Supervisor + supervisor Agent 互相前向引用（stepExecutor 转发器） |

测试：`tests/task-run.test.ts`、`tests/tool-observation.test.ts`、`tests/delegate-tool.test.ts`
（分层/并行/预算/校验），`tests/commands*.test.ts`（dispatch 路径）。

## 已知边界（不做的事）

用户中途 steering/优雅取消、scratchpad 交接、编排状态落盘、集成 gate 实体、跨批 dependsOn
（跨批依赖无意义：前批结果已在模型上下文里）。frontmatter 的 `model:` 仍为预留字段；`tools:`
已生效（作为子 agent 会话的工具允许名单）。
