# pi-swarm 子 agent 架构

## 设计原则

- **初始无子 agent**：全新环境下不预置任何子 agent；不与代码模块（module registry）直接绑定。
- **用户按需自建 agent**：每个 agent 是一个带 frontmatter 元信息的 Markdown 文档。
- **Supervisor 动态调度**：任务执行时由 LLM 根据任务信息与各 agent 描述匹配，调用合适的子 agent。
- **无匹配则自执行**：注册表为空、无合适 agent、或匹配失败时，步骤由 Supervisor 在自己的会话中直接执行。

## Agent 定义格式

参考 Claude Code subagents / AGENTS.md 的主流约定：YAML frontmatter 携带元信息，正文是 system prompt。

```markdown
---
name: code-reviewer          # 必填，小写 slug
description: 一句话职责描述    # 必填，供 LLM 匹配使用
capabilities:                # 可选，能力标签列表（提升匹配质量）
  - 识别逻辑缺陷
tools: [read, bash]          # 可选，授予的工具/权限
model: anthropic/claude-sonnet-4-5  # 可选，模型规格
tags: [review]               # 可选，分组标签
---

这里是 agent 的 system prompt（行为准则）。
```

字段校验规则：`name`、`description` 缺失或非法即拒绝加载；未知字段、空正文、缺失 capabilities 仅告警不拒绝。

## 存放位置与优先级

| 目录 | 作用域 |
|---|---|
| `<用户数据目录>/agents/`（Windows: `%APPDATA%\pi-swarm\agents`） | 全局 |
| `<项目根>/.pi-swarm/agents/` | 项目内 |

同名冲突时**项目定义覆盖全局定义**；损坏/非法文件被跳过并输出告警，不影响其余 agent 加载。当前 agent 列表在启动时加载，新增定义需重启生效。

## 任务执行流程

任务控制流完全在 Supervisor 的模型循环里（详见 `docs/orchestration.md`）：

1. 用户输入 = 对 supervisor 会话的一次 prompt；可用 agent 以花名册形式写进系统提示。
2. 模型决定派发时调用 `delegate` 工具（`src/pi/delegate-tool.ts`），在入参里为每步指定 `agent`（只能取花名册中的 name）。
3. delegate 按依赖分层并行执行：每步派发给该 agent 的长驻 `SubAgent` 会话（懒创建、复用，注入 agent 的 system prompt），返回真实观察记录（状态、变更文件、错误、摘要）。
4. 模型根据返回结果继续决策：再派下一批、换 agent 重做失败步骤，或自己在主会话完成剩余工作；全部结束后输出 markdown 总结。
5. 注册表为空时不注册 delegate，所有工作由 supervisor 在主会话直接完成。

supervisor 会话与所有 SubAgent 会话共享同一个 `ModelRuntime`：`/provider`、`/model`、`/apikey`
配置的是全局默认模型，注册一次对全部会话生效；会话之间互相隔离。
frontmatter 的 `tools:` 已生效：作为子 agent 会话的工具允许名单传入 `createAgentSession`；`model:` 仍为预留字段。

## 实现落点

- `src/core/agent-format.ts` — 定义解析与校验（parser/validator）
- `src/core/agent-registry.ts` — 双目录注册表（项目覆盖全局、损坏容错、list/get）
- `src/core/task-run.ts` — StepRecord/TaskRun、预算护栏、依赖分层
- `src/pi/delegate-tool.ts` — delegate 工具：校验、分层并行、观察汇总
- `src/pi/supervisor-agent.ts` — Supervisor 会话（模型驱动控制流）、`runTask`、花名册系统提示
- `src/pi/sub-agent.ts` — `SubAgent`：按定义懒创建的 Pi 会话执行器，产出真实 StepRecord
- `src/cli/main.ts` — 启动时加载 agent 注册表，按需懒创建 SubAgent
- 示例：`.pi-swarm/agents/code-reviewer.md`、`.pi-swarm/agents/test-writer.md`、`.pi-swarm/agents/code-writer.md`
- 测试：`tests/agent-format.test.ts`、`tests/agent-registry.test.ts`、`tests/delegate-tool.test.ts`、`tests/task-run.test.ts`

## 端到端冒烟记录（2025-09-03，编排重构前）

- 全新用户数据目录启动 CLI：0 个预置 agent，所有步骤由 supervisor 自执行，正常进入 REPL ✅
- 注册表加载项目内 2 个示例 agent（code-reviewer、test-writer）✅
- `dispatchTask("审查这个 PR 的改动", agents, matcher)`（LLM 以脚本回执模拟）→ `{mode: "agent", agent: code-reviewer}` ✅
- 同注册表对“帮我订咖啡”类任务返回 `{"agent": null}` → `{mode: "supervisor"}` ✅
- `npm test` 93/93 通过；`npm run typecheck` 无错误 ✅
