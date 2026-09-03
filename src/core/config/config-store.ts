/** Persisted runtime configuration for a model-backed agent. */
export interface AgentConfigSnapshot {
  /** models.dev provider id, e.g. "anthropic". */
  providerId?: string;
  /** Full "provider/model" specifier, e.g. "anthropic/claude-sonnet-4". */
  model?: string;
  /** Normalized thinking level (one of THINKING_LEVELS). */
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
}

/**
 * Persistence abstraction for agent configuration. The first implementation is
 * JsonFileConfigStore; other backends only need to implement these two calls.
 */
export interface ConfigStore {
  load(): Promise<AgentConfigSnapshot>;
  save(config: AgentConfigSnapshot): Promise<void>;
}
