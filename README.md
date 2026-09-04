# pi-swarm

> Prototype: a Node.js/TypeScript Supervisor that orchestrates user-defined sub-agents built around Pi SDK.

This repository is intentionally a small, throwaway validation scaffold. It answers one question:

> Can one Supervisor coordinate user-defined sub-agents, exchange structured events, and finish with a streamed summary?

## Run

```powershell
npm install
npm run typecheck
npm run start
```

`npm run start` boots a single-session REPL by default; with no model configured it degrades gracefully (every step is attempted and reported). Sub-agents are user-created Markdown definitions (YAML frontmatter + system-prompt body) loaded at startup from a global directory (`<user data>/pi-swarm/agents`) and a project directory (`.pi-swarm/agents`, project wins on name conflicts). The Supervisor's LLM routes each planned step to the best-matching agent, or executes the step itself when nothing fits — see `docs/agents.md`. Two sample agents live in `.pi-swarm/agents/` (`code-reviewer`, `test-writer`).

## Planned architecture

```text
Supervisor (Node.js)
  ├─ Agent Registry (global + project .md definitions)
  ├─ Intent / Plan / Match (LLM)
  ├─ Task Dispatcher
  │    ├─ matched user agent session
  │    └─ supervisor self-execution fallback
  ├─ Context Builder
  └─ Event Bus
```

Each user-created agent owns its own system prompt and tool grants. The Supervisor owns task planning, agent matching, and self-execution fallback; agents own implementation inside their granted scope.

## Current boundaries

- No LangGraph or other orchestration framework.
- No production database, message broker, web UI, or automatic merge.
- No hidden long-term memory: durable knowledge belongs in versioned files.
- Pi SDK integration is isolated in `src/pi/` (one `Agent` class, wired as supervisor or sub-agent via `createSupervisorAgent`/`createSubAgent`, all on one shared ModelRuntime).

See [docs/quick-validation-plan.md](docs/quick-validation-plan.md) and [docs/architecture.md](docs/architecture.md).

## 持续运行的主 agent

启动交互式主 agent：

```powershell
npm run start
```

它会启动一个 Supervisor（接入真实模型的 supervisor 会话）和一个子 agent 池（懒创建，
每个 agent 首次被路由到时建立长驻会话）。用户输入先经 supervisor 模型做**意图分析**（静默）：

- **简单任务**：提炼目标后直接进入路由；
- **不明确任务**：向用户提问收集关键决策（交互模式下 REPL 中作答，一轮为限；
  非交互模式按现有信息继续），随后重新分析；
- **复杂任务**：规划器拆分步骤并标注依赖（JSON 结构化输出），按依赖分层
  **并发执行**（同层任务并行派发，前序步骤结果自动注入后续步骤）。

每个步骤的路由规则唯一：planner 指定的 agent 已注册则直用 → 否则运行时 LLM 匹配
（`agent-dispatch`）→ 无匹配/注册表为空/匹配失败 → **supervisor 自执行**。
所有步骤完成后，supervisor 用**流式 markdown** 输出总结（变更、风险、后续建议）。
模型不可用或结构化输出解析失败时逐级降级，不阻塞基本可用性。在交互式终端（TTY）下，
REPL 由 Pi 同源的 [pi-tui](node_modules/@earendil-works/pi-tui) 渲染（Markdown 按块
流式渲染、多行编辑器带历史记录、模型输出与思考流分色显示、执行中可弹出澄清提问、
用户输入以「▸ 你」块回显进 transcript，与 /switch 历史回放同格式）：
直接输入 `/provider`、`/model` 或 `/thinking`（不带参数）会弹出选择列表，
支持 `↑↓` 移动、输入即模糊过滤、`Enter` 确认、`Esc` 取消；`/provider` 选中后还会依次弹出
接口类型与模型选择。`/status` 查看当前配置与已加载 agent；输入 `/exit` 或 `/quit` 才会结束进程。
非交互环境（管道/CI）自动回退到纯文本模式，此时可用
`/provider <id> [接口类型]`、`/model <id>`、`/thinking level` 等带参数形式。

`/provider`、`/model`、`/thinking`、`/apikey` 配置的是**全局默认模型**：supervisor 会话与
所有子 agent 会话共享同一个 `ModelRuntime`，注册一次全部生效（子 agent 会话本身互相隔离，
懒创建时自动套用当前默认模型）。参数通过 `ConfigStore` 抽象持久化，当前实现
`JsonFileConfigStore` 写入用户数据目录下的 `config.json`（原子写入），重启后自动
恢复——快照中同时保存 models.dev 解析后的 provider 配置，目录缓存缺失时也能离线
恢复。用户数据目录可用环境变量 `PI_SWARM_USERDATA` 重定向到任意路径（单测借此
隔离真实用户数据）。

模型调用需要 API key，两种方式任选：`/apikey <key>` 直接配置（明文持久化到上述
`config.json`，日志与 `/status` 中仅显示掩码），或沿用环境变量——provider 配置中的
`$ENV_VAR` 引用由 Pi 在请求时插值（如 `$ANTHROPIC_API_KEY`，可在 `.env` 或系统环境
变量中设置）。注意密钥值以 `$` 或 `!` 开头时会被 Pi 当作环境变量引用或命令执行，
此类密钥请改用环境变量方式。

程序启动时会自动读取项目根目录的 `.env`（已存在的系统环境变量优先）。例如：

```powershell
Copy-Item .env.example .env
# 编辑 .env，设置 OPENAI_API_KEY/ANTHROPIC_API_KEY 等，或启动后用 /apikey <key>
npm run start
```

真实 Pi Worker 需要 Pi SDK 可用的模型凭据。接口类型枚举 `KnownApi` 直接来自
`@earendil-works/pi-ai`（与 pi-coding-agent 同版本锁定的直接依赖），选择弹窗中的
接口列表也由其运行时 api 注册表（`getApiProviders()`）推导，随 SDK 版本自动更新；
本仓库只需维护 models.dev 的 `npm` 包名到 `KnownApi` 的映射表（`NPM_API_RULES`，
包名精确匹配），未列出的兼容供应商默认 `openai-completions`。models.dev 目录采用
本地缓存 + 后台校验（stale-while-revalidate）：首次使用 `/provider` 时从网络读取并
写入用户数据目录（`getUserDataDir()`，按平台分别为 `%APPDATA%\pi-swarm`、
`~/Library/Application Support/pi-swarm`、`~/.config/pi-swarm`）下的
`models-dev.json`，之后每次启动立即使用磁盘缓存，并在后台
携带缓存的 ETag 发起 `If-None-Match` 条件请求——服务器返回 304 即判定无更新（不传正文），
返回 200 时再做全量内容比对，仅在有变化时更新内存与磁盘并写日志提示；
无 ETag 或服务器不支持时自动回落为全量下载比对，网络失败时继续使用缓存。
`/provider` 与 `/model` 的文本形式只接受与 models.dev / Pi 完全一致的 ID（大小写敏感，
不做别名归一化）：接口类型需输入完整的 `KnownApi` ID（如 `openai-responses`），
输入不合法时错误信息会列出全部可选项；快捷选择请使用弹窗。
