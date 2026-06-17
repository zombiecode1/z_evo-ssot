// ─── Base Provider ────────────────────────────────────────
// Abstract base class for all LLM providers.
// Subclasses only need to implement the core API call logic.
// Common concerns (rate limiting, retry, health) are handled here.

import {
  ChatCompletionParams,
  ChatCompletionResponse,
  ILLMProvider,
  ModelInfo,
  ProviderCapabilities,
  ProviderConfig,
  ProviderHealth,
  StreamChunk,
} from './types';

export abstract class BaseProvider implements ILLMProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly capabilities: ProviderCapabilities;

  protected config: ProviderConfig;
  protected health: ProviderHealth = { status: 'unknown' };
  protected rateCounters: Map<string, { count: number; tokens: number; resetAt: number }> = new Map();

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  // ─── Abstract: Subclasses must implement ────────────────

  /** Make the actual API call to the provider (non-streaming) */
  protected abstract callApi(params: ChatCompletionParams): Promise<any>;

  /** Make the actual API call to the provider (streaming) */
  protected abstract callApiStream(params: ChatCompletionParams): AsyncGenerator<any, void, unknown>;

  /** Fetch models from the provider API */
  protected abstract fetchModelsFromApi(): Promise<any[]>;

  // ─── Core Methods ──────────────────────────────────────

  async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
    await this.checkRateLimit(params);

    const startTime = Date.now();
    try {
      const raw = await this.callApi(params);
      const normalized = this.normalizeResponse(raw, params.model);
      this.recordSuccess(Date.now() - startTime);
      return normalized;
    } catch (err: any) {
      this.recordError(err);
      throw err;
    }
  }

  async *chatStream(params: ChatCompletionParams): AsyncGenerator<StreamChunk, void, unknown> {
    await this.checkRateLimit(params);

    const startTime = Date.now();
    try {
      const rawStream = this.callApiStream(params);
      yield* this.normalizeStream(rawStream, params.model);
      this.recordSuccess(Date.now() - startTime);
    } catch (err: any) {
      this.recordError(err);
      throw err;
    }
  }

  async testConnection(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const apiKey = this.getApiKey();
      if (!apiKey && this.config.apiKeyEnv) {
        this.health = {
          status: 'error',
          errorMessage: `API key not configured (env: ${this.config.apiKeyEnv})`,
          lastChecked: new Date(),
        };
        return this.health;
      }

      // Try listing models as a connection test
      const models = await this.listModels();
      this.health = {
        status: models.length > 0 ? 'healthy' : 'degraded',
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
        errorCount: 0,
      };
    } catch (err: any) {
      this.health = {
        status: 'error',
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
        errorMessage: err?.message || String(err),
        errorCount: (this.health.errorCount || 0) + 1,
      };
    }
    return this.health;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const rawModels = await this.fetchModelsFromApi();
      return rawModels.map((m: any) => this.parseModelInfo(m));
    } catch {
      return [];
    }
  }

  getHealth(): ProviderHealth {
    return this.health;
  }

  dispose(): void {
    this.rateCounters.clear();
  }

  // ─── API Key Resolution ───────────────────────────────

  /** Get API key: DB first, then env variable */
  getApiKey(): string {
    // 1. Direct key from config (DB)
    if (this.config.apiKey) return this.config.apiKey;
    // 2. Env variable
    if (this.config.apiKeyEnv) {
      const key = process.env[this.config.apiKeyEnv];
      if (key && key.trim().length > 0) return key.trim();
    }
    return '';
  }

  /** Get the base URL for API calls */
  getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  // ─── Response Normalization (override in subclass) ─────

  /** Override in subclass to handle provider-specific response format */
  protected normalizeResponse(raw: any, model: string): ChatCompletionResponse {
    // Default: assume OpenAI-compatible format
    return {
      id: raw.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: raw.created || Math.floor(Date.now() / 1000),
      model: raw.model || model,
      choices: (raw.choices || []).map((c: any, i: number) => ({
        index: c.index ?? i,
        message: {
          role: c.message?.role || 'assistant',
          content: c.message?.content ?? null,
          tool_calls: c.message?.tool_calls,
        },
        finish_reason: c.finish_reason || 'stop',
      })),
      usage: raw.usage ? {
        prompt_tokens: raw.usage.prompt_tokens || 0,
        completion_tokens: raw.usage.completion_tokens || 0,
        total_tokens: raw.usage.total_tokens || 0,
      } : undefined,
      system_fingerprint: raw.system_fingerprint,
    };
  }

  /** Override in subclass to handle provider-specific stream format */
  protected async *normalizeStream(rawStream: any, model: string): AsyncGenerator<StreamChunk, void, unknown> {
    // Default: assume OpenAI-compatible SSE format
    if (rawStream && typeof rawStream[Symbol.asyncIterator] === 'function') {
      for await (const chunk of rawStream) {
        if (chunk?.choices) {
          yield {
            id: chunk.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: chunk.created || Math.floor(Date.now() / 1000),
            model: chunk.model || model,
            choices: chunk.choices.map((c: any) => ({
              index: c.index ?? 0,
              delta: c.delta || {},
              finish_reason: c.finish_reason || null,
            })),
            usage: chunk.usage || null,
          };
        }
      }
    }
  }

  /** Override in subclass to parse provider-specific model format */
  protected parseModelInfo(raw: any): ModelInfo {
    return {
      id: raw.id,
      providerId: this.id,
      modelId: raw.id,
      contextWindow: raw.context_window ?? 0,
      maxOutputTokens: raw.max_tokens ?? 0,
      category: raw.category || 'other',
      inputPricePer1k: raw.input_price_per_1k || 0,
      outputPricePer1k: raw.output_price_per_1k || 0,
      isFree: raw.is_free || false,
      supportsTools: raw.supports_tools || false,
      supportsVision: raw.supports_vision || false,
      supportsStreaming: raw.supports_streaming ?? true,
      isActive: raw.is_active !== false,
    };
  }

  // ─── Rate Limiting ────────────────────────────────────

  protected async checkRateLimit(params: ChatCompletionParams): Promise<void> {
    if (!this.config.rateLimitRpm && !this.config.rateLimitTpm) return;

    const now = Date.now();
    const key = this.id;
    let counter = this.rateCounters.get(key);

    if (!counter || now > counter.resetAt) {
      counter = { count: 0, tokens: 0, resetAt: now + 60000 };
      this.rateCounters.set(key, counter);
    }

    if (this.config.rateLimitRpm && counter.count >= this.config.rateLimitRpm) {
      const err: any = new Error(`Rate limit exceeded for ${this.name}: ${this.config.rateLimitRpm} RPM`);
      err.status = 429;
      throw err;
    }

    // Estimate tokens for TPM check
    const estTokens = this.estimateTokens(params.messages);
    if (this.config.rateLimitTpm && counter.tokens + estTokens > this.config.rateLimitTpm) {
      const err: any = new Error(`Token rate limit exceeded for ${this.name}: ${this.config.rateLimitTpm} TPM`);
      err.status = 429;
      throw err;
    }

    counter.count++;
    counter.tokens += estTokens;
  }

  protected estimateTokens(messages: ChatCompletionParams['messages']): number {
    let text = '';
    for (const msg of messages) {
      if (typeof msg.content === 'string') text += msg.content;
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') text += part.text;
        }
      }
    }
    // ~4 chars per token (conservative)
    return Math.ceil(text.length / 4);
  }

  // ─── Health Tracking ──────────────────────────────────

  protected recordSuccess(latencyMs: number): void {
    this.health = {
      status: 'healthy',
      latencyMs,
      lastChecked: new Date(),
      errorCount: 0,
    };
  }

  protected recordError(err: any): void {
    const isRateLimit = err?.status === 429;
    this.health = {
      status: isRateLimit ? 'degraded' : 'error',
      lastChecked: new Date(),
      errorMessage: err?.message || String(err),
      errorCount: (this.health.errorCount || 0) + 1,
    };
  }

  // ─── Utilities ────────────────────────────────────────

  /** Build request headers for fetch calls */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const apiKey = this.getApiKey();
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
  }

  /** Build the full URL for an API endpoint */
  protected buildUrl(path: string): string {
    const base = this.getBaseUrl();
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
