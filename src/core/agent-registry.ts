import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAgentMarkdown, type AgentDefinition } from "./agent-format.ts";
import { getUserDataDir } from "./userdata.ts";
import { resolve } from "node:path";

/** Where agent definitions live: global (user) and project-local directories. */
export interface AgentDirs {
  globalDir: string;
  projectDir: string;
}

/** Default layout: <userData>/agents and <project>/.pi-swarm/agents. */
export function defaultAgentDirs(projectRoot = process.cwd()): AgentDirs {
  return {
    globalDir: join(getUserDataDir(), "agents"),
    projectDir: resolve(projectRoot, ".pi-swarm", "agents")
  };
}

/** The coordinator's reserved name; its definition never appears in the delegate roster. */
export const SUPERVISOR_NAME = "supervisor";

/**
 * Built-in coordinator definition. A `supervisor.md` in the global or project
 * agent directory overrides its prompt (project wins), but the role itself —
 * config persistence, the delegate tool, session switching — stays wired in
 * code; the definition only carries the prompt.
 */
const SUPERVISOR_AGENT_MARKDOWN = `---
name: supervisor
description: pi-swarm 协调者：理解用户任务，规划步骤，用 delegate 把步骤派发给子 agent，并根据真实结果继续决策、汇总最终答复。
capabilities: [任务规划, 步骤派发, 结果汇总]
tools: []
---

You are the pi-swarm Supervisor agent coordinating user-defined sub-agents.
`;

/** The built-in coordinator definition, parsed from the markdown above. */
export function builtinSupervisorDefinition(): AgentDefinition {
  return parseAgentMarkdown(SUPERVISOR_AGENT_MARKDOWN, "<builtin>").agent!;
}

export interface RegistryWarning {
  file: string;
  problems: string[];
}

/**
 * Registry of user-created agents. Loads `*.md` definitions from the global
 * and project directories; on name collisions the project definition wins.
 * Corrupt files are skipped and surfaced through warnings, never thrown.
 * The supervisor definition is resolved separately (project > global >
 * built-in) and never listed as a delegable agent.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();
  private resolvedSupervisor: AgentDefinition = builtinSupervisorDefinition();
  public readonly warnings: RegistryWarning[] = [];

  private constructor(private readonly dirs: AgentDirs) {}

  /** Reads both directories; safe to call on empty/missing directories. */
  public static async load(dirs: AgentDirs, onWarning?: (warning: RegistryWarning) => void): Promise<AgentRegistry> {
    const registry = new AgentRegistry(dirs);
    for (const dir of [dirs.globalDir, dirs.projectDir]) {
      const origin = dir === dirs.globalDir ? "global" : "project";
      let files: string[] = [];
      try {
        files = (await readdir(dir)).filter((file) => file.toLowerCase().endsWith(".md"));
      } catch {
        continue; // missing directory simply means no agents from this origin
      }
      for (const file of files.sort()) {
        const path = join(dir, file);
        let content: string;
        try {
          content = await readFile(path, "utf8");
        } catch (error) {
          registry.recordWarning(path, [`无法读取：${error instanceof Error ? error.message : String(error)}`], onWarning);
          continue;
        }
        const parsed = parseAgentMarkdown(content, path);
        if (!parsed.agent) {
          registry.recordWarning(path, parsed.errors, onWarning);
          continue;
        }
        if (parsed.warnings.length > 0) registry.recordWarning(path, parsed.warnings, onWarning);
        if (parsed.agent.name === SUPERVISOR_NAME) {
          registry.resolvedSupervisor = parsed.agent; // later origins (project) win
          continue;
        }
        if (origin === "project" && registry.agents.has(parsed.agent.name)) {
          registry.agents.delete(parsed.agent.name); // project re-definition replaces global
        }
        registry.agents.set(parsed.agent.name, parsed.agent);
      }
    }
    return registry;
  }

  /** The coordinator's definition (prompt overridable, role wired in code). */
  public get supervisor(): AgentDefinition {
    return this.resolvedSupervisor;
  }

  /** All agents, project definitions shadowing global ones, sorted by name. */
  public list(): AgentDefinition[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Look up one agent by name; undefined when absent. */
  public get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  public get size(): number {
    return this.agents.size;
  }

  private recordWarning(file: string, problems: string[], onWarning?: (warning: RegistryWarning) => void): void {
    const warning = { file, problems };
    this.warnings.push(warning);
    onWarning?.(warning);
  }
}
