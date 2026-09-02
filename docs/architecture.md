# Architecture

## Boundary

`pi-swarm` is a pure Node.js/TypeScript control plane. Pi is the execution runtime for both Supervisor and module Workers. No LangGraph dependency is planned.

## Responsibilities

- Supervisor: planning, module selection, task dispatch, event routing, retry decisions, and integration gate.
- Worker: module-local implementation, tests, and change summary.
- Module documents: versioned source of truth for local architecture and operating rules.
- Integration gate: contract tests, integration tests, diff checks, and human approval before merge.

## Future seams

1. Use `PiSdkWorker` for credentialed runs; keep `MockPiWorker` for deterministic orchestration tests.
2. Replace the in-memory `EventBus` with a durable store only when a real recovery requirement appears.
3. Add a worktree manager before allowing real code changes.
4. Add MCP tools for module-specific code search, tests, logs, and contracts.
