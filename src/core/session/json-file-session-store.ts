import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserDataDir } from "../userdata.ts";
import type { SessionRecord } from "./session-types.ts";
import type { SessionStore } from "./session-store.ts";

/**
 * JSON 文件 SessionStore；默认 <用户数据目录>/sessions/index.json。写入走
 * tmp+rename 原子替换，与 JsonFileConfigStore 相同的持久化约定。
 */
export class JsonFileSessionStore implements SessionStore {
  private readonly file: string;

  public constructor(file?: string) {
    this.file = file ?? join(getUserDataDir(), "sessions", "index.json");
  }

  public async load(): Promise<SessionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      // 文件缺失或不可读：从空索引开始
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isSessionRecord) : [];
    } catch {
      // 损坏的 JSON：降级为空索引而不是让进程崩溃
      return [];
    }
  }

  public async save(records: SessionRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmpFile = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmpFile, JSON.stringify(records, null, 2), "utf8");
    await rename(tmpFile, this.file);
  }
}

/** 宽松的运行时校验：load 时过滤掉损坏/不完整的记录。 */
function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<SessionRecord>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.messageCount === "number" &&
    Number.isFinite(record.messageCount)
  );
}
