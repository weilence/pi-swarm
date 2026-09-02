# pi-swarm

> Prototype: a pure Node.js/TypeScript Supervisor that dispatches focused module Workers built around Pi SDK.

This repository is intentionally a small, throwaway validation scaffold. It answers one question:

> Can one Supervisor coordinate multiple module-specific Pi Workers, exchange structured events, and finish with an integration gate?

## Run

```powershell
npm install
npm run typecheck
npm run demo
```

The demo uses `MockPiWorker` so it runs without model credentials. `PiSdkWorker` is wired to the pinned `@earendil-works/pi-coding-agent` package and is ready for a credentialed smoke test.

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

它会启动一个 Supervisor 和一个持续复用的 work agent。每行输入一个任务，主 agent
会把任务交给 work agent；输入 `/provider <id> [接口类型]` 从 models.dev 选择供应商和 Pi 接口，
输入 `/model` 列出该供应商模型，输入 `/model <id>` 选择模型；`/thinking level` 可在运行时调整 Pi 会话，
`/status` 查看当前配置；输入 `/exit` 或 `/quit` 才会结束进程。当前默认使用
`MockPiWorker`，可替换为 `PiSdkWorker`。`npm run demo` 仍然是一次性并行演示，
执行完成后正常退出。

程序启动时会自动读取项目根目录的 `.env`（已存在的系统环境变量优先）。例如：

```powershell
Copy-Item .env.example .env
# 编辑 .env，设置 PI_SWARM_WORKER=pi 和 OPENAI_API_KEY/ANTHROPIC_API_KEY 等
npm run start
```

真实 Pi Worker 需要 Pi SDK 可用的模型凭据。models.dev 原始目录会在首次使用 `/provider` 时读取，
并转换为 Pi 支持的 `anthropic-messages`、`openai-completions`、`openai-responses` 或
`google-generative-ai` 接口。
