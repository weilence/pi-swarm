# pi-swarm

> Prototype: a pure Node.js/TypeScript Supervisor that dispatches focused module Workers built around Pi SDK.

This repository is intentionally a small, throwaway validation scaffold. It answers one question:

> Can one Supervisor coordinate multiple module-specific Pi Workers, exchange structured events, and finish with an integration gate?

## Run

```powershell
npm install
npm run typecheck
npm run start
```

`npm run start` uses `MockPiWorker` by default so it runs without model credentials. `PiSdkWorker` is wired to the pinned `@earendil-works/pi-coding-agent` package and is ready for a credentialed smoke test.

The two registered modules are placeholders in `modules/user-service` and `modules/order-service`; replace them with links or checked-out directories for your real programs.

## Planned architecture

```text
Supervisor (Node.js)
  ├─ Module Registry
  ├─ Task Dispatcher
  ├─ Context Builder
  ├─ Event Bus
  └─ Integration Gate
       ├─ Pi Worker: user-service
       └─ Pi Worker: order-service
```

Each module owns its `AGENT.md`, `CONTEXT.md`, contracts, decisions, and troubleshooting notes. The Supervisor owns cross-module task planning and integration; Workers own implementation inside their assigned worktree.

## Current boundaries

- No LangGraph or other orchestration framework.
- No production database, message broker, web UI, or automatic merge.
- No hidden long-term memory: durable module knowledge belongs in versioned files.
- Pi SDK integration is isolated in `src/pi/pi-sdk-worker.ts`.

See [docs/quick-validation-plan.md](docs/quick-validation-plan.md) and [docs/architecture.md](docs/architecture.md).

## 持续运行的主 agent

启动交互式主 agent：

```powershell
npm run start
```

它会启动一个 Supervisor、一个接入真实模型的 supervisor agent，以及每个模块一个
持续复用的 work agent。用户输入先经 supervisor 模型做**意图分析**（静默）：

- **简单任务**：提炼目标后直接派发给模块 worker；
- **不明确任务**：向用户提问收集关键决策（交互模式下 REPL 中作答，一轮为限；
  非交互模式按现有信息继续），随后重新分析；
- **复杂任务**：规划器拆分步骤并标注依赖（JSON 结构化输出），按依赖分层
  **并发执行**（同层任务由 Supervisor 并行派发，前序步骤结果自动注入后续步骤）。

所有步骤完成后，supervisor 用**流式 markdown** 输出总结（变更、风险、后续建议）。
模型不可用或结构化输出解析失败时逐级降级为直接派发。在交互式终端（TTY）下，REPL 由
Pi 同源的 [pi-tui](node_modules/@earendil-works/pi-tui) 渲染（Markdown 按块流式渲染、
多行编辑器带历史记录、模型输出与思考流分色显示、执行中可弹出澄清提问）：
直接输入 `/provider`、`/model` 或 `/thinking`（不带参数）会弹出选择列表，
支持 `↑↓` 移动、输入即模糊过滤、`Enter` 确认、`Esc` 取消；`/provider` 选中后还会依次弹出
接口类型与模型选择。`/status` 查看当前配置；输入 `/exit` 或 `/quit` 才会结束进程。
非交互环境（管道/CI）自动回退到纯文本模式，此时可用
`/provider <id> [接口类型]`、`/model <id>`、`/thinking level` 等带参数形式。
默认使用 `MockPiWorker`（同样支持 provider/模型/thinking 运行时切换，仅不调用真实模型），
设置 `PI_SWARM_WORKER=pi` 可切换为 `PiSdkWorker`。

`/provider`、`/model`、`/thinking` 配置的是 supervisor agent 的模型（基于 Pi SDK 的
独立会话，工作目录为仓库根）。参数通过 `ConfigStore` 抽象持久化，当前实现
`JsonFileConfigStore` 写入用户数据目录下的 `config.json`（原子写入），重启后自动
恢复——快照中同时保存 models.dev 解析后的 provider 配置，目录缓存缺失时也能离线
恢复；`/status` 同时显示 supervisor 与 worker 两级状态。用户数据目录可用环境变量
`PI_SWARM_USERDATA` 重定向到任意路径（单测借此隔离真实用户数据）。work agent 的
真实模型接入是下一步计划。

模型调用需要 API key，两种方式任选：`/apikey <key>` 直接配置（明文持久化到上述
`config.json`，日志与 `/status` 中仅显示掩码），或沿用环境变量——provider 配置中的
`$ENV_VAR` 引用由 Pi 在请求时插值（如 `$ANTHROPIC_API_KEY`，可在 `.env` 或系统环境
变量中设置）。注意密钥值以 `$` 或 `!` 开头时会被 Pi 当作环境变量引用或命令执行，
此类密钥请改用环境变量方式。

程序启动时会自动读取项目根目录的 `.env`（已存在的系统环境变量优先）。例如：

```powershell
Copy-Item .env.example .env
# 编辑 .env，设置 PI_SWARM_WORKER=pi 和 OPENAI_API_KEY/ANTHROPIC_API_KEY 等
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
