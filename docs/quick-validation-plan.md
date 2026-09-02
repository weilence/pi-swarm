# 快速验证落地方案

## 验证问题

一个纯 Node.js Supervisor 能否基于 Pi SDK 调度多个模块 Worker，使用模块专属文档和记忆，通过结构化事件交换信息，并在最后运行集成测试？

## MVP

- 2 个真实独立程序作为模块
- 1 个 Supervisor
- 2 个 Pi Worker
- 模块专属 `AGENT.md` / `CONTEXT.md`
- 结构化任务、事件和结果协议
- Git worktree 隔离
- 单元、契约和集成测试
- 人工批准合并

## 暂不实现

- Web 控制台
- Kafka/NATS
- 向量数据库
- 自动合并和生产发布
- 无限递归 Agent
- 多层 Supervisor

## 成功标准

1. Supervisor 正确选择受影响模块。
2. Worker 可以并行运行且上下文互不污染。
3. Worker 不修改未授权路径。
4. 契约变更可以通知相关模块。
5. 单元测试通过但集成测试失败时，Supervisor 能创建针对性修复任务。
6. 任务、事件和测试结果可以回放。
