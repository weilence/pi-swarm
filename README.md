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
