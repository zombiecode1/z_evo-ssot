/**
 * AgentModelConfig — Agent-to-model mapping via environment variables
 *
 * Each agent type (architect, engineer, qa, docs, ops) can have its own
 * preferred model and fallback model, configured entirely through .env
 * variables. No code changes needed to switch models.
 *
 * Environment variable format:
 *   ZOMBIE_AGENT_<TYPE>_MODEL=primary-model-id
 *   ZOMBIE_AGENT_<TYPE>_FALLBACK=fallback-model-id
 *
 * Example:
 *   ZOMBIE_AGENT_ARCHITECT_MODEL=nemotron-3-ultra-free
 *   ZOMBIE_AGENT_ENGINEER_FALLBACK=deepseek-v4-flash-free
 */

// ─── Agent Type Registry ──────────────────────────────────────

export type AgentType =
  | 'general'
  | 'architect'
  | 'engineer'
  | 'qa'
  | 'docs'
  | 'ops';

const AGENT_TYPES: AgentType[] = ['general', 'architect', 'engineer', 'qa', 'docs', 'ops'];

// ─── Model Defaults ───────────────────────────────────────────
// Fallback values when .env variables are not set.

const MODEL_DEFAULTS: Record<AgentType, { model: string; fallback: string }> = {
  general:   { model: 'mimo-v2.5-free',           fallback: 'deepseek-v4-flash-free' },
  architect: { model: 'nemotron-3-ultra-free',     fallback: 'big-pickle' },
  engineer:  { model: 'deepseek-v4-flash-free',    fallback: 'mimo-v2.5-free' },
  qa:        { model: 'big-pickle',                fallback: 'nemotron-3-ultra-free' },
  docs:      { model: 'mimo-v2.5-free',            fallback: 'deepseek-v4-flash-free' },
  ops:       { model: 'nemotron-3-ultra-free',      fallback: 'big-pickle' },
};

// ─── Core Config Class ────────────────────────────────────────

export class AgentModelConfig {

  /**
   * Get the model configuration for a specific agent type.
   *
   * @param agentType - The agent category (e.g. 'architect', 'engineer')
   * @returns { model, fallback } where model is primary and fallback is secondary
   */
  static get(agentType: AgentType): { model: string; fallback: string } {
    const upper = agentType.toUpperCase();
    const envModel = process.env[`ZOMBIE_AGENT_${upper}_MODEL`];
    const envFallback = process.env[`ZOMBIE_AGENT_${upper}_FALLBACK`];

    const defaults = MODEL_DEFAULTS[agentType] || MODEL_DEFAULTS.general;

    return {
      model: (envModel && envModel.trim()) || defaults.model,
      fallback: (envFallback && envFallback.trim()) || defaults.fallback,
    };
  }

  /**
   * Get the primary model for an agent type.
   * Resolves: env var → default.
   */
  static getModel(agentType: AgentType): string {
    return AgentModelConfig.get(agentType).model;
  }

  /**
   * Get the fallback model for an agent type.
   * Resolves: env var → default.
   */
  static getFallback(agentType: AgentType): string {
    return AgentModelConfig.get(agentType).fallback;
  }

  /**
   * Get configurations for all agent types.
   * Useful for dashboard / status display.
   */
  static getAll(): Record<AgentType, { model: string; fallback: string }> {
    const result = {} as Record<AgentType, { model: string; fallback: string }>;
    for (const type of AGENT_TYPES) {
      result[type] = AgentModelConfig.get(type);
    }
    return result;
  }

  /**
   * List all supported agent types.
   */
  static getAgentTypes(): AgentType[] {
    return [...AGENT_TYPES];
  }

  /**
   * Validate that a string is a known agent type.
   */
  static isAgentType(value: string): value is AgentType {
    return AGENT_TYPES.includes(value as AgentType);
  }

  /**
   * Get the Proxi Bridge URL from env.
   * Defaults to localhost:9999 if not configured.
   */
  static getBridgeUrl(): string {
    return process.env.PROXI_BRIDGE_URL || 'http://localhost:9999/v1';
  }

  /**
   * Get the Proxi Bridge API key from env.
   */
  static getBridgeKey(): string {
    return process.env.PROXI_BRIDGE_KEY || 'local-proxi';
  }
}
