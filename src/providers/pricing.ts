// ─── Provider Pricing Data ───────────────────────────────
// Per-model pricing for cost tracking (USD per 1M tokens).
// Source: Provider pricing pages (as of 2025).
// Free models have cost = 0.

export interface ModelPricing {
  providerId: string;
  modelId: string;
  inputCostPer1M: number;   // USD per 1M input tokens
  outputCostPer1M: number;  // USD per 1M output tokens
  isFree: boolean;
}

// Pricing lookup table — keyed by `${providerId}:${modelId}`
const PRICING_TABLE: Map<string, ModelPricing> = new Map();

function addPricing(providerId: string, modelId: string, input: number, output: number, isFree = false): void {
  PRICING_TABLE.set(`${providerId}:${modelId}`, {
    providerId,
    modelId,
    inputCostPer1M: input,
    outputCostPer1M: output,
    isFree,
  });
}

// ─── OpenCode (Free) ──────────────────────────────────────
addPricing('opencode', 'opencode/small', 0, 0, true);
addPricing('opencode', 'opencode/fast', 0, 0, true);
addPricing('opencode', 'opencode/default', 0, 0, true);

// ─── Groq ─────────────────────────────────────────────────
addPricing('groq', 'llama-3.3-70b-versatile', 0.59, 0.79);
addPricing('groq', 'llama-3.1-8b-instant', 0.05, 0.08);
addPricing('groq', 'llama-3.1-70b-versatile', 0.59, 0.79);
addPricing('groq', 'llama-3.1-8b-versatile', 0.05, 0.08);
addPricing('groq', 'mixtral-8x7b-32768', 0.24, 0.24);
addPricing('groq', 'gemma2-9b-it', 0.20, 0.20);
addPricing('groq', 'qwen-qwq-32b', 0.29, 0.39);
addPricing('groq', 'deepseek-r1-distill-llama-70b', 0.75, 0.99);
addPricing('groq', 'meta-llama/llama-4-scout-17b-16e-instruct', 0.08, 0.08);
addPricing('groq', 'allam-2-7b', 0.05, 0.05);

// ─── OpenAI ───────────────────────────────────────────────
addPricing('openai', 'gpt-4o', 2.50, 10.00);
addPricing('openai', 'gpt-4o-mini', 0.15, 0.60);
addPricing('openai', 'gpt-4-turbo', 10.00, 30.00);
addPricing('openai', 'gpt-3.5-turbo', 0.50, 1.50);
addPricing('openai', 'o1', 15.00, 60.00);
addPricing('openai', 'o1-mini', 3.00, 12.00);
addPricing('openai', 'o3-mini', 1.10, 4.40);

// ─── Gemini ───────────────────────────────────────────────
addPricing('gemini', 'gemini-2.0-flash', 0.10, 0.40);
addPricing('gemini', 'gemini-2.0-flash-lite', 0.075, 0.30);
addPricing('gemini', 'gemini-1.5-pro', 1.25, 5.00);
addPricing('gemini', 'gemini-1.5-flash', 0.075, 0.30);
addPricing('gemini', 'gemini-1.5-flash-8b', 0.0375, 0.15);

// ─── Anthropic ────────────────────────────────────────────
addPricing('anthropic', 'claude-sonnet-4-20250514', 3.00, 15.00);
addPricing('anthropic', 'claude-3-5-sonnet-20241022', 3.00, 15.00);
addPricing('anthropic', 'claude-3-5-haiku-20241022', 0.80, 4.00);
addPricing('anthropic', 'claude-3-opus-20240229', 15.00, 75.00);
addPricing('anthropic', 'claude-3-haiku-20240307', 0.25, 1.25);

/**
 * Get pricing for a specific provider + model combination.
 * Returns null if pricing is unknown (treats as expensive default).
 */
export function getModelPricing(providerId: string, modelId: string): ModelPricing | null {
  // Exact match first
  const exact = PRICING_TABLE.get(`${providerId}:${modelId}`);
  if (exact) return exact;

  // Partial match — modelId might include provider prefix (e.g. "groq/llama-3.3-70b-versatile")
  for (const [key, pricing] of PRICING_TABLE) {
    if (key.startsWith(`${providerId}:`) && modelId.includes(pricing.modelId)) {
      return pricing;
    }
  }

  return null;
}

/**
 * Calculate cost for a request based on usage and model pricing.
 * Returns cost in USD, or null if pricing unknown.
 */
export function calculateCost(
  providerId: string,
  modelId: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): { inputCost: number; outputCost: number; totalCost: number; isFree: boolean } | null {
  const pricing = getModelPricing(providerId, modelId);
  if (!pricing) return null;

  const inputCost = (usage.prompt_tokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (usage.completion_tokens / 1_000_000) * pricing.outputCostPer1M;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    isFree: pricing.isFree,
  };
}

/**
 * Get all known pricing data (for admin display).
 */
export function getAllPricing(): ModelPricing[] {
  return Array.from(PRICING_TABLE.values());
}

/**
 * Get pricing for a specific provider (for admin display).
 */
export function getProviderPricing(providerId: string): ModelPricing[] {
  return Array.from(PRICING_TABLE.values()).filter(p => p.providerId === providerId);
}
