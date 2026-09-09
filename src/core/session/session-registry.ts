import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager as PiSessionManager, type NewSessionOptions } from "@earendil-works/pi-coding-agent";
import { getUserDataDir } from "../userdata.ts";
import type { SessionRecord, SessionSummary } from "./session-types.ts";
import { normalizeOptionalText, sessionStatus, SessionClosedError, SessionError, SessionNotFoundError } from "./session-types.ts";
import type { SessionStore } from "./session-store.ts";

/** 可注入的 Pi 会话工厂；默认 PiSessionManager.create（测试可替换为 inMemory）。 */
export type PiSessionFactory = (
  cwd: string,
  sessionDir?: string,
  options?: NewSessionOptions
) => PiSessionManager;

/** 可注入的 Pi 会话打开器；默认 PiSessionManager.open。 */
export type PiSessionOpener = (
  path: string,
  sessionDir?: string,
  cwdOverride?: string
) => PiSessionManager;

export interface SessionRegistryOptions {
  cwd: string;
  store: SessionStore;
  /** 会话 JSONL 目录；默认 <用户数据目录>/sessions。 */
  sessionDir?: string;
  /** closed 会话清理 TTL（毫秒）；默认 30 天；<= 0 表示禁用清理。 */
  cleanupTtlMs?: number;
  /** 时钟注入，测试用。 */
  now?: () => Date;
  /** Pi 会话工厂注入，测试用。 */
  createPiSession?: PiSessionFactory;
  /** Pi 会话打开器注入，测试用。 */
  openPiSession?: PiSessionOpener;
}

/** 默认过期阈值：30 天。 */
export const DEFAULT_CLEANUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * pi-swarm 的会话管理门面：维护会话索引（SessionStore）、当前指针与
 * 生命周期。会话正文由 Pi SDK 的 SessionManager 以 JSONL 落盘，本类只
 * 管理元数据；实际把 AgentSession 绑定到某个会话文件由 supervisor agent
 * 的 rebind 流程完成（见 docs/session-design.md）。
 */
export class SessionRegistry {
  private readonly cwd: string;
  private readonly store: SessionStore;
  private readonly sessionDir: string;
  private readonly cleanupTtlMs: number;
  private readonly now: () => Date;
  private readonly createPiSession: PiSessionFactory;
  private readonly openPiSession: PiSessionOpener;
  private records: SessionRecord[] = [];
  private currentId?: string;
  /** 草稿态开启标志；与 currentId 解耦：未命名草稿也要与启动时的「无会话」区分开。 */
  private draftOpen = false;
  /** 草稿态的待用名字（/new <name> 提供）；物化时作为会话名，无则用首条消息摘要。 */
  private draftName?: string;
  /** 串行化索引变更的互斥队列：并发 switch/create/close/touch 不会交错写。 */
  private tail: Promise<unknown> = Promise.resolve();

  public constructor(options: SessionRegistryOptions) {
    if (!options.cwd.trim()) throw new SessionError("cwd 不能为空");
    this.cwd = options.cwd;
    this.store = options.store;
    this.sessionDir = options.sessionDir ?? join(getUserDataDir(), "sessions");
    this.cleanupTtlMs = options.cleanupTtlMs ?? DEFAULT_CLEANUP_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.createPiSession = options.createPiSession ?? ((cwd, dir, opts) => PiSessionManager.create(cwd, dir, opts));
    this.openPiSession = options.openPiSession ?? ((path, dir, cwd) => PiSessionManager.open(path, dir, cwd));
  }

  /** 把变更操作排入互斥队列；单次失败不阻断后续操作。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** 载入索引并执行过期清理；当前指针保持为空，只由 create/switch/close 驱动。 */
  public initialize(): Promise<void> {
    return this.enqueue(async () => {
      this.records = await this.store.load();
      await this.cleanupInternal(this.now());
    });
  }

  /**
   * 进入草稿态：不创建任何记录，只清空当前指针并记住待用名字。所有「新建
   * 会话」入口（/new、会话栏「＋」）都走这里；真正的创建推迟到首次任务
   * （materialize）。幂等：已是草稿且未提供新名字时保持原名字不变。
   */
  public startDraft(name?: string): void {
    const normalized = normalizeOptionalText(name);
    if (normalized) this.draftName = normalized;
    else if (!this.draftOpen) this.draftName = undefined;
    this.draftOpen = true;
    this.currentId = undefined;
  }

  /** 是否处于草稿态（已显式开启草稿且尚无当前会话）。 */
  public isDraft(): boolean {
    return this.draftOpen && this.currentId === undefined;
  }

  /**
   * 物化草稿：为首次任务创建真实会话并设为当前。名字取显式草稿名，否则用
   * fallbackName（首条消息摘要）。已有当前会话时幂等返回它（并丢弃草稿名）。
   */
  public materialize(fallbackName?: string): Promise<SessionRecord> {
    return this.enqueue(async () => {
      const current = this.records.find((candidate) => candidate.id === this.currentId);
      const name = normalizeOptionalText(this.draftName ?? fallbackName);
      this.draftOpen = false;
      this.draftName = undefined;
      if (current) return { ...current };
      return await this.createInternal({ name });
    });
  }

  /**
   * 新建会话：预留 Pi JSONL 路径并写入索引，同时设为当前会话。
   *
   * 注：Pi SDK 延迟落盘（首条 assistant 消息到达才写文件），因此这里不向
   * 即将丢弃的 Pi 实例 append 任何条目；name 只存索引，待 s3 绑定
   * AgentSession 时再 appendSessionInfo 同步进文件。返回记录的防御性副本。
   */
  public create(options: { name?: string; model?: string } = {}): Promise<SessionRecord> {
    return this.enqueue(() => this.createInternal(options));
  }

  private async createInternal(options: { name?: string; model?: string }): Promise<SessionRecord> {
    const name = normalizeOptionalText(options.name);
    const model = normalizeOptionalText(options.model);
    const timestamp = this.now().toISOString();
    // 由我们生成 id 并回传 SDK：预留路径、未来 flush 的 header、索引三者 id 一致；
    // 否则对未落盘路径 open() 会重生成 header id，与索引脱钩。
    const id = randomUUID();
    const pi = this.createPiSession(this.cwd, this.sessionDir, { id });
    if (!id || !pi.getSessionId() || this.records.some((record) => record.id === id)) {
      throw new SessionError("新建会话失败：id 为空或与现有会话冲突");
    }
    const record: SessionRecord = {
      id,
      ...(name ? { name } : {}),
      ...(pi.isPersisted() && pi.getSessionFile() ? { sessionFile: pi.getSessionFile() } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
      ...(model ? { model } : {})
    };
    // 先持久化再改内存：save 失败（磁盘满等）时内存索引与指针保持原状，
    // 不会出现 current 指向未落盘会话的不一致。
    await this.store.save([...this.records, record]);
    this.records.push(record);
    this.currentId = id;
    return { ...record };
  }

  /**
   * 切换当前会话：目标不存在（含 id 为空或纯空白）抛 SessionNotFoundError；
   * 已关闭抛 SessionClosedError；成功后更新当前指针并持久化。只改指针，
   * AgentSession 的实际重绑由调用方经 bind() + Agent.rebind() 完成。
   */
  public switch(id: string): Promise<SessionRecord> {
    return this.enqueue(() => this.switchInternal(id));
  }

  private async switchInternal(id: string): Promise<SessionRecord> {
    const target = this.find(id);
    if (!target) throw new SessionNotFoundError(`会话不存在：${normalizeOptionalText(id) ?? "(空)"}`);
    if (target.closedAt) throw new SessionClosedError(`会话已关闭，无法切换：${target.name ?? target.id}`);
    this.currentId = target.id;
    // 切到真实会话即离开草稿态：草稿名随切换丢弃。
    this.draftOpen = false;
    this.draftName = undefined;
    await this.store.save(this.records);
    return { ...target };
  }

  /**
   * 绑定契约：为目标会话返回可用的 Pi 会话实例。JSONL 已落盘 → open()；
   * 尚未落盘（SDK 延迟写，首条 assistant 消息前无文件）→ create({id})
   * 同 id 重建并把新预留路径回写索引，保证 id 一致。closed 会话拒绝绑定。
   */
  public bind(id: string): Promise<PiSessionManager> {
    return this.enqueue(() => this.bindInternal(id));
  }

  private async bindInternal(id: string): Promise<PiSessionManager> {
    const record = this.find(id);
    if (!record) throw new SessionNotFoundError(`会话不存在：${normalizeOptionalText(id) ?? "(空)"}`);
    if (record.closedAt) throw new SessionClosedError(`会话已关闭，无法绑定：${record.name ?? record.id}`);
    if (record.sessionFile && (await fileExists(record.sessionFile))) {
      return this.openPiSession(record.sessionFile, this.sessionDir, this.cwd);
    }
    const pi = this.createPiSession(this.cwd, this.sessionDir, { id: record.id });
    const file = pi.isPersisted() ? pi.getSessionFile() : undefined;
    if (file && file !== record.sessionFile) {
      record.sessionFile = file;
      await this.store.save(this.records);
    }
    return pi;
  }

  /** 查询会话：id 为空、纯空白或不存在时返回 undefined。 */
  public get(id: string | undefined): SessionRecord | undefined {
    const record = this.find(id);
    return record ? { ...record } : undefined;
  }

  /** 全部会话摘要：按 updatedAt 倒序并标记当前会话。 */
  public async list(): Promise<SessionSummary[]> {
    return this.sortedRecords().map((record) => this.toSummary(record));
  }

  /** 当前会话（始终为 active；关闭当前会话后指针清空）。 */
  public current(): SessionRecord | undefined {
    const record = this.records.find((candidate) => candidate.id === this.currentId);
    return record && sessionStatus(record) === "active" ? { ...record } : undefined;
  }

  /**
   * 关闭会话（默认当前会话）：置 closedAt，JSONL 文件保留可复活。已关闭的
   * 会话重复 close 幂等成功；关闭当前会话会清空当前指针。
   */
  public close(id?: string): Promise<SessionRecord> {
    return this.enqueue(() => this.closeInternal(id));
  }

  private async closeInternal(id?: string): Promise<SessionRecord> {
    const target = this.resolveCloseTarget(id);
    if (!target.closedAt) {
      target.closedAt = this.now().toISOString();
      await this.store.save(this.records);
    }
    if (this.currentId === target.id) this.currentId = undefined;
    return { ...target };
  }

  /**
   * 删除会话：从索引移除并尽力删除 JSONL 文件（区别于 close 的只标记）；
   * 文件删除失败（如被占用）不回滚索引——与 cleanup 的「文件可残留」策略
   * 一致。删除当前会话会清空当前指针；调用方负责先解绑 agent（释放文件
   * 句柄）。
   */
  public delete(id: string): Promise<SessionRecord> {
    return this.enqueue(() => this.deleteInternal(id));
  }

  private async deleteInternal(id: string): Promise<SessionRecord> {
    const target = this.find(id);
    if (!target) throw new SessionNotFoundError(`会话不存在：${normalizeOptionalText(id) ?? "(空)"}`);
    this.records = this.records.filter((record) => record.id !== target.id);
    if (this.currentId === target.id) this.currentId = undefined;
    await this.store.save(this.records);
    if (target.sessionFile) {
      await rm(target.sessionFile, { force: true }).catch(() => undefined);
    }
    return { ...target };
  }

  /** prompt 前后回调：推进 updatedAt 并累计 messageCount。 */
  public touch(id: string, delta: { messages?: number } = {}): Promise<void> {
    return this.enqueue(async () => {
      const target = this.find(id);
      if (!target) throw new SessionNotFoundError(`会话不存在：${id.trim()}`);
      target.updatedAt = this.now().toISOString();
      target.messageCount = Math.max(0, target.messageCount + (delta.messages ?? 0));
      await this.store.save(this.records);
    });
  }

  /**
   * 清理 closedAt 早于 TTL 的索引记录（默认仅删索引，JSONL 文件保留）。
   * cleanupTtlMs <= 0 时禁用；返回被移除的记录数。
   */
  public cleanup(now?: Date): Promise<number> {
    return this.enqueue(() => this.cleanupInternal(now ?? this.now()));
  }

  private async cleanupInternal(at: Date): Promise<number> {
    if (this.cleanupTtlMs <= 0) return 0;
    const cutoff = at.getTime() - this.cleanupTtlMs;
    const expired = new Set(
      this.records
        .filter((record) => {
          if (!record.closedAt) return false;
          const closedAtMs = Date.parse(record.closedAt);
          return Number.isFinite(closedAtMs) && closedAtMs <= cutoff;
        })
        .map((record) => record.id)
    );
    if (expired.size === 0) return 0;
    this.records = this.records.filter((record) => !expired.has(record.id));
    if (expired.has(this.currentId ?? "")) this.currentId = undefined;
    await this.store.save(this.records);
    return expired.size;
  }

  private find(id: string | undefined): SessionRecord | undefined {
    const normalized = normalizeOptionalText(id);
    if (!normalized) return undefined;
    return this.records.find((record) => record.id === normalized);
  }

  private resolveCloseTarget(id: string | undefined): SessionRecord {
    if (id === undefined) {
      const current = this.current();
      if (!current) throw new SessionNotFoundError("没有当前会话可关闭");
      return this.records.find((record) => record.id === current.id)!;
    }
    const target = this.find(id);
    if (!target) throw new SessionNotFoundError(`会话不存在：${id.trim() || "(空)"}`);
    return target;
  }

  private sortedRecords(): SessionRecord[] {
    // updatedAt 倒序；同毫秒时按创建插入顺序倒序决胜（records 数组在 save/load
    // 间保序），保证 /sessions 序号稳定，不会退化成随机的 id 字典序。
    const position = new Map(this.records.map((record, index) => [record.id, index]));
    return [...this.records].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || position.get(b.id)! - position.get(a.id)!
    );
  }

  private toSummary(record: SessionRecord): SessionSummary {
    return {
      id: record.id,
      name: record.name ?? record.id,
      status: sessionStatus(record),
      current: record.id === this.currentId && sessionStatus(record) === "active",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messageCount,
      ...(record.model ? { model: record.model } : {})
    };
  }
}

/** 文件存在性检查；任何错误（缺失、权限）都视为不存在。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
