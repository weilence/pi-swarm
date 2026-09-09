# 并行会话与 Worktree — 设计文档（s2）

## 1. 现状与问题

s1（`docs/session-design.md`）交付了多会话管理（创建/切换/关闭/删除 + JSONL 持久化），但执行模型仍是**单活跃会话**：

- 全局只有一个 supervisor `Agent` 实例（`src/cli/main.ts` 的 `supervisorAgent`），切换会话 = `Agent.rebind` 把这一个 AgentSession 重绑到另一个 Pi 会话；`prompting` 期间 rebind/detach/switch 一律抛 `SessionBusyError`（`src/pi/agent.ts`）。**会话 A 输出中无法切到会话 B**——本期要解决的核心痛点。
- 转录按 agent 存储（`ChatPanel.tabs: Map<agentName, AgentTranscript>`，`src/cli/chat-panel.ts`），切会话靠清屏 + JSONL 历史回放。这个模型天然只支持一个活跃会话。
- 子 agent 每定义一个全局长驻实例（`main.ts` 的 `subAgents` Map），cwd 固定启动目录；多个会话并行派发会争抢同一个子 agent 会话。
- 没有 worktree 概念：所有会话共享同一工作副本，"并行做修改类任务"必然互相踩踏。

## 2. 目标

1. **会话执行与 UI 焦点解耦**：会话 A 流式输出时可切到 B 继续输入/执行；A 在后台继续跑，流式内容持续写入自己的转录缓冲，切回时**补放**（无需重放 JSONL）。
2. **worktree 是作用域容器**（近似 opencode 的模型）：`/worktree [name]` 先切换进某个 worktree（不存在则创建，name 省略用随机名），会话在其中创建并**终身归属**该作用域——没有「会话绑 worktree / 改绑 / 迁移」的概念。归属作用域的目录就是该会话 supervisor 上下文与其派发的子 agent 的 cwd。
3. **不强制隔离**：主工作区是默认作用域；同一作用域允许多个会话共存（读码、review 等非修改任务并行）。
4. **切入即恢复**：切进一个作用域自动恢复其中最近活跃的会话；没有会话则进入该作用域的草稿态。
5. **状态栏显示当前作用域名**（主工作区或 worktree 名）。

## 3. 非目标

- 同作用域内多会话的写冲突检测 / 自动 merge。
- worktree 删除与清理（`git worktree remove/prune`），目录残留手动清理，后续可加 `/worktree prune`。
- 跨作用域变更搬运（fork-with-changes）：脏变更属于 worktree 不属于会话；「换了 worktree 继续改」= 旧作用域先提交（或自行搬运文件），不做工具化。
- 每个 context 独立的模型偏好 UI：`/model /thinking /apikey` 仍作用于聚焦会话并持久化为全局默认，新 context 创建时从持久化配置恢复（`restore()` 语义）。
- 多进程并行；context 池不做淘汰（进程生命周期内驻留）。
- 同一会话内同层并行步骤撞同一子 agent 的串行化（既有问题，不在本期）。

## 4. 命名与放置

- 新模块 `src/core/worktree/`：
  - `worktree-registry.ts` — 发现仓库根、创建/解析 worktree、随机命名；
  - `worktree-types.ts` — 数据结构与错误类型。
- 新模块 `src/core/session/session-context.ts` — `SessionContext` + `SessionContextPool`（每会话执行上下文）。
- 数据结构变更在既有 `session-types.ts` / `session-store.ts` 内扩展，不新开索引文件。

## 5. 核心决策一：每会话一个执行上下文（并行）

### 5.1 SessionContext 与池

```ts
/** 一个会话的全部执行资源：supervisor agent + 它派发的子 agent 池。 */
export interface SessionContext {
  readonly id: string;
  /** 本会话的 supervisor agent（经 createAgent 工厂创建，注入本会话的 PiSessionManager）。 */
  readonly agent: Agent;
  /** 子 agent 按需懒创建，cwd = 本会话的 worktree 目录；随 context 释放。 */
  readonly subAgents: Map<string, Agent>;
  /** 归属的作用域名；undefined = 主工作区。 */
  readonly worktree?: string;
}

export class SessionContextPool {
  /** 取聚焦会话的 context；无会话/草稿返回 undefined。 */
  focused(): SessionContext | undefined;
  /** 取指定会话的 context；首次访问时创建（lazy），进程内缓存。 */
  get(id: string): Promise<SessionContext>;
  /** 释放（close/delete 会话时）：dispose agent 与子 agent，移出缓存。 */
  dispose(id: string): Promise<void>;
}
```

- 创建 context 时经既有 `createAgent` 工厂 + `SessionRegistry.bind(id)` 产出 PiSessionManager 注入；provider/model/thinking 从持久化配置 `restore()`。
- 子 agent 从全局 Map 改挂到 context 上（**按会话隔离**）：不同会话的 delegate 各用各的子 agent 实例，cwd 各自跟随本会话 worktree，模型缺省拉本 context 的 supervisor（`context.agent.currentModel`）。不隔离则 worktree 隔离对 delegate 派发的任务无效（全局实例固定在主工作区 cwd）——这正是必须改挂的原因。同一会话内同层并行步骤撞同一子 agent 仍是既有边界（§3）。
- **切换会话不再走 rebind**：`switchToSessionId`（`session-flows.ts`）退化为「移动指针 + 视图挂载」，毫秒级、永不因 busy 失败。`Agent.rebind/detach` 仅供 context 内部与测试使用，`SessionBusyError` 从切换路径上消失。

### 5.2 转录与补放

- `ChatPanel.tabs` 由 `Map<agentName, AgentTranscript>` 改为 `Map<sessionId, SessionTranscripts>`（内含 `byAgent` 与 tab 顺序）；AgentTabBar 展示聚焦会话的 agent 集。
- 流式输出始终写入**事件所属会话**的缓冲，无论是否聚焦；切换 = 把目标会话的缓冲整体挂载进 scrollBody（O(1) 换引用）。后台期间的增量天然已在缓冲里，切回即完整补放。
- JSONL 历史回放（`history-replay.ts`）只保留一个用途：**进程重启后**首次切入旧会话时填充缓冲；进程内切换不再重放。

### 5.3 事件路由

- `AgentEvent`（`src/pi/agent-events.ts`）增加 `sessionId` 字段（Agent 构造时知道自己属于哪个会话；子 agent 继承所在 context 的会话 id）。
- `OutputRouter` 按 `sessionId + agent` 双键路由：聚焦会话走实时流；非聚焦只写缓冲、推进该会话的 unread 计数与 busy 标记（侧栏行显示 `● 输出中` / 未读数）。
- 状态栏轮询快照来源从单个 `supervisorAgent` 改为 `pool.focused()?.agent`；侧栏 busy/unread 快照在同一轮询里刷新。

### 5.4 busy 语义矩阵（变化以粗体标出）

| 操作 | 现行为 | s2 行为 |
|---|---|---|
| 输出中切换会话 / 作用域 | 拒绝 | **允许（纯视图操作）** |
| 输出中开草稿（/new） | 拒绝（需 detach） | **允许（不再 detach 任何 context）** |
| 聚焦会话输出中再输入 | 拒绝 | 拒绝（同会话并发 prompt 仍然互斥） |
| 输出中 close/delete 该会话 | 拒绝 | 拒绝（先双击 Esc 中止或等完成；close/delete 只针对其自身） |
| 双击 Esc | 中止唯一会话 | **只中止聚焦会话**；后台会话继续跑 |

## 6. 核心决策二：worktree 作用域（容器模型）

### 6.1 模型

worktree 不是会话的属性，而是**包含会话的作用域容器**（近似 opencode）：先切换进某个 worktree，再在其中创建会话；会话创建时归属当前作用域并**终身不变**。主工作区是默认作用域。

由此消失的概念与复杂度：

- **没有改绑**：不存在「把会话搬到另一个 worktree」，也就没有未提交变更迁移——脏变更属于 worktree 不属于会话；「换了 worktree 继续改」= 旧作用域先提交（或自行搬运文件），再在新作用域开新会话。
- **没有共享告警**：同一作用域建多个会话就是显式的共享，是正常用法（非修改任务并行），不是需要警告的边缘情况。
- **归属即 cwd**：会话的 supervisor context 与其子 agent 的 cwd 永远 = 归属作用域的目录，创建 context 时一次定死。
- 作用域指针不持久化：启动总在主工作区；跨作用域恢复靠侧栏分组点击或 `/sessions`（点击其他作用域的会话 = 切作用域 + 切会话，同一动作）。

### 6.2 WorktreeRegistry（只管目录与分支，不管会话）

```ts
export interface WorktreeInfo {
  name: string;       // 同时是分支名与目录名
  path: string;       // 绝对路径 <repoRoot>/.pi-swarm/worktrees/<name>
  created: boolean;   // 本次是否新建
}

export class WorktreeRegistry {
  /** git rev-parse --show-toplevel 解析仓库根；非 git 仓库抛 WorktreeError。 */
  ensureRoot(): Promise<string>;
  /** create-or-resolve：无 name 时随机（wt- + 6 位 base36）。 */
  createOrResolve(name?: string): Promise<WorktreeInfo>;
  pathOf(name: string): string;
}
```

- 根目录 `<repoRoot>/.pi-swarm/worktrees/`，创建时确保 `.gitignore` 含该条目（避免主工作区状态噪声）。
- 名称规则 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`（分支名安全子集）；`.` 是保留引用（= 主工作区），恰好不满足名称规则，不会与真实 worktree 撞名。
- create-or-resolve 语义：
  1. `git worktree list --porcelain` 已注册该路径 → 直接返回（复用，不新建）；
  2. 分支存在（`git rev-parse --verify refs/heads/<name>`）但未挂载 → `git worktree add <path> <name>`；
  3. 否则 → `git worktree add -b <name> <path>`（基于 HEAD）；
  4. 路径已存在但未注册 → 报错（防止把无关目录当 worktree）。

### 6.3 数据结构与作用域指针

```ts
// session-types.ts 增量
export interface SessionRecord {
  // ...既有字段...
  /** 创建时归属的作用域名；undefined = 主工作区。终身不变。 */
  worktree?: string;
}
```

- `SessionRegistry` 增加作用域指针 `currentWorktree?: string`（undefined = 主工作区）与 `switchWorktree(name?: string)`；`materialize()` 给新会话盖**当前作用域**章（草稿名仍是全局的，物化落在当时的作用域）。指针只存内存，不进索引文件。
- `SessionRegistry` 注入 `resolveWorktreeCwd?: (name: string) => Promise<string | undefined>`（缺省恒返 undefined），`bind()` 按 `record.worktree` 解析 cwd 后传给 `createPiSession(cwd, …)` / `openPiSession(file, dir, cwd)`（SDK 的 cwdOverride 缝已存在）；旧会话无该字段，行为不变。session 模块不依赖 git 实现。
- 记录里的作用域目录丢失（被手动删除）：`bind()` 报错提示，**不静默回退**主工作区。

### 6.4 `/worktree` 流程（切换作用域，与会话解耦）

| 步骤 | 行为 |
|---|---|
| 解析目标 | `.` → 主工作区；已注册 → 复用；未注册 → 创建（§6.2）；name 省略 → 随机名创建 |
| 移动指针 | `switchWorktree(name)`（undefined = 主工作区） |
| 恢复现场 | 作用域内有活跃会话 → 自动切到 updatedAt 最近的会话（与侧栏同序）；没有 → 草稿态并清空转录（草稿名重置，避免「草稿叫 X 却落在 Y 作用域」的错位） |
| busy | 纯视图操作，永不拒绝（与切会话同一性质） |

- `/worktree` 不再接触任何会话的执行资源：不 dispose context、不改会话记录、不迁移文件。
- 状态栏与侧栏组头即时反映新作用域。

### 6.5 状态栏与展示

- `AgentStatusSnapshot` 增加 `worktree?: string`；`StatusBar`（`src/cli/components.ts`）在最前渲染 `⎇ <作用域名>`，主工作区显示 `⎇ 主工作区`。
- 侧栏按作用域分组：主工作区组在最上，其后每个 worktree 一组（组头 = 作用域名），组内会话按 updatedAt 倒序；busy/unread 标记在行内。
- `/sessions` 按同样分组输出。

## 7. CLI 命令（commands.ts 扩展）

| 命令 | 交互 | 非交互 |
|---|---|---|
| `/worktree [name]` | 切换作用域：`.` 回主工作区；name 省略随机新建；切入后自动恢复该作用域最近活跃会话或进入草稿 | 同左（log 反馈） |
| `/worktrees` | 列出作用域（各作用域会话数、当前标记） | 同左 |
| `/sessions` | 按作用域分组列出 | 同左 |

其余命令语义不变；`/switch` 不再有 busy 拒绝分支。

## 8. 集成点（main.ts）

```
const worktrees = new WorktreeRegistry({ cwd: process.cwd() });
const sessionManager = new SessionRegistry({
  cwd: process.cwd(), store: sessionStore,
  resolveWorktreeCwd: (name) => worktrees.pathOf(name),
});
const pool = new SessionContextPool({ sessions: sessionManager, worktrees, sharedRuntime, ... });
// supervisorAgent 单例与全局 subAgents Map 移除；CommandServices.agent → pool 的聚焦门面
// OutputRouter.attachContext(pool)；isBusy/onAbort 走聚焦 context
// 作用域指针在 SessionRegistry（currentWorktree，内存态）：/worktree 只动它，不碰任何 context
```

## 9. 测试要点（供 s5）

1. **并行**：A 流式中 `switch` B 成功且 A 不中断；A 的增量持续写入 A 缓冲；切回 A 补放完整（无 JSONL 重放）。
2. busy 矩阵逐行覆盖（§5.4）：同会话并发 prompt 拒绝；busy 会话 close/delete 拒绝；双击 Esc 只影响聚焦会话。
3. 事件路由：`sessionId` 归位正确；非聚焦会话 unread/busy 计数推进、切回清零。
4. `/worktree`：随机名创建、已注册复用、`.` 回主工作区、切入自动恢复最近活跃会话、空作用域进草稿（草稿名重置）、路径已存在未注册报错、非 git 目录报错。
5. 归属不变量：materialize 盖章当前作用域；`record.worktree` 此后永不变；重启后归属保留、作用域指针回到主工作区。
6. cwd 注入：`bind()` 的 create/open 参数 = 归属作用域路径；子 agent cwd 同；目录丢失报错不回退；无 worktree 字段的旧索引行为不变。
7. 重启恢复：旧 JSONL 会话首次切入仍走回放路径。
8. **原型验证**：同一 `ModelRuntime` 上 ≥2 个会话并发流式输出互不串扰（事件、统计、abort）。
9. 侧栏分组：跨作用域点击 = 切作用域 + 切会话同一动作；busy/unread 标记在分组下正确。

## 10. 边界与不做的事

- 不做 worktree 删除/清理；残留目录手动 `git worktree prune` + 删目录。
- 不做同作用域写冲突检测（提示都算加戏，先不做）。
- 不做跨作用域变更搬运（fork-with-changes）：脏变更跟 worktree 走，会话永不移动。
- context 池无淘汰，长会话多开时内存随进程增长（原型可接受）。
- 单进程 CLI；不做跨终端共享同一池。
