/** Persisted runtime configuration for a model-backed agent. */
export interface AgentConfigSnapshot {
  /** models.dev provider id, e.g. "anthropic". */
  providerId?: string;
  /** Full "provider/model" specifier, e.g. "anthropic/claude-sonnet-4". */
  model?: string;
  /**
   * Pi thinking level (pi-ai ThinkingLevel). Applied when the model supports
   * it, clamped to the nearest supported level otherwise; without it the
   * model's highest supported level is the default.
   */
  thinkingLevel?: string;
  /**
   * Literal API key overriding the "$ENV_VAR" reference inside providerConfig.
   * Stored in plaintext; users who prefer env vars can omit it.
   */
  apiKey?: string;
  /**
   * Resolved Pi provider config (the toPiProviderConfig payload) kept alongside
   * the ids so the agent can be restored without the models.dev catalog.
   */
  providerConfig?: unknown;
  /**
   * Manually set context-window capacity in tokens (e.g. 200000 for a 1M
   * model): overrides the model's own contextWindow, so Pi's auto-compaction
   * threshold and usage percentages trigger against this value. Undefined =
   * follow the model default.
   */
  contextWindow?: number;
}

/**
 * Persistence abstraction for agent configuration. The first implementation is
 * JsonFileConfigStore; other backends only need to implement these two calls.
 */
export interface ConfigStore {
  load(): Promise<AgentConfigSnapshot>;
  save(config: AgentConfigSnapshot): Promise<void>;
}
