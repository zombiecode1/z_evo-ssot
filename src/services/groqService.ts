import Groq from 'groq-sdk';
import { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import { LogEntry, ModelMeta, RateLimitState, ServerStatus } from '../types';
import { writeLog, cleanupOldLogs } from './fileLogger';
import { getStateDb, upsertModels } from './stateDb';
import {
  getActiveModels,
  getConfiguredSources,
  getSourceApiKey,
  getSourceForModel,
  requestOpenAiCompatible,
  syncModelCatalog,
} from './providerCatalog';

const MODEL_META: Record<string, { context_window: number; max_tokens: number; category: ModelMeta['category'] }> = {
  // Production models — context_window values from Groq official docs (https://console.groq.com/docs/models)
  // All production models have 131,072 context window as of 2026-05
  'openai/gpt-oss-20b': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'openai/gpt-oss-120b': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'openai/gpt-oss-safeguard-20b': { context_window: 131072, max_tokens: 65536, category: 'guard' },
  'groq/compound-mini': { context_window: 131072, max_tokens: 8192, category: 'fast' },
  'groq/compound': { context_window: 131072, max_tokens: 8192, category: 'balanced' },
  'qwen/qwen3-32b': { context_window: 131072, max_tokens: 40960, category: 'balanced' },
  'llama-3.1-8b-instant': { context_window: 131072, max_tokens: 131072, category: 'fast' },
  'llama-3.3-70b-versatile': { context_window: 131072, max_tokens: 32768, category: 'balanced' },
  'meta-llama/llama-4-scout-17b-16e-instruct': { context_window: 131072, max_tokens: 8192, category: 'balanced' },
  'meta-llama/llama-prompt-guard-2-86m': { context_window: 512, max_tokens: 512, category: 'guard' },
  'meta-llama/llama-prompt-guard-2-22m': { context_window: 512, max_tokens: 512, category: 'guard' },
  'allam-2-7b': { context_window: 8192, max_tokens: 8192, category: 'fast' },
  'whisper-large-v3': { context_window: 0, max_tokens: 0, category: 'audio' },
  'whisper-large-v3-turbo': { context_window: 0, max_tokens: 0, category: 'audio' },

  // Text-to-speech preview models — Groq lists these under chat models endpoint
  // but they only accept TTS-style requests and require per-org terms acceptance.
  // Mark as 'audio' so the existing non-chat re-routing logic in createChatCompletion
  // automatically falls back to a working chat model.
  'canopylabs/orpheus-arabic-saudi': { context_window: 0, max_tokens: 0, category: 'audio' },
  'canopylabs/orpheus-v1-english': { context_window: 0, max_tokens: 0, category: 'audio' },

  // Preview models
  'llama3-8b-8192': { context_window: 8192, max_tokens: 8192, category: 'fast' },
  'llama-3.2-1b-preview': { context_window: 8192, max_tokens: 8192, category: 'fast' },
  'llama-3.2-3b-preview': { context_window: 8192, max_tokens: 8192, category: 'fast' },
  'gemma-7b-it': { context_window: 8192, max_tokens: 8192, category: 'fast' },
  'gemma2-9b-it': { context_window: 8192, max_tokens: 8192, category: 'fast' },
  'llama3-70b-8192': { context_window: 8192, max_tokens: 8192, category: 'balanced' },
  'llama-3.1-70b-versatile': { context_window: 8192, max_tokens: 8192, category: 'balanced' },
  'mixtral-8x7b-32768': { context_window: 32768, max_tokens: 32768, category: 'balanced' },
  'llama-3.2-11b-vision-preview': { context_window: 8192, max_tokens: 8192, category: 'vision' },
  'llama-3.2-90b-vision-preview': { context_window: 8192, max_tokens: 8192, category: 'vision' },
  'llama-guard-3-8b': { context_window: 8192, max_tokens: 8192, category: 'guard' },
  'nomic-embed-text-v1_5': { context_window: 0, max_tokens: 0, category: 'embedding' },

  // OpenCode Zen models — free and paid, proxied via opencode.ai
  'big-pickle': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'deepseek-v4-flash-free': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'mimo-v2.5-free': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'nemotron-3-ultra-free': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'deepseek-v4-flash': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'kimi-k2.5': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'kimi-k2.6': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'qwen3.7-plus': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'qwen3.7-max': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'minimax-m2.7': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'claude-sonnet-4-6': { context_window: 200000, max_tokens: 65536, category: 'balanced' },
  'claude-haiku-4-5': { context_window: 200000, max_tokens: 65536, category: 'fast' },
  'gpt-5.1-codex': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'gpt-5.3-codex': { context_window: 131072, max_tokens: 65536, category: 'balanced' },
  'gemini-3.5-flash': { context_window: 131072, max_tokens: 65536, category: 'fast' },
};

const ACCOUNT_RATE_LIMITS: Record<string, { rpm: number; tpm: number }> = {
  // Developer plan rates from Groq official docs (https://console.groq.com/docs/rate-limits)
  // Override with GROQ_MODEL_LIMIT_OVERRIDES env var if your org differs
  'openai/gpt-oss-20b': { rpm: 30, tpm: 6000 },
  'openai/gpt-oss-120b': { rpm: 30, tpm: 6000 },
  'openai/gpt-oss-safeguard-20b': { rpm: 30, tpm: 6000 },
  'groq/compound-mini': { rpm: 200, tpm: 6000 },
  'groq/compound': { rpm: 200, tpm: 6000 },
  'qwen/qwen3-32b': { rpm: 60, tpm: 6000 },
  'llama-3.1-8b-instant': { rpm: 30, tpm: 6000 },
  'llama-3.3-70b-versatile': { rpm: 30, tpm: 6000 },
  'meta-llama/llama-4-scout-17b-16e-instruct': { rpm: 30, tpm: 6000 },
  'meta-llama/llama-prompt-guard-2-86m': { rpm: 100, tpm: 30000 },
  'meta-llama/llama-prompt-guard-2-22m': { rpm: 100, tpm: 30000 },
  'allam-2-7b': { rpm: 30, tpm: 6000 },
  'whisper-large-v3': { rpm: 300, tpm: 0 },
  'whisper-large-v3-turbo': { rpm: 400, tpm: 0 },

  'llama3-8b-8192': { rpm: 30, tpm: 30000 },
  'llama-3.2-1b-preview': { rpm: 30, tpm: 30000 },
  'llama-3.2-3b-preview': { rpm: 30, tpm: 30000 },
  'gemma-7b-it': { rpm: 30, tpm: 15000 },
  'gemma2-9b-it': { rpm: 30, tpm: 15000 },
  'llama3-70b-8192': { rpm: 30, tpm: 6000 },
  'llama-3.1-70b-versatile': { rpm: 30, tpm: 6000 },
  'mixtral-8x7b-32768': { rpm: 30, tpm: 5000 },
  'llama-3.2-11b-vision-preview': { rpm: 30, tpm: 7000 },
  'llama-3.2-90b-vision-preview': { rpm: 30, tpm: 7000 },
  'llama-guard-3-8b': { rpm: 30, tpm: 15000 },
  'nomic-embed-text-v1_5': { rpm: 30, tpm: 50000 },
  'default': { rpm: 30, tpm: 10000 },
};

const RATE_LIMIT_OVERRIDES = parseLimitOverrides(process.env.GROQ_MODEL_LIMIT_OVERRIDES);
const DEFAULT_CHAT_MAX_TOKENS = readPositiveInt(process.env.DEFAULT_CHAT_MAX_TOKENS, 512);

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLimitOverrides(value: string | undefined): Record<string, { rpm?: number; tpm?: number }> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, { rpm?: number; tpm?: number }>;
  } catch (err) {
    console.warn('Invalid GROQ_MODEL_LIMIT_OVERRIDES JSON; using built-in rate limits.');
    return {};
  }
}

export class GroqService {
  private client: Groq;
  private models: ModelMeta[] = [];
  private logs: LogEntry[] = [];
  private rateCounters: Map<string, { count: number; tokens: number; resetAt: number }> = new Map();
  private termsLockedModels: Set<string> = new Set();
  private disabledSources: Set<string> = new Set();
  private totalRequests = 0;
  private startedAt = Date.now();
  private _autoSelect = true;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(apiKey: string) {
    this.client = new Groq({ apiKey });
    
    // Cleanup rate counters every 5 minutes to prevent memory leak
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.rateCounters.entries()) {
        if (value.resetAt < now) {
          this.rateCounters.delete(key);
        }
      }
      // Also trim logs to prevent unbounded growth
      if (this.logs.length > 500) {
        this.logs = this.logs.slice(-250);
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Clean up resources when service is destroyed
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  get autoSelect(): boolean { return this._autoSelect; }
  set autoSelect(v: boolean) { this._autoSelect = v; }
  get startedAtMs(): number { return this.startedAt; }

  async initialize(): Promise<void> {
    try {
      const sync = await syncModelCatalog({ purge: true });
      this.models = getActiveModels().map((m: any) => ({
        id: m.model_id || m.id,
        object: 'model' as const,
        created: m.created || Math.floor(Date.now() / 1000),
        owned_by: m.owned_by || m.provider || 'unknown',
        context_window: m.context_window ?? 0,
        max_tokens: m.max_tokens ?? 0,
        category: m.category || 'other',
        provider: m.provider,
        source_name: m.source_name,
        source_kind: m.source_kind,
        base_url: m.base_url,
        api_key_env: m.api_key_env,
        source_model_id: m.source_model_id,
        status: m.status || 'active',
        is_active: m.is_active !== 0,
        is_free: !!m.is_free,
      })) as ModelMeta[];
      console.log(`✅ Synced ${sync.total} models from ${sync.sources.length} sources`);
      if (sync.errors.length > 0) {
        console.warn(`⚠️ Some sources failed during sync: ${sync.errors.map(e => e.source).join(', ')}`);
      }
      if (this.models.length === 0) {
        this.models = this.buildFallbackModels();
        const db = getStateDb();
        if (db) {
          upsertModels(db, this.models as any);
        }
        console.log('📋 Using built-in model list as fallback');
      }
    } catch (err) {
      console.error('❌ Failed to sync model catalog:', err);
      console.log('📋 Falling back to built-in model list');
      this.models = this.buildFallbackModels();
      const db = getStateDb();
      if (db) {
        upsertModels(db, this.models as any);
      }
    }

    if (this.models.length === 0) {
      const zenModelIds = [
        'big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free', 'nemotron-3-ultra-free',
        'deepseek-v4-flash', 'kimi-k2.5', 'kimi-k2.6', 'qwen3.7-plus', 'qwen3.7-max',
        'minimax-m2.7', 'claude-sonnet-4-6', 'claude-haiku-4-5',
        'gpt-5.1-codex', 'gpt-5.3-codex', 'gemini-3.5-flash',
      ];
      const existingIds = new Set(this.models.map(m => m.id))
      for (const id of zenModelIds) {
        if (!existingIds.has(id)) {
          const meta = MODEL_META[id]
          this.models.push({
            id,
            object: 'model' as const,
            created: Math.floor(Date.now() / 1000),
            owned_by: 'opencode',
            ...meta,
          } as ModelMeta)
        }
      }
      const zenCount = zenModelIds.filter(id => !existingIds.has(id)).length
      if (zenCount > 0) console.log(`➕ Added ${zenCount} OpenCode Zen models`)
    }
  }

  private isRetryableError(err: any): boolean {
    try {
      const code = err?.code || err?.cause?.code || '';
      if (typeof code === 'string' && code.includes('UND_ERR')) return true;
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('body timeout') || msg.includes('terminated')) return true;
      return false;
    } catch { return false; }
  }

  private async retryRequest<T>(fn: () => Promise<T>, attempts = 1, delayMs = 500): Promise<T> {
    let lastErr: any = null;
    for (let i = 0; i <= attempts; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        if (i < attempts && this.isRetryableError(err)) {
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private categorisedModels(category: ModelMeta['category']): string[] {
    return this.models
      .filter(m => m.category === category && (m as any).is_active !== false && String((m as any).status || 'active') !== 'disabled' && !this.isSourceDisabled((m as any).source_name))
      .map(m => m.id);
  }

  selectBestModel(inputText: string): string {
    const len = inputText.length;
    let candidates: string[];

    if (len < 100) {
      candidates = this.categorisedModels('fast');
    } else if (len < 500) {
      candidates = this.categorisedModels('balanced');
    } else {
      const powerful = this.categorisedModels('balanced');
      const vision = this.categorisedModels('vision');
      candidates = [...powerful, ...vision];
    }

    return candidates[0] || 'deepseek-v4-flash-free';
  }

  private extractInputText(messages: ChatCompletionMessageParam[]): string {
    return messages.map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map(c => {
          if (c.type === 'text') return c.text;
          if (c.type === 'image_url') return '[image]';
          return '';
        }).join(' ');
      }
      return '';
    }).join('\n');
  }

  private isTermsLocked(model: string): boolean {
    if (!model) return false;
    return this.termsLockedModels.has(model);
  }

  private isSourceDisabled(sourceName?: string | null): boolean {
    if (!sourceName) return false;
    return this.disabledSources.has(String(sourceName));
  }

  private isNonChatModel(model: string): boolean {
    if (!model) return false;
    const meta = this.models.find(m => m.id === model);
    if (!meta) return false;
    return ['guard', 'audio', 'embedding'].includes(meta.category);
  }

  private isZenModel(model: string): boolean {
    const zenModels = new Set([
      'big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free', 'nemotron-3-ultra-free',
      'deepseek-v4-flash', 'kimi-k2.5', 'kimi-k2.6', 'qwen3.7-plus', 'qwen3.7-max',
      'minimax-m2.7', 'claude-sonnet-4-6', 'claude-haiku-4-5',
      'gpt-5.1-codex', 'gpt-5.3-codex', 'gemini-3.5-flash',
    ]);
    return zenModels.has(model);
  }

  private async sendToZen(model: string, params: any): Promise<any> {
    const apiKey = process.env.OPENCODE_API_KEY || ''
    if (!apiKey) throw new Error('OPENCODE_API_KEY not set. Set it in .env or export OPENCODE_API_KEY=oc_...')

    const baseURL = 'https://opencode.ai/zen/v1'
    const isStream = params.stream === true
    const url = `${baseURL}/chat/completions`

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: params.messages,
        max_tokens: params.max_tokens ?? undefined,
        temperature: params.temperature ?? 0.7,
        stream: isStream,
      }),
    })

    if (!resp.ok) {
      const body = await resp.text()
      const err = new Error(`[opencode-zen] ${resp.status}: ${body}`) as any
      err.status = resp.status
      throw err
    }

    if (isStream) {
      const reader = resp.body?.getReader()
      if (!reader) throw new Error('No response body from Zen')

      const decoder = new TextDecoder()
      return (async function* () {
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const t = line.trim()
            if (!t || !t.startsWith('data: ')) continue
            const data = t.slice(6)
            if (data === '[DONE]') return
            try { yield JSON.parse(data) } catch { /* skip */ }
          }
        }
      })()
    }

    return resp.json()
  }

  private markTermsLocked(model: string): void {
    if (!model) return;
    if (this.termsLockedModels.has(model)) return;
    this.termsLockedModels.add(model);
    // Drop the model from the active list so subsequent auto-routing skips it.
    this.models = this.models.filter(m => m.id !== model);
    console.warn(`⚠️ Model '${model}' is locked (terms acceptance required). Removed from routing.`);
  }

  private pickChatFallback(currentModel: string): string {
    // Prefer a balanced chat model that isn't terms-locked and isn't the current model.
    const candidates = this.models
      .filter(m => m.id !== currentModel && !this.isTermsLocked(m.id) && (m as any).is_active !== false && !this.isSourceDisabled((m as any).source_name))
      .sort((a, b) => {
        const aCat = a.category === 'balanced' ? 0 : a.category === 'fast' ? 1 : 2;
        const bCat = b.category === 'balanced' ? 0 : b.category === 'fast' ? 1 : 2;
        if (aCat !== bCat) return aCat - bCat;
        return b.context_window - a.context_window;
      });
    return candidates[0]?.id || 'deepseek-v4-flash-free';
  }

  private isProviderCreditsError(status: number | undefined, body: string, err?: any): boolean {
    const msg = String(err?.message || body || '').toLowerCase();
    return (
      status === 401 ||
      status === 402 ||
      status === 403 ||
      msg.includes('creditserror') ||
      msg.includes('no payment method') ||
      msg.includes('add a payment method') ||
      msg.includes('billing') ||
      msg.includes('insufficient credits') ||
      msg.includes('payment method') ||
      msg.includes('model_terms_required') ||
      msg.includes('requires terms acceptance')
    );
  }

  private getRateLimit(model: string): { rpm: number; tpm: number } {
    const base = ACCOUNT_RATE_LIMITS[model] || ACCOUNT_RATE_LIMITS['default'];
    const override = RATE_LIMIT_OVERRIDES[model];
    return {
      rpm: override?.rpm ?? base.rpm,
      tpm: override?.tpm ?? base.tpm,
    };
  }

  private async checkAndUpdateRateLimit(model: string, tokens: number = 0): Promise<void> {
    const now = Date.now();
    const key = model || 'default';
    let counter = this.rateCounters.get(key);

    if (!counter || now > counter.resetAt) {
      counter = { count: 0, tokens: 0, resetAt: now + 60000 };
      this.rateCounters.set(key, counter);
    }

    const limits = this.getRateLimit(model);

    if (counter.count >= limits.rpm) {
      const err: any = new Error(`Rate limit exceeded for ${model}: ${limits.rpm} RPM`);
      err.status = 429;
      err.type = 'rate_limit_error';
      err.code = 'rate_limit_exceeded';
      throw err;
    }

    if (limits.tpm > 0 && counter.tokens + tokens > limits.tpm) {
      const err: any = new Error(`Token rate limit exceeded for ${model}: ${limits.tpm} TPM`);
      err.status = 429;
      err.type = 'rate_limit_error';
      err.code = 'token_rate_limit_exceeded';
      throw err;
    }

    counter.count++;
    counter.tokens += tokens;
  }

  async createChatCompletion(
    params: ChatCompletionCreateParams
  ): Promise<any> {
    const effectiveParams = { ...params };

    // If the client doesn't specify a max output token budget, default conservatively.
    // This avoids "Requested ... TPM" failures on models with strict per-request token budgets.
    const maxCompletion = (effectiveParams as any).max_completion_tokens;
    if (effectiveParams.max_tokens == null && maxCompletion == null) {
      effectiveParams.max_tokens = DEFAULT_CHAT_MAX_TOKENS;
    }

    if (!effectiveParams.model || effectiveParams.model === 'auto') {
      if (this._autoSelect) {
        const inputText = this.extractInputText(effectiveParams.messages);
        effectiveParams.model = this.selectBestModel(inputText);
      } else {
        const balanced = this.categorisedModels('balanced');
        effectiveParams.model = balanced[0] || 'deepseek-v4-flash-free';
      }
    }

    // Route away from models that have already been marked as terms-locked
    // (i.e. require org admin to accept terms at console.groq.com) and from
    // TTS-only models that were mistakenly sent to /v1/chat/completions.
    if (this.isTermsLocked(effectiveParams.model) || this.isNonChatModel(effectiveParams.model)) {
      const fallback = this.pickChatFallback(effectiveParams.model);
      console.warn(`⚠️ Model '${effectiveParams.model}' is not usable for chat. Routing to '${fallback}'.`);
      effectiveParams.model = fallback;
    }

    const inputTokens = this.estimateTokens(
      this.extractInputText(effectiveParams.messages)
    );
    const requestedOutputTokens = Number((effectiveParams as any).max_completion_tokens ?? effectiveParams.max_tokens ?? 0) || 0;
    const requestedTokens = inputTokens + requestedOutputTokens;

    // Pre-emptively route away from models with TPM limits too low for the request
    const currentLimits = this.getRateLimit(effectiveParams.model);
    if (currentLimits && currentLimits.tpm > 0 && requestedTokens > currentLimits.tpm) {
      // Find a model with higher TPM limit that can handle this request
      const betterModel = Object.entries(ACCOUNT_RATE_LIMITS)
        .filter(([id]) => {
          const cat = MODEL_META[id]?.category;
          const effectiveLimit = this.getRateLimit(id);
          return id !== 'default' &&
            effectiveLimit.tpm > currentLimits.tpm &&
            (cat === 'balanced' || cat === 'fast');
        })
        .sort(([aId], [bId]) => this.getRateLimit(bId).tpm - this.getRateLimit(aId).tpm)
        .find(([id]) => this.models.some(m => m.id === id));
      if (betterModel) {
        const betterLimit = this.getRateLimit(betterModel[0]);
        console.warn(`⚠️ Request (${requestedTokens}t) exceeds '${effectiveParams.model}' TPM limit (${currentLimits.tpm}). Routing to '${betterModel[0]}' (${betterLimit.tpm} TPM).`);
        effectiveParams.model = betterModel[0];
      }
    }

    // Auto-route non-chat models (guard, audio, embedding) to a suitable chat model
    let resolvedModel = this.models.find(m => m.id === effectiveParams.model);
    const nonChatCategories = ['guard', 'audio', 'embedding'];
    if (resolvedModel && nonChatCategories.includes(resolvedModel.category)) {
      const fallback = this.selectBestModel(this.extractInputText(effectiveParams.messages));
      console.warn(`⚠️ Model '${effectiveParams.model}' (${resolvedModel.category}) is not a chat model. Routing to '${fallback}'`);
      effectiveParams.model = fallback;
      resolvedModel = this.models.find(m => m.id === fallback) || resolvedModel;
    }

    // Auto-admit context window overflow instead of throwing
    if (resolvedModel && resolvedModel.context_window > 0) {
      const maxOutput = (effectiveParams.max_tokens || resolvedModel.max_tokens) as number;
      if (inputTokens + maxOutput > resolvedModel.context_window) {
        // Try switching to any model with larger context window (TPM-aware preferred, but not required)
        const candidates = this.models
          .filter(m => m.id !== effectiveParams.model && m.context_window > 0 && m.max_tokens > 0)
          .sort((a, b) => {
            const aFitsInput = inputTokens <= a.context_window;
            const bFitsInput = inputTokens <= b.context_window;
            if (aFitsInput !== bFitsInput) return bFitsInput ? 1 : -1;
            // Among those that fit, prefer higher TPM availability
            const aTpmOk = this.getRateLimit(a.id).tpm === 0 || inputTokens + Math.min(maxOutput, a.max_tokens) <= this.getRateLimit(a.id).tpm;
            const bTpmOk = this.getRateLimit(b.id).tpm === 0 || inputTokens + Math.min(maxOutput, b.max_tokens) <= this.getRateLimit(b.id).tpm;
            if (aTpmOk !== bTpmOk) return aTpmOk ? -1 : 1;
            return b.context_window - a.context_window;
          });

        // Must have enough TPM to handle at least the input tokens
        const bestFit = candidates.find(m => {
          if (inputTokens > m.context_window) return false;
          const tpm = this.getRateLimit(m.id).tpm;
          return tpm === 0 || inputTokens <= tpm;
        });
        const anyLarger = candidates.find(m => m.context_window > resolvedModel!.context_window);

        if (bestFit) {
          console.warn(`⚠️ Context exceeded for '${effectiveParams.model}'. Switching to '${bestFit.id}' (context: ${bestFit.context_window}, TPM: ${this.getRateLimit(bestFit.id).tpm}).`);
          effectiveParams.model = bestFit.id;
          resolvedModel = bestFit;
        } else if (inputTokens < resolvedModel.context_window) {
          // Input fits, but not with requested max_tokens — reduce max_tokens
          const available = resolvedModel.context_window - inputTokens;
          const adjusted = Math.max(1, Math.min(available, maxOutput, resolvedModel.max_tokens));
          console.warn(`⚠️ Reducing max_tokens from ${maxOutput} to ${adjusted} for '${effectiveParams.model}'.`);
          effectiveParams.max_tokens = adjusted;
        } else {
          // Input alone exceeds context — try any larger context model with sufficient TPM, else cap and send
          const anyLargerWithTpm = candidates.find(m => {
            if (m.context_window <= resolvedModel!.context_window) return false;
            const tpm = this.getRateLimit(m.id).tpm;
            return tpm === 0 || inputTokens <= tpm;
          });
          if (anyLargerWithTpm) {
            console.warn(`⚠️ Input (${inputTokens}t) exceeds '${effectiveParams.model}' context. Switching to '${anyLargerWithTpm.id}' (${anyLargerWithTpm.context_window} context).`);
            effectiveParams.model = anyLargerWithTpm.id;
            resolvedModel = anyLargerWithTpm;
          } else if (anyLarger) {
            // Only switch if the larger model's TPM can handle at least the input alone
            const largerTpm = this.getRateLimit(anyLarger.id).tpm;
            if (largerTpm === 0 || inputTokens <= largerTpm) {
              console.warn(`⚠️ Input (${inputTokens}t) exceeds '${effectiveParams.model}' context. Switching to '${anyLarger.id}' (context: ${anyLarger.context_window}).`);
              effectiveParams.model = anyLarger.id;
              resolvedModel = anyLarger;
            } else {
              const safeMax = Math.min(maxOutput, resolvedModel.max_tokens);
              console.warn(`⚠️ Input (${inputTokens}t) exceeds '${effectiveParams.model}' context (${resolvedModel.context_window}). No larger model with sufficient TPM. Capping max_tokens to ${safeMax}.`);
              effectiveParams.max_tokens = safeMax;
            }
          } else {
            const safeMax = Math.min(maxOutput, resolvedModel.max_tokens);
            console.warn(`⚠️ Input (${inputTokens}t) exceeds all available contexts. Sending with max_tokens=${safeMax}.`);
            effectiveParams.max_tokens = safeMax;
          }
        }
      } else {
        // Input + max_output fits context, but ensure max_tokens ≤ model limit
        if (maxOutput > resolvedModel.max_tokens) {
          console.warn(`⚠️ Capping max_tokens from ${maxOutput} to ${resolvedModel.max_tokens} for '${effectiveParams.model}'.`);
          effectiveParams.max_tokens = resolvedModel.max_tokens;
        }
      }
    } else if (resolvedModel && resolvedModel.max_tokens > 0) {
      // No context window info, but cap max_tokens to model limit
      const currentMax = (effectiveParams as any).max_completion_tokens ?? effectiveParams.max_tokens ?? 0;
      if (currentMax > resolvedModel.max_tokens) {
        console.warn(`⚠️ Capping max_tokens from ${currentMax} to ${resolvedModel.max_tokens} for '${effectiveParams.model}'.`);
        effectiveParams.max_tokens = resolvedModel.max_tokens;
        delete (effectiveParams as any).max_completion_tokens;
      }
    }

    // Re-check TPM after any model routing changes; reduce max_tokens if needed to stay within limit
    if (resolvedModel) {
      const tpmLimit = this.getRateLimit(effectiveParams.model).tpm;
      const currentMaxOut = effectiveParams.max_tokens || resolvedModel.max_tokens || 0;
      if (tpmLimit > 0 && inputTokens + currentMaxOut > tpmLimit) {
        const safeMax = Math.max(1, tpmLimit - inputTokens - 100);
        const adjusted = Math.min(currentMaxOut, safeMax, resolvedModel.max_tokens || currentMaxOut);
        if (adjusted < currentMaxOut) {
          console.warn(`⚠️ Reducing max_tokens from ${currentMaxOut} to ${adjusted} to stay within '${effectiveParams.model}' TPM limit (${tpmLimit}).`);
          effectiveParams.max_tokens = adjusted;
        }
      }
    }

    // Rate limit check after all routing/reduction adjustments
    const adjustedOutputTokens = Number((effectiveParams as any).max_completion_tokens ?? effectiveParams.max_tokens ?? 0) || 0;
    await this.checkAndUpdateRateLimit(effectiveParams.model, inputTokens + adjustedOutputTokens);

    const isStream = effectiveParams.stream === true;
    console.log(`🔍 SENDING: model=${effectiveParams.model}, max_tokens=${effectiveParams.max_tokens}, inputTokens=${inputTokens}, stream=${isStream}`);

    let result: any;
    let lastErr: any = null;
    let attemptModel = String(effectiveParams.model);
    for (let attempt = 0; attempt < 4; attempt++) {
      effectiveParams.model = attemptModel;
      const source = getSourceForModel(attemptModel) || getConfiguredSources().find((s) => s.enabled && !this.isSourceDisabled(s.name)) || null;
      if (!source) {
        const err: any = new Error(`No provider source configured for model ${attemptModel}`);
        err.status = 404;
        throw err;
      }

      try {
        const response = await requestOpenAiCompatible({
          baseUrl: source.baseUrl,
          apiKey: getSourceApiKey(source),
          path: '/chat/completions',
          body: effectiveParams,
        });

        if (!response.ok) {
          const body = await response.text();
          const err = new Error(`[${source.name}] ${response.status}: ${body}`) as any;
          err.status = response.status;
          err.body = body;
          throw err;
        }

        if (isStream) {
          this.totalRequests++;
          return response.body;
        }

        result = await response.json();
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        const body = String(err?.body || err?.message || '');
        if (this.isProviderCreditsError(err?.status, body, err)) {
          if (source?.name) {
            this.disabledSources.add(source.name);
            console.warn(`⚠️ Provider source '${source.name}' is unavailable (${body.slice(0, 180)}). Switching routes.`);
          }
          const fallback = this.pickChatFallback(attemptModel);
          if (fallback && fallback !== attemptModel) {
            attemptModel = fallback;
            continue;
          }
        }

        const msg = String(err?.message || '');
        const code = String(err?.code || err?.error?.code || '');
        if (code === 'model_terms_required' || msg.includes('model_terms_required') || msg.includes('requires terms acceptance')) {
          this.markTermsLocked(attemptModel);
          const fallback = this.pickChatFallback(attemptModel);
          console.warn(`⚠️ Retrying with fallback model '${fallback}' (terms-required lock on '${attemptModel}').`);
          attemptModel = fallback;
          continue;
        }

        throw err;
      }
    }

    if (lastErr) {
      throw lastErr;
    }

    if (isStream) {
      this.totalRequests++;
      return result as any;
    }

    const completion = result as any;
    this.totalRequests++;

    this.addLog({
      method: 'POST',
      path: '/v1/chat/completions',
      model: effectiveParams.model,
      status: 200,
      duration_ms: 0,
      tokens: (completion.usage?.total_tokens || 0),
      success: true,
    });

    return completion;
  }

  async createTranscription(fileBuffer: Buffer, fileName: string, params: any): Promise<any> {
    const model = params.model || 'whisper-large-v3';
    await this.checkAndUpdateRateLimit(model, 0);

    const file = await Groq.toFile(fileBuffer, fileName);
    const result = await this.retryRequest(() => this.client.audio.transcriptions.create({
      file,
      model: model as any,
      language: params.language,
      prompt: params.prompt,
      response_format: params.response_format,
      temperature: params.temperature,
      timestamp_granularities: params.timestamp_granularities,
    } as any));

    this.totalRequests++;
    this.addLog({
      method: 'POST',
      path: '/v1/audio/transcriptions',
      model,
      status: 200,
      duration_ms: 0,
      tokens: 0,
      success: true,
    });

    return { text: result.text };
  }

  async createTranslation(fileBuffer: Buffer, fileName: string, params: any): Promise<any> {
    const model = params.model || 'whisper-large-v3';
    await this.checkAndUpdateRateLimit(model, 0);

    const file = await Groq.toFile(fileBuffer, fileName);
    const result = await this.retryRequest(() => this.client.audio.translations.create({
      file,
      model: model as any,
      prompt: params.prompt,
      response_format: params.response_format,
      temperature: params.temperature,
    } as any));

    this.totalRequests++;
    this.addLog({
      method: 'POST',
      path: '/v1/audio/translations',
      model,
      status: 200,
      duration_ms: 0,
      tokens: 0,
      success: true,
    });

    return { text: result.text };
  }

  async createEmbeddings(params: { model: string; input: string | string[]; encoding_format?: string; user?: string }): Promise<any> {
    const effectiveParams = { ...params } as any;

    if (!effectiveParams.model) {
      // Pick the first available embedding model, if any.
      const embed = this.models.find(m => m.category === 'embedding')?.id;
      if (!embed) {
        const err: any = new Error('No embeddings model is available for this Groq account.');
        err.status = 404;
        err.type = 'invalid_request_error';
        err.code = 'model_not_found';
        throw err;
      }
      effectiveParams.model = embed;
    }

    const model = effectiveParams.model;
    const modelRecord = this.models.find(m => m.id === model);
    if (!modelRecord) {
      const err: any = new Error(`The model \`${model}\` does not exist or you do not have access to it.`);
      err.status = 404;
      err.type = 'invalid_request_error';
      err.code = 'model_not_found';
      throw err;
    }

    await this.checkAndUpdateRateLimit(model, 0);
    const source = getSourceForModel(model) || getConfiguredSources().find((s) => s.enabled) || null;
    if (!source) {
      const err: any = new Error(`No provider source configured for model ${model}`);
      err.status = 404;
      throw err;
    }

    const response = await requestOpenAiCompatible({
      baseUrl: source.baseUrl,
      apiKey: getSourceApiKey(source),
      path: '/embeddings',
      body: effectiveParams,
    });
    if (!response.ok) {
      const body = await response.text();
      const err: any = new Error(`[${source.name}] ${response.status}: ${body}`);
      err.status = response.status;
      throw err;
    }
    const result = await response.json();

    this.totalRequests++;
    this.addLog({
      method: 'POST',
      path: '/v1/embeddings',
      model,
      status: 200,
      duration_ms: 0,
      tokens: result.usage?.total_tokens || 0,
      success: true,
    });

    return result;
  }

  getModels(): ModelMeta[] {
    return this.models;
  }

  getModel(id: string): ModelMeta | undefined {
    return this.models.find(m => m.id === id);
  }

  getRateLimits(): RateLimitState[] {
    const now = Date.now();
    return Array.from(this.rateCounters.entries()).map(([model, counter]) => {
      const limits = this.getRateLimit(model);
      return {
        model,
        rpm: limits.rpm,
        tpm: limits.tpm,
        current_rpm: counter.count,
        current_tpm: counter.tokens,
        resets_in_seconds: Math.max(0, Math.ceil((counter.resetAt - now) / 1000)),
      };
    });
  }

  getConfiguredRateLimits(): Array<{ model: string; rpm: number; tpm: number }> {
    return this.models.map(m => {
      const lim = this.getRateLimit(m.id);
      return { model: m.id, rpm: lim.rpm, tpm: lim.tpm };
    });
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
  }

  getStatus(): ServerStatus {
    return {
      status: this.models.length > 0 ? 'ok' : 'degraded',
      uptime: Date.now() - this.startedAt,
      models_count: this.models.length,
      total_requests: this.totalRequests,
      auto_select: this._autoSelect,
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
  }

  addLog(entry: Omit<LogEntry, 'timestamp'>): void {
    const log: LogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(log);
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-500);
    }
    writeLog(log);
  }

  private estimateTokens(text: string): number {
    // More accurate token estimation:
    // - English text: ~4 chars per token (conservative)
    // - Code: ~3 chars per token (more tokens)
    // - Non-ASCII (Bengali, etc.): ~2 chars per token
    if (!text) return 0;
    
    let charCount = 0;
    let nonAsciiCount = 0;
    
    for (const char of text) {
      charCount++;
      if (char.charCodeAt(0) > 127) {
        nonAsciiCount++;
      }
    }
    
    const asciiCount = charCount - nonAsciiCount;
    const asciiTokens = Math.ceil(asciiCount / 4);
    const nonAsciiTokens = Math.ceil(nonAsciiCount / 2);
    
    return asciiTokens + nonAsciiTokens;
  }

  private buildFallbackModels(): ModelMeta[] {
    const rows: ModelMeta[] = Object.entries(MODEL_META).map(([id, meta]) => ({
      id,
      object: 'model' as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: id.startsWith('big-') || id.startsWith('deepseek-') || id.startsWith('mimo-') || id.startsWith('nemotron-') || id.startsWith('claude-') || id.startsWith('gpt-') || id.startsWith('gemini-')
        ? 'opencode'
        : id.startsWith('openai/')
          ? 'openai'
          : 'groq',
      ...meta,
      provider: id.startsWith('big-') || id.startsWith('deepseek-') || id.startsWith('mimo-') || id.startsWith('nemotron-') || id.startsWith('claude-') || id.startsWith('gpt-') || id.startsWith('gemini-')
        ? 'OpenCode'
        : id.startsWith('openai/')
          ? 'OpenAI'
          : 'Groq',
      source_name: id.startsWith('big-') || id.startsWith('deepseek-') || id.startsWith('mimo-') || id.startsWith('nemotron-') || id.startsWith('claude-') || id.startsWith('gpt-') || id.startsWith('gemini-')
        ? 'opencode'
        : 'groq',
      source_kind: id.startsWith('big-') || id.startsWith('deepseek-') || id.startsWith('mimo-') || id.startsWith('nemotron-') || id.startsWith('claude-') || id.startsWith('gpt-') || id.startsWith('gemini-')
        ? 'opencode'
        : 'groq',
      base_url: id.startsWith('big-') || id.startsWith('deepseek-') || id.startsWith('mimo-') || id.startsWith('nemotron-') || id.startsWith('claude-') || id.startsWith('gpt-') || id.startsWith('gemini-')
        ? 'https://opencode.ai/zen/v1'
        : 'https://api.groq.com/openai/v1',
      api_key_env: id.startsWith('big-') || id.startsWith('deepseek-') || id.startsWith('mimo-') || id.startsWith('nemotron-') || id.startsWith('claude-') || id.startsWith('gpt-') || id.startsWith('gemini-')
        ? 'OPENCODE_API_KEY'
        : 'GROQ_API_KEY',
      source_model_id: id,
      status: 'active',
      is_active: true,
      is_free: id.startsWith('big-') || id.startsWith('deepseek-') || id.startsWith('mimo-') || id.startsWith('nemotron-'),
      sync_status: 'ok',
      sync_error: null,
      last_synced_at: new Date().toISOString(),
    }));
    return rows;
  }
}
