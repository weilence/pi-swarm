import { basename } from "node:path";

/**
 * User-defined sub-agent persisted as a Markdown document: YAML frontmatter
 * carries the meta fields (name, description, capabilities, tools, model) and
 * the body below the second `---` fence is the agent's system prompt.
 * Follows the mainstream convention used by Claude Code subagents / AGENTS.md.
 */
export interface AgentDefinition {
  /** Unique slug identifying the agent; also used for routing. */
  name: string;
  /** One-liner shown to the Supervisor's LLM matcher. */
  description: string;
  /** What the agent can do; used for task matching. */
  capabilities: string[];
  /** Tools / permissions granted to the agent (e.g. read, bash). */
  tools: string[];
  /** Optional model specifier, e.g. `anthropic/claude-sonnet-4-5`. */
  model?: string;
  /** Free-form tags for grouping; optional. */
  tags: string[];
  /** The Markdown body: system prompt for the agent session. */
  systemPrompt: string;
  /** File the definition was loaded from (for diagnostics). */
  sourceFile: string;
}

export interface AgentParseResult {
  agent?: AgentDefinition;
  /** Blocking problems: the definition is unusable. */
  errors: string[];
  /** Non-blocking problems: suspicious but tolerated. */
  warnings: string[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/;
const KNOWN_FIELDS = new Set(["name", "description", "capabilities", "tools", "model", "tags"]);

/** Parses one `key: value` / `- item` frontmatter block; returns undefined when absent. */
function parseFrontmatter(raw: string): Record<string, string | string[]> | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const fields: Record<string, string | string[]> = {};
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const keyMatch = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (keyMatch) {
      const [, key, inline] = keyMatch;
      const inlineItems = splitList(inline);
      if (inlineItems) {
        fields[key] = inlineItems;
        index += 1;
        continue;
      }
      if (inline.trim() === "") {
        // Block list: collect following `- item` lines (and blank separators).
        const items: string[] = [];
        index += 1;
        while (index < lines.length) {
          const item = /^\s+-\s+(.*)$/.exec(lines[index]);
          if (!item) {
            if (lines[index].trim() === "" && /^\s+-\s+/.test(lines[index + 1] ?? "")) {
              index += 1;
              continue;
            }
            break;
          }
          items.push(item[1].trim());
          index += 1;
        }
        fields[key] = items;
        continue;
      }
      fields[key] = stripQuotes(inline.trim());
      index += 1;
      continue;
    }
    index += 1;
  }
  return fields;
}

/** `a, b, c` or `[a, b]` → items; plain scalar → undefined. */
function splitList(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item.length > 0);
  }
  if (/^[^,"[\]]+,/.test(trimmed)) {
    return trimmed.split(",").map((item) => stripQuotes(item.trim())).filter((item) => item.length > 0);
  }
  return undefined;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function asStringList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const single = String(value).trim();
  return single ? [single] : [];
}

/**
 * Parses and validates an agent definition document. Never throws: problems
 * are reported through errors (unusable) and warnings (tolerated).
 */
export function parseAgentMarkdown(content: string, sourceFile = "<memory>"): AgentParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  if (!fence) {
    return { errors: ["缺少 frontmatter：文档需以 `---` 包裹的 YAML 元信息开头"], warnings };
  }
  const fields = parseFrontmatter(`---\n${fence[1]}`) ?? {};
  const systemPrompt = content.slice(fence[0].length).trim();

  for (const key of Object.keys(fields)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`未知字段：${key}（已忽略）`);
  }

  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (!name) errors.push("缺少必填字段：name");
  else if (!NAME_PATTERN.test(name)) errors.push(`name 非法（应为小写 slug，如 code-reviewer）：${name}`);

  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!description) errors.push("缺少必填字段：description");
  else if (description.length < 8) warnings.push("description 过短，建议写清职责以提升任务匹配质量");

  const capabilities = asStringList(fields.capabilities);
  if (capabilities === undefined) warnings.push("capabilities 未提供或为空，任务匹配将只依赖 description");
  const tools = asStringList(fields.tools) ?? [];
  const tags = asStringList(fields.tags) ?? [];
  if (fields.model !== undefined && typeof fields.model !== "string") errors.push("model 必须是字符串");
  if (!systemPrompt) warnings.push("正文为空：未提供 system prompt，agent 将缺少具体行为指令");

  if (errors.length > 0) return { errors, warnings };

  return {
    agent: {
      name,
      description,
      capabilities: capabilities ?? [],
      tools,
      model: typeof fields.model === "string" && fields.model.trim() ? fields.model.trim() : undefined,
      tags,
      systemPrompt,
      sourceFile
    },
    errors,
    warnings
  };
}

/** Suggests an agent name from the file name when `name` is omitted. */
export function suggestAgentName(filePath: string): string {
  return basename(filePath).replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9-.]+/g, "-");
}
