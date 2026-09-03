import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserDataDir } from "../userdata.ts";
import type { AgentConfigSnapshot, ConfigStore } from "./config-store.ts";

/** JSON-file ConfigStore; defaults to <user data dir>/config.json. */
export class JsonFileConfigStore implements ConfigStore {
  private readonly file: string;

  public constructor(file?: string) {
    this.file = file ?? join(getUserDataDir(), "config.json");
  }

  public async load(): Promise<AgentConfigSnapshot> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as AgentConfigSnapshot;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      // missing or corrupt file: start from an empty snapshot
      return {};
    }
  }

  public async save(config: AgentConfigSnapshot): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmpFile = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmpFile, JSON.stringify(config, null, 2), "utf8");
    await rename(tmpFile, this.file);
  }
}
