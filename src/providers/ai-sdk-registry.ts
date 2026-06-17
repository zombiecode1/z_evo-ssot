/**
 * AI SDK Provider Registry — Provider Truth (সত্যের উৎস)
 *
 * Architecture Reference:
 *   Vercel AI SDK = Provider normalization + Provider Truth
 *   Manual response normalization is completely removed.
 *   generateText / streamText handle all provider differences.
 *
 * Providers use `createOpenAICompatible` for third-party services.
 * Models accessed via String ID: e.g. "opencode:deepseek-v4-flash-free"
 *
 * Anti-patterns avoided:
 *   - No custom response normalizer
 *   - No manual provider-specific response parsing
 *   - AI SDK handles reasoning content, toolCalls, usage, etc.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createProviderRegistry, wrapLanguageModel, extractReasoningMiddleware } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

// ─── Provider Configuration ───────────────────────────────────

interface ProviderDef {
  id: string;
  name: string;
  baseURL: string;
  apiKeyEnv: string;
}

const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    baseURL: process.env.OPENCODE_OPENAI_BASE_URL || 'https://opencode.ai/zen/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseURL: process.env.GROQ_OPENAI_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: process.env.OPENAI_OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    baseURL: process.env.GEMINI_OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: process.env.ANTHROPIC_OPENAI_BASE_URL || 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
];

// ─── Build Provider Instances ─────────────────────────────────
// Each provider is created using createOpenAICompatible — no manual fetch.
// AI SDK handles response normalization, streaming, tool calls, reasoning content.

function buildProviders(): Record<string, ReturnType<typeof createOpenAICompatible>> {
  const providers: Record<string, ReturnType<typeof createOpenAICompatible>> = {};

  for (const def of PROVIDER_DEFS) {
    const apiKey = process.env[def.apiKeyEnv] || '';
    if (!apiKey) {
      console.log(`⏭️  Provider "${def.id}" skipped — ${def.apiKeyEnv} not set`);
      continue;
    }

    providers[def.id] = createOpenAICompatible({
      name: def.id,
      apiKey,
      baseURL: def.baseURL,
    });

    console.log(`✅ Provider "${def.id}" registered — ${def.baseURL}`);
  }

  return providers;
}

// ─── Registry Singleton ───────────────────────────────────────

let _registry: ReturnType<typeof createProviderRegistry> | null = null;
let _providerIds: string[] = [];

/**
 * Get or create the AI SDK provider registry.
 *
 * Models are accessed via: registry.languageModel('providerId:modelId')
 * Example: registry.languageModel('opencode:deepseek-v4-flash-free')
 */
export function getAiSdkRegistry() {
  if (!_registry) {
    const providers = buildProviders();
    _providerIds = Object.keys(providers);

    if (_providerIds.length === 0) {
      throw new Error(
        'No AI SDK providers configured. Set at least one API key: ' +
        PROVIDER_DEFS.map(d => d.apiKeyEnv).join(', ')
      );
    }

    _registry = createProviderRegistry(providers as any);
    console.log(`🏗️  AI SDK Registry created with providers: ${_providerIds.join(', ')}`);
  }

  return _registry;
}

/**
 * Get the list of registered provider IDs.
 */
export function getRegisteredProviderIds(): string[] {
  if (!_registry) getAiSdkRegistry();
  return [..._providerIds];
}

/**
 * Get a language model from the registry.
 *
 * @param fullModelId - "providerId:modelId" (e.g. "opencode:deepseek-v4-flash-free")
 *                     or just "modelId" to auto-select the first available provider
 */
export function getLanguageModel(fullModelId: string): LanguageModelV3 {
  const registry = getAiSdkRegistry() as any;

  // If contains ":", use direct lookup: "opencode:deepseek-v4-flash-free"
  if (fullModelId.includes(':')) {
    return registry.languageModel(fullModelId);
  }

  // Otherwise, auto-select first available provider
  const fallbackProvider = _providerIds[0];
  if (!fallbackProvider) {
    throw new Error('No providers available');
  }

  return registry.languageModel(`${fallbackProvider}:${fullModelId}`);
}

/**
 * Get a language model wrapped with reasoning extraction middleware.
 * Used for reasoning models (DeepSeek R1, etc.) that return <think> blocks.
 *
 * IMPORTANT: Architecture requirement — reasoning content is NEVER dropped.
 * AI SDK extracts it via extractReasoningMiddleware and preserves it in metadata.
 */
export function getReasoningModel(fullModelId: string): LanguageModelV3 {
  const base = getLanguageModel(fullModelId);
  return wrapLanguageModel({
    model: base,
    middleware: extractReasoningMiddleware({ tagName: 'think' }),
  });
}

/**
 * Resolve a model ID with DB-first config + env fallback.
 * Priority: DB config → explicit model param → env default → hardcoded default
 */
export function resolveModelId(
  explicitModel?: string,
  dbConfig?: { provider?: string; model?: string },
  envDefault?: string,
): string {
  // 1. Explicit model from request (highest priority)
  if (explicitModel && explicitModel !== 'auto') {
    return explicitModel;
  }

  // 2. DB configuration
  if (dbConfig?.provider && dbConfig?.model) {
    return `${dbConfig.provider}:${dbConfig.model}`;
  }

  // 3. Environment variable
  if (envDefault) {
    return envDefault;
  }

  // 4. Hardcoded default (first free model from opencode)
  return 'opencode:deepseek-v4-flash-free';
}

/**
 * Check if a provider is available (has API key configured).
 */
export function isProviderAvailable(providerId: string): boolean {
  return _providerIds.includes(providerId);
}

/**
 * Get provider health status (lightweight check).
 */
export function getProviderHealth(): Record<string, { available: boolean; baseURL: string }> {
  const health: Record<string, { available: boolean; baseURL: string }> = {};

  for (const def of PROVIDER_DEFS) {
    health[def.id] = {
      available: !!process.env[def.apiKeyEnv],
      baseURL: def.baseURL,
    };
  }

  return health;
}

/**
 * Reset the registry (for testing).
 */
export function resetRegistry(): void {
  _registry = null;
  _providerIds = [];
}
