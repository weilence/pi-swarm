import type { SessionRecord } from "./session-types.ts";

/**
 * 会话索引的持久化抽象；镜像 ConfigStore 的两层设计。第一个实现是
 * JsonFileSessionStore；其他后端只需实现这两个调用。
 */
export interface SessionStore {
  /** 读取全部记录；空索引或损坏文件返回 []（不抛错）。 */
  load(): Promise<SessionRecord[]>;
  /** 全量写入（实现应保证原子性）。 */
  save(records: SessionRecord[]): Promise<void>;
}

/** 会话索引的内存实现：测试与临时进程用，不落盘。 */
export class InMemorySessionStore implements SessionStore {
  private records: SessionRecord[] = [];

  public constructor(initial: SessionRecord[] = []) {
    this.records = [...initial];
  }

  public async load(): Promise<SessionRecord[]> {
    return this.records.map((record) => ({ ...record }));
  }

  public async save(records: SessionRecord[]): Promise<void> {
    this.records = records.map((record) => ({ ...record }));
  }
}
