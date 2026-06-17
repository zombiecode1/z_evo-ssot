// ─── Provider Gateway ────────────────────────────────────
// Main routing brain: resolves which provider+model to use,
// handles retry with fallback, auto-selection, and tool call loop.
// 3-tier resolution: explicit model → agent profile → smart auto-select.

import {
  ChatCompletionParams,
  ChatCompletionResponse,
  ChatMessage,
  GatewayConfig,
  ModelSelectionResult,
  ToolCall,
  ILLMProvider,
  ModelInfo,
} from './types';
import { getProviderRegistry, ProviderRegistry } from './provider-registry';
import { getStateDb } from '../services/stateDb';
import { calculateCost, getAllPricing } from './pricing';

// ─── Agent Templates (Fallback) ─────────────────────────

export interface AgentTemplate {
  id: string;
  name: string;
  persona: string;
  preferredProviderId?: string;
  preferredModelId?: string;
  budgetLimit: number;
  autoSelect: boolean;
  allowedProviders: string[];
  allowedModels: string[];
}

const FALLBACK_TEMPLATES: AgentTemplate[] = [
  {
    id: 'chat',
    name: 'Chat Agent',
    persona: 'You are a helpful assistant.',
    preferredModelId: 'llama-3.3-70b-versatile',
    budgetLimit: 100,
    autoSelect: true,
    allowedProviders: ['opencode', 'groq', 'openai', 'gemini'],
    allowedModels: [],
  },
  {
    id: 'code',
    name: 'Code Agent',
    persona: 'You are an expert programmer. Help with coding tasks.',
    preferredModelId: 'qwen/qwen3-32b',
    budgetLimit: 100,
    autoSelect: true,
    allowedProviders: ['opencode', 'groq', 'openai'],
    allowedModels: [],
  },
  {
    id: 'document',
    name: 'Document Agent',
    persona: 'You are a document analysis expert.',
    preferredModelId: 'llama-3.3-70b-versatile',
    budgetLimit: 50,
    autoSelect: true,
    allowedProviders: ['opencode', 'groq', 'openai'],
    allowedModels: [],
  },
  {
    id: 'debug',
    name: 'Debug Agent',
    persona: 'You are a debugging expert. Help find and fix bugs.',
    preferredModelId: 'qwen/qwen3-32b',
    budgetLimit: 100,
    autoSelect: true,
    allowedProviders: ['opencode', 'groq'],
    allowedModels: [],
  },
  {
    id: 'cli',
    name: 'CLI Agent',
    persona: 'You are a system administration expert.',
    preferredModelId: 'llama-3.1-8b-instant',
    budgetLimit: 50,
    autoSelect: true,
    allowedProviders: ['groq'],
    allowedModels: [],
  },
];

// ─── Provider Gateway ────────────────────────────────────

export class ProviderGateway {
  private registry: ProviderRegistry;
  private config: GatewayConfig;
  private activeProviderId: string | null = null;
  private activeModelId: string | null = null;
  private currentSpend = 0;
  private toolCallMaxDepth = 10;

  constructor(config: GatewayConfig = {}) {
    this.config = {
      maxRetries: 3,
      retryDelayMs: 500,
      cacheTtlMs: 5 * 60 * 1000,
      budgetLimit: 100,
      ...config,
    };
    this.registry = getProviderRegistry(this.config.cacheTtlMs);
    this.currentSpend = this.config.currentSpend || 0;
  }

  // ─── Active Provider Management ───────────────────────

  /** Set the active provider and model */
  setActiveProvider(providerId: string, modelId?: string): void {
    this.activeProviderId = providerId;
    if (modelId) this.activeModelId = modelId;
  }

  /** Get currently active provider ID */
  getActiveProviderId(): string | null {
    return this.activeProviderId;
  }

  /** Get currently active model ID */
  getActiveModelId(): string | null {
    return this.activeModelId;
  }

  // ─── Chat Methods ─────────────────────────────────────

  /** Send a chat completion request with full routing + retry */
  async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
    // ─── Identity Anchoring ──────────────────────────────
    // Prepend system identity if not already present
    try {
      const { getIdentity } = require('../services/identityService');
      const identity = getIdentity();
      const sys = identity?.system_identity?.system_prompt;
      if (sys && params.messages?.length) {
        const first = params.messages[0];
        const needsInsert = !(first && first.role === 'system' && String(first.content || '').includes('ZombieCoder'));
        if (needsInsert) {
          params.messages = [{ role: 'system', content: sys } as any, ...params.messages];
        }
      }
    } catch (e) {
      // Don't fail if identity injection has an issue
    }

    let resolved: ModelSelectionResult;
    try {
      resolved = await this.resolveModel(params);
    } catch (err: any) {
      throw new Error(`Model resolution failed: ${err?.message || err}`);
    }

    const resolvedParams = { ...params, model: resolved.modelId };

    let lastError: any = null;
    for (let attempt = 0; attempt <= (this.config.maxRetries || 3); attempt++) {
      try {
        const provider = this.registry.getById(resolved.providerId);
        if (!provider) {
          throw new Error(`Provider not found: ${resolved.providerId}`);
        }

        const response = await provider.chat(resolvedParams);

        // Track cost with real pricing
        this.trackCost(response, resolved.providerId, resolved.modelId);

        return response;
      } catch (err: any) {
        lastError = err;

        // If retryable, try next attempt
        if (this.isRetryableError(err) && attempt < (this.config.maxRetries || 3)) {
          await this.delay(this.config.retryDelayMs || 500);
          // Try fallback model on retry
          try {
            const fallback = await this.getFallbackModel(resolved.providerId, resolved.modelId);
            if (fallback) {
              resolved.modelId = fallback.modelId;
              resolvedParams.model = fallback.modelId;
            }
          } catch {
            // Ignore fallback errors
          }
          continue;
        }

        // If provider-specific error, try another provider
        if (err?.status && err.status >= 500) {
          try {
            const fallback = await this.getFallbackProvider(resolved.providerId, resolved.modelId);
            if (fallback) {
              const fallbackProvider = this.registry.getById(fallback.providerId);
              if (fallbackProvider) {
                resolvedParams.model = fallback.modelId;
                const response = await fallbackProvider.chat(resolvedParams);
                this.trackCost(response, fallback.providerId, fallback.modelId);
                return response;
              }
            }
          } catch {
            // Continue to next retry
          }
        }

        throw err;
      }
    }

    throw lastError;
  }

  /** Send a streaming chat completion request */
  async *chatStream(params: ChatCompletionParams): AsyncGenerator<any, void, unknown> {
    const resolved = await this.resolveModel(params);
    const resolvedParams = { ...params, model: resolved.modelId };

    const provider = this.registry.getById(resolved.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${resolved.providerId}`);
    }

    yield* provider.chatStream(resolvedParams);
  }

  // ─── Model Resolution ─────────────────────────────────

  /** 3-tier resolution: explicit → profile → smart auto-select */
  private async resolveModel(params: ChatCompletionParams): Promise<ModelSelectionResult> {
    // Tier 1: Explicit model specified
    if (params.model && params.model !== 'auto') {
      const providerId = this.findProviderForModel(params.model);
      if (providerId) {
        return {
          providerId,
          modelId: params.model,
          score: 100,
          reason: 'Explicit model specified',
        };
      }
    }

    // Tier 2: Active provider/model set
    if (this.activeProviderId && this.activeModelId) {
      return {
        providerId: this.activeProviderId,
        modelId: this.activeModelId,
        score: 90,
        reason: 'Active provider/model',
      };
    }

    // Tier 3: Smart auto-select
    return this.smartSelect(params);
  }

  /** Smart model selection based on budget, quality, health */
  private async smartSelect(params: ChatCompletionParams): Promise<ModelSelectionResult> {
    const allModels = this.getAllActiveModels();
    if (allModels.length === 0) {
      return {
        providerId: 'opencode',
        modelId: 'deepseek-v4-flash-free',
        score: 0,
        reason: 'No models available, using fallback',
      };
    }

    // Filter by requirements
    const needsTools = (params.tools && params.tools.length > 0);
    const filtered = allModels.filter(m => {
      if (needsTools && !m.supportsTools) return false;
      return true;
    });

    if (filtered.length === 0) {
      return {
        providerId: allModels[0].providerId,
        modelId: allModels[0].modelId,
        score: 0,
        reason: 'No perfect match, using first available',
      };
    }

    // Score each model
    const scored = filtered.map(m => ({
      ...m,
      score: this.scoreModel(m, params),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    return {
      providerId: best.providerId,
      modelId: best.modelId,
      score: best.score,
      reason: `Smart selection (score: ${best.score})`,
    };
  }

  /** Score a model based on multiple factors */
  private scoreModel(
    model: ModelInfo & { providerId: string },
    params: ChatCompletionParams,
  ): number {
    let score = 30; // Base score (lower = less preferred)

    // ═══ FREE MODELS ALWAYS WIN ═════════════════════════
    // Free models get a massive bonus to ensure they're always tried first
    if (model.isFree) score += 50;

    // ═══ CATEGORY SCORING ═══════════════════════════════
    // Fast models preferred for responsive chat
    if (model.category === 'fast') score += 15;
    // Balanced is good default
    if (model.category === 'balanced') score += 10;
    // Powerful only when needed
    if (model.category === 'powerful') score += 5;

    // ═══ CAPABILITY MATCHING ════════════════════════════
    const needsTools = params.tools && params.tools.length > 0;
    if (needsTools && model.supportsTools) score += 10;
    if (needsTools && !model.supportsTools) score -= 20; // Penalize if tools needed but not supported

    // ═══ CONTEXT WINDOW ═════════════════════════════════
    const estTokens = this.estimateTokens(params.messages);
    if (estTokens <= model.contextWindow * 0.5) score += 10; // Comfortable fit
    else if (estTokens <= model.contextWindow * 0.8) score += 5; // Tight fit
    else score -= 15; // Too large, risky

    // ═══ ACTIVE PROVIDER BONUS ══════════════════════════
    if (model.providerId === this.activeProviderId) score += 5;

    return score;
  }

  // ─── Fallback Logic ──────────────────────────────────

  /** Get fallback model from same provider */
  private async getFallbackModel(providerId: string, currentModel: string): Promise<ModelSelectionResult | null> {
    const models = this.getAllActiveModels()
      .filter(m => m.providerId === providerId && m.modelId !== currentModel);

    if (models.length === 0) return null;

    return {
      providerId,
      modelId: models[0].modelId,
      score: 50,
      reason: 'Fallback model from same provider',
    };
  }

  /** Get fallback provider for the same model */
  private async getFallbackProvider(currentProviderId: string, modelId: string): Promise<ModelSelectionResult | null> {
    // Find other providers that have this model
    const otherProviders = this.getAllActiveModels()
      .filter(m => m.modelId === modelId && m.providerId !== currentProviderId);

    if (otherProviders.length > 0) {
      return {
        providerId: otherProviders[0].providerId,
        modelId,
        score: 60,
        reason: `Fallback to provider ${otherProviders[0].providerId}`,
      };
    }

    // Any provider with a similar model
    const anyFallback = this.getAllActiveModels()
      .filter(m => m.providerId !== currentProviderId);

    if (anyFallback.length > 0) {
      return {
        providerId: anyFallback[0].providerId,
        modelId: anyFallback[0].modelId,
        score: 30,
        reason: 'Any available fallback',
      };
    }

    return null;
  }

  // ─── Provider/Model Helpers ──────────────────────────

  private findProviderForModel(modelId: string): string | null {
    const models = this.getAllActiveModels();
    const match = models.find(m => m.modelId === modelId);
    return match?.providerId || null;
  }

  private getAllActiveModels(): Array<ModelInfo & { providerId: string }> {
    const configs = this.registry.loadAllConfigsFromDb();
    const result: Array<ModelInfo & { providerId: string }> = [];

    for (const config of configs) {
      let provider: ILLMProvider | null = null;
      try {
        provider = this.registry.getById(config.id);
      } catch (err: any) {
        // Provider factory not registered or creation failed — skip silently
        continue;
      }
      if (!provider) continue;

      // Get models from DB
      const db = getStateDb();
      if (!db) continue;

      const rows = db.prepare(`
        SELECT * FROM provider_models
        WHERE provider_id = ? AND is_active = 1
      `).all(config.id) as any[];

      for (const row of rows) {
        result.push({
          id: `${config.id}:${row.model_id}`,
          providerId: config.id,
          modelId: row.model_id,
          contextWindow: row.context_window || 0,
          maxOutputTokens: row.max_output_tokens || 0,
          category: row.category || 'other',
          inputPricePer1k: row.input_price_per_1k || 0,
          outputPricePer1k: row.output_price_per_1k || 0,
          isFree: row.is_free === 1,
          supportsTools: row.supports_tools === 1,
          supportsVision: row.supports_vision === 1,
          supportsStreaming: row.supports_streaming === 1,
          isActive: row.is_active === 1,
        });
      }
    }

    return result;
  }

  // ─── Cost Tracking ───────────────────────────────────

  /**
   * Track cost for a completed request using real provider pricing.
   * Attaches cost breakdown to response for transparency.
   */
  private trackCost(response: ChatCompletionResponse, providerId?: string, modelId?: string): void {
    if (!response.usage) return;

    const pid = providerId || response.model?.split('/')[0] || 'unknown';
    const mid = response.model || modelId || 'unknown';

    const costBreakdown = calculateCost(pid, mid, response.usage);

    if (costBreakdown) {
      // Attach cost info to response for caller visibility
      (response as any).cost = {
        inputCost: costBreakdown.inputCost,
        outputCost: costBreakdown.outputCost,
        totalCost: costBreakdown.totalCost,
        isFree: costBreakdown.isFree,
        providerId: pid,
        modelId: mid,
      };
      this.currentSpend += costBreakdown.totalCost;
    } else {
      // Unknown pricing — use rough estimate
      const tokens = response.usage.total_tokens;
      const estimate = tokens * 0.00001;
      (response as any).cost = {
        inputCost: estimate * 0.4,
        outputCost: estimate * 0.6,
        totalCost: estimate,
        isFree: false,
        providerId: pid,
        modelId: mid,
        estimated: true,
      };
      this.currentSpend += estimate;
    }
  }

  /** Check if budget is exceeded */
  isBudgetExceeded(): boolean {
    return (this.config.budgetLimit || Infinity) < this.currentSpend;
  }

  /** Get current spend */
  getCurrentSpend(): number {
    return this.currentSpend;
  }

  /** Get cost summary for admin display */
  getCostSummary(): {
    totalSpend: number;
    budgetLimit: number;
    budgetRemaining: number;
    budgetExceeded: boolean;
    pricingModels: number;
  } {
    return {
      totalSpend: this.currentSpend,
      budgetLimit: this.config.budgetLimit || Infinity,
      budgetRemaining: (this.config.budgetLimit || Infinity) - this.currentSpend,
      budgetExceeded: this.isBudgetExceeded(),
      pricingModels: getAllPricing().length,
    };
  }

  // ─── Utilities ────────────────────────────────────────

  private isRetryableError(err: any): boolean {
    if (!err) return false;
    const status = err?.status;
    // Retry on rate limit, server errors, timeouts
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('und_err')) return true;
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private estimateTokens(messages: ChatCompletionParams['messages']): number {
    let text = '';
    for (const msg of messages) {
      if (typeof msg.content === 'string') text += msg.content;
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') text += part.text;
        }
      }
    }
    return Math.ceil(text.length / 4);
  }

  // ─── Provider Management ─────────────────────────────

  /** Create a new provider from config */
  async createProvider(config: any): Promise<ILLMProvider> {
    return this.registry.get(config);
  }

  /** Test a provider connection */
  async testProvider(providerId: string): Promise<any> {
    const provider = this.registry.getById(providerId);
    if (!provider) {
      return { status: 'error', message: `Provider not found: ${providerId}` };
    }
    return provider.testConnection();
  }

  /** List models for a provider */
  async listRuntimeModels(providerId: string): Promise<any[]> {
    const provider = this.registry.getById(providerId);
    if (!provider) return [];
    return provider.listModels();
  }

  /** Dispose all providers */
  dispose(): void {
    this.registry.dispose();
  }

  // ─── Template Access ─────────────────────────────────

  /** Get agent template by ID */
  getAgentTemplate(templateId: string): AgentTemplate | null {
    return FALLBACK_TEMPLATES.find(t => t.id === templateId) || null;
  }

  /** Get all agent templates */
  getAgentTemplates(): AgentTemplate[] {
    return [...FALLBACK_TEMPLATES];
  }

  /** Get template for agent profile from DB */
  getAgentProfileFromDb(profileId: string): any | null {
    const db = getStateDb();
    if (!db) return null;
    return db.prepare(`SELECT * FROM agent_profiles WHERE id = ?`).get(profileId) || null;
  }
}
