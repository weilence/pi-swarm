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

## 任务分发流程

1. 意图分析 → 规划步骤（`src/core/orchestrator.ts`）。规划提示词会列出全部已注册 agent，planner 可直接为步骤指定 `agent`。
2. 每个步骤路由（`routeStep`），规则唯一：
   - planner 指定的 agent 已注册 → 直用（省一次匹配调用）；
   - 否则把步骤目标 + 各 agent 的 description/capabilities 交给 LLM 匹配（`src/core/agent-dispatch.ts`）；
   - 匹配到 agent → 派发给该 agent 的 `SubAgent` 会话（懒创建、长驻复用，注入 agent 的 system prompt）；
   - 无匹配 / 注册表为空 / 匹配输出非法 → **Supervisor 自执行**（`SupervisorAgent.executeTask`，在主会话中流式完成）。

supervisor 会话与所有 SubAgent 会话共享同一个 `ModelRuntime`：`/provider`、`/model`、`/apikey`
配置的是全局默认模型，注册一次对全部会话生效；会话之间互相隔离。
匹配提示词要求 LLM 仅输出 `{"agent": "<name>" | null}`，解析失败一律降级为自执行，永不阻塞任务。
frontmatter 的 `model:`、`tools:` 为预留字段，当前未生效。

## 实现落点

- `src/core/agent-format.ts` — 定义解析与校验（parser/validator）
- `src/core/agent-registry.ts` — 双目录注册表（项目覆盖全局、损坏容错、list/get）
- `src/core/agent-dispatch.ts` — 匹配提示词构建、回复解析、降级决策
- `src/core/orchestrator.ts` — 意图分析/澄清/规划/分层并发/总结的编排与路由
- `src/pi/supervisor-agent.ts` — `matchAgent`（LLM 匹配）与 `executeTask`（自执行）
- `src/pi/sub-agent.ts` — `SubAgent`：按定义懒创建的 Pi 会话执行器
- `src/cli/main.ts` — 启动时加载 agent 注册表，按需懒创建 SubAgent
- 示例：`.pi-swarm/agents/code-reviewer.md`、`.pi-swarm/agents/test-writer.md`
- 测试：`tests/agent-format.test.ts`、`tests/agent-registry.test.ts`、`tests/agent-dispatch.test.ts`、`tests/orchestrator.test.ts`

## 端到端冒烟记录（2025-09-03）

- 全新用户数据目录启动 CLI：0 个预置 agent，所有步骤由 supervisor 自执行，正常进入 REPL ✅
- 注册表加载项目内 2 个示例 agent（code-reviewer、test-writer）✅
- `dispatchTask("审查这个 PR 的改动", agents, matcher)`（LLM 以脚本回执模拟）→ `{mode: "agent", agent: code-reviewer}` ✅
- 同注册表对“帮我订咖啡”类任务返回 `{"agent": null}` → `{mode: "supervisor"}` ✅
- `npm test` 93/93 通过；`npm run typecheck` 无错误 ✅
