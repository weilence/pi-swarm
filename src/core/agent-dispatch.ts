import type { AgentDefinition } from "./agent-format.ts";

/**
 * Routing decision for one task step: hand it to a matched user-created
 * agent, or let the Supervisor execute it directly.
 */
export type DispatchDecision =
  | { mode: "agent"; agent: AgentDefinition }
  | { mode: "supervisor"; reason: string };

/** LLM matcher callback: receives the prompt, returns the raw model reply. */
export type AgentMatcher = (prompt: string) => Promise<string>;

/** Builds the matching prompt sent to the LLM for one task. */
export function buildMatchPrompt(task: string, agents: AgentDefinition[]): string {
  const catalog = agents
    .map((agent) => {
      const capabilities = agent.capabilities.length > 0 ? `；能力：${agent.capabilities.join("、")}` : "";
      return `- name: ${agent.name}\n  description: ${agent.description}${capabilities}`;
    })
    .join("\n");
  return [
    "你是任务调度器。根据下面的任务信息与候选 agent 列表，选出最合适的 agent。",
    "如果没有合适的 agent，返回 null。",
    "仅输出 JSON：{\"agent\": \"<agent name 或 null>\"}",
    "",
    `任务：${task}`,
    "",
    "候选 agent：",
    catalog
  ].join("\n");
}

/** Defensive parse of the matcher reply: agent name, null, or undefined on garbage. */
export function parseMatchReply(reply: string): { agent: string | null } | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const raw = fenced ? fenced[1] : reply;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const payload = JSON.parse(raw.slice(start, end + 1)) as { agent?: unknown };
    if (payload.agent === null) return { agent: null };
    if (typeof payload.agent === "string" && payload.agent.trim()) return { agent: payload.agent.trim() };
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the routing decision for a task:
 * 1. empty registry → supervisor self-executes;
 * 2. LLM picks a known agent → route to it;
 * 3. no match / unknown name / matcher failure → supervisor self-executes.
 */
export async function dispatchTask(
  task: string,
  agents: AgentDefinition[],
  match: AgentMatcher
): Promise<DispatchDecision> {
  if (agents.length === 0) return { mode: "supervisor", reason: "注册表中没有任何 agent" };
  let reply: string;
  try {
    reply = await match(buildMatchPrompt(task, agents));
  } catch (error) {
    return { mode: "supervisor", reason: `匹配调用失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseMatchReply(reply);
  if (!parsed) return { mode: "supervisor", reason: "匹配输出无法解析为合法 JSON" };
  if (parsed.agent === null) return { mode: "supervisor", reason: "没有合适的 agent" };
  const agent = agents.find((candidate) => candidate.name === parsed.agent);
  if (!agent) return { mode: "supervisor", reason: `匹配到的 agent 不存在：${parsed.agent}` };
  return { mode: "agent", agent };
}
