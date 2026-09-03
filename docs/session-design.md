# Session 管理与切换 — 设计文档（s1）

## 1. 现状与问题

- `SupervisorAgent`（`src/pi/supervisor-agent.ts`）在 `ensureSession()` 中硬编码 `SessionManager.inMemory()`（Pi SDK），会话不落盘，进程退出即丢失。
- `SubAgent`（`src/pi/sub-agent.ts`）同样只用 in-memory 会话。
- CLI（`src/cli/commands.ts`）只有 `/provider /model /thinking /apikey /status /exit`，没有多会话、列表、切换、恢复能力。
- Pi SDK 本身已具备持久化会话能力：`SessionManager.create / open / continueRecent / list`（JSONL 文件），见 `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` 与 `session-format.md`。**缺的是 pi-swarm 自己的会话管理层**（元数据、当前指针、关闭状态、生命周期），以及把 `SupervisorAgent` 从 in-memory 切到持久化会话的注入点。

## 2. 目标

1. supervisor 会话默认持久化，重启后可恢复（continueRecent）。
2. 支持多会话：创建、命名、列出、切换、关闭。
3. 生命周期与过期策略：active 会话永不过期；closed 会话按 TTL 从索引清理（文件保留）。
4. 存储抽象：会话索引可替换（内存实现便于测试，JSON 文件实现用于生产）。

## 3. 命名与放置

- 新模块：`src/core/session/`
  - `session-types.ts` — 数据结构与错误类型
  - `session-store.ts` — 存储抽象接口
  - `json-file-session-store.ts` — JSON 文件实现（默认）
  - `session-manager.ts` — pi-swarm 的 `SessionManager` 门面
- Pi SDK 的 `SessionManager` 在我们的代码中一律 `import { SessionManager as PiSessionManager }` 别名导入，避免同名冲突。

## 4. 数据结构（session-types.ts）

```ts
/** pi-swarm 视角的会话元数据（一条索引记录）。 */
export interface SessionRecord {
  /** 会话 id，与 Pi JSONL 会话文件的 sessionId 一致。 */
  id: string;
  /** 用户可读名（/new <name> 提供）；未命名时取首条消息摘要。 */
  name?: string;
  /** JSONL 会话文件绝对路径（由 PiSessionManager.create 产出）。 */
  sessionFile?: string;      // in-memory 会话无文件
  createdAt: string;         // ISO 8601
  updatedAt: string;         // 每次 prompt 触发 touch 更新
  closedAt?: string;         // 存在即视为 closed
  messageCount: number;
  /** 建立会话时的模型 specifier（provider/model），仅展示用。 */
  model?: string;
}

export type SessionStatus = "active" | "closed";

export interface SessionSummary {
  id: string;
  name: string;
  status: SessionStatus;
  current: boolean;          // 是否为当前会话
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
}

/** 错误类型：统一继承 SessionError，便于上层区分与测试断言。 */
export class SessionError extends Error {}
export class SessionNotFoundError extends SessionError {}   // get/switch/close 目标不存在
export class SessionClosedError extends SessionError {}    // switch 到已关闭会话
export class SessionBusyError extends SessionError {}      // prompt 进行中切换被拒绝
```

`SessionRecord.status` 不单独存字段，由 `closedAt` 推导（`closedAt != null ⇒ closed`），避免双状态不一致。

## 5. 存储抽象（session-store.ts）

```ts
/** 会话索引的持久化抽象；镜像 ConfigStore 的两层设计。 */
export interface SessionStore {
  /** 读取全部记录；空索引/损坏文件返回 []（不抛错）。 */
  load(): Promise<SessionRecord[]>;
  /** 全量写入（原子写）。 */
  save(records: SessionRecord[]): Promise<void>;
}
```

- 默认实现 `JsonFileSessionStore`：`<userDataDir>/sessions/index.json`，复用 `JsonFileConfigStore` 的 tmp+rename 原子写法；构造可注入文件路径，测试经 `PI_SWARM_USERDATA` 或显式路径保持封闭。
- 会话正文持久化由 Pi SDK 负责：`PiSessionManager.create(cwd, sessionDir)` 写 JSONL；pi-swarm 的 `sessionDir = <userDataDir>/sessions/`，把所有项目的会话集中到用户数据目录，不污染 repo。
- 测试实现 `InMemorySessionStore`（测试文件内定义即可，不必单独文件）。

## 6. SessionManager 门面（session-manager.ts）

```ts
export interface SessionManagerOptions {
  cwd: string;
  store: SessionStore;
  /** 会话 JSONL 目录；默认 <userDataDir>/sessions。 */
  sessionDir?: string;
  /** closed 会话清理 TTL（毫秒）；默认 30 天；0 = 不清理。 */
  cleanupTtlMs?: number;
  /** 时钟注入，测试用。 */
  now?: () => Date;
}

export class SessionManager {
  /** 载入索引、执行过期清理、恢复 current 指针（索引中最新的 active 会话）。 */
  async initialize(): Promise<void>;

  /** 新建会话：写 Pi JSONL + 索引记录，并设为当前会话。name 经 appendSessionInfo 写入文件。 */
  async create(options?: { name?: string; model?: string }): Promise<SessionRecord>;

  async get(id: string): Promise<SessionRecord | undefined>;      // id 空/不存在 → undefined
  async list(): Promise<SessionSummary[]>;                        // updatedAt 倒序，同毫秒按创建插入顺序倒序决胜（序号稳定），标记 current
  current(): SessionRecord | undefined;

  /** 关闭会话（默认当前会话）：置 closedAt；文件保留可复活。已关闭的重复 close 幂等成功。 */
  async close(id?: string): Promise<SessionRecord>;

  /** 切换会话：校验存在且未关闭，更新 current 指针并返回记录。 */
  async switch(id: string): Promise<SessionRecord>;

  /** prompt 前后回调：更新 updatedAt/messageCount。 */
  async touch(id: string, delta?: { messages?: number }): Promise<void>;

  /** 清理 closedAt 早于 TTL 的索引记录（默认仅删索引，删文件留待后续开关）。 */
  async cleanup(now?: Date): Promise<number>;
}
```

### 切换语义（核心决策）

- **id 由 pi-swarm 生成**（`randomUUID()`）并经 `NewSessionOptions.id` 传入 SDK：预留路径文件名、未来 flush 的 session header、索引记录三者 id 一致。若由 SDK 生成，对未落盘路径 `open()` 会重生成 header id，与索引脱钩。
- **SDK 延迟落盘**：`_persist` 直到首条 assistant 消息才写 JSONL（避免空文件）。因此 `create()` 只预留路径不写文件，name 只存索引；绑定 AgentSession 时若文件不存在则 `PiSessionManager.create(cwd, sessionDir, { id: record.id })` 同 id 重建并回写索引 sessionFile，存在则 `open()`。
- `switch()` 只改指针并返回目标记录；**实际重绑 AgentSession 发生在 SupervisorAgent**：
  - `SupervisorAgentOptions` 增加 `sessionManager?: PiSessionManager`（可选注入）；
  - `ensureSession()` 使用注入的 PiSessionManager（缺省仍 `SessionManager.inMemory()`，向后兼容）；
  - 切换流程（CLI 层编排）：`sessionMgr.switch(id)` → `supervisorAgent.rebind(PiSessionManager.open(record.sessionFile))` → `rebind` 内部 `unsubscribe + session.dispose()` 旧会话、重建 AgentSession 并重新应用 model/thinking；流式输出期间切换抛 `SessionBusyError`。
- `SubAgent` 不纳入本期会话管理（每 agent 一条长会话，随进程关闭）。

### 生命周期与过期策略

| 状态 | 进入 | 可执行操作 | 过期 |
|---|---|---|---|
| active | `create` / `switch` 恢复 | prompt、switch 目标、close | 永不过期 |
| closed | `close` | get/list 可见（标 closed） | `closedAt + cleanupTtlMs` 后由 `cleanup()` 从索引移除；JSONL 文件保留 |

- `initialize()` 时执行一次 `cleanup()`；启动恢复顺序：索引最新 active 会话 → 若其文件存在则 `PiSessionManager.open`，否则退化为 `continueRecent` / 新建。

### 错误处理矩阵

| 场景 | 行为 |
|---|---|
| create 时 name 为空串/纯空白 | 视为未命名，不抛错 |
| get/switch/close：id 空、纯空白或不存在 | switch/close 抛 `SessionNotFoundError`；get 返回 undefined |
| switch 到 closed 会话 | 抛 `SessionClosedError` |
| prompt 进行中 switch | 抛 `SessionBusyError` |
| 索引文件损坏 | `load` 返回 []，降级为空索引（记日志） |
| JSONL 文件丢失但索引存在 | list 仍显示；switch/open 失败时提示并建议 /new |

## 7. CLI 命令（commands.ts 扩展）

| 命令 | 交互 | 非交互 |
|---|---|---|
| `/new [name]` | 创建并切换 | 同左 |
| `/sessions` / `/ls` | 列出（含 id、名称、状态、current 标记、更新时间、消息数） | 同左 |
| `/switch <id\|序号>` | 校验后切换；序号取 /sessions 显示顺序 | 同左 |
| `/close [id\|序号]` | 关闭（缺省当前）并提示"已关闭，输入任务将自动新建会话或 /switch 恢复" | 同左 |

- 约束：当前会话 closed 且用户直接输入任务时，自动 `create()` 新会话承接（无缝体验）。

## 8. 集成点（main.ts）

```
const sessionStore = new JsonFileSessionStore();
const sessionMgr = new SessionManager({ cwd: process.cwd(), store: sessionStore });
await sessionMgr.initialize();           // 恢复 + 清理
const supervisorAgent = new SupervisorAgent({ ..., sessionManager: <恢复到的 PiSessionManager> });
sharedServices.sessions = sessionMgr;    // commands.ts 使用
```

## 9. 测试要点（供 s5）

1. create：生成唯一 id、name 落盘、新会话成为 current。
2. list：按 updatedAt 倒序（同毫秒按创建插入顺序倒序决胜）、closed 状态与 current 标记正确。
3. get/close：不存在 id → NotFoundError（get → undefined）；重复 close 幂等。
4. switch：不存在 → NotFoundError；closed → ClosedError；成功后指针变更。
5. touch：updatedAt 推进、messageCount 累计。
6. cleanup：TTL 内 closed 保留、超期移除、active 永不移除；`cleanupTtlMs=0` 禁用。
7. JsonFileSessionStore：原子写、损坏文件降级 []、PI_SWARM_USERDATA 隔离。
8. SupervisorAgent.rebind：旧会话 dispose、model/thinking 重新应用、busy 时抛错。

## 10. 边界与不做的事

- 不做多进程并发索引写（单进程 CLI，无文件锁）。
- 不删除 JSONL 会话文件（保留审计能力；后续可加 `--purge`）。
- 不管理 SubAgent 会话；不做跨项目 `forkFrom`（列为后续 seam）。
- in-memory 会话（无 sessionFile）仍可存在于索引中，标记无文件即可。
