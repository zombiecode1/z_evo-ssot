// ─── Provider Orchestration ───────────────────────────────
// Barrel export for the provider orchestration system.
// Single import point for all provider-related types and classes.

// Types
export type {
  ChatMessage,
  ContentPart,
  ToolCall,
  ToolDefinition,
  ChatCompletionParams,
  ChatCompletionResponse,
  ChatCompletionChoice,
  UsageInfo,
  StreamChunk,
  StreamChoice,
  ProviderCapabilities,
  ProviderHealth,
  ProviderConfig,
  ModelInfo,
  ILLMProvider,
  ProviderRegistryEntry,
  GatewayConfig,
  AgentProfile,
  ModelSelectionResult,
  ProviderFactoryFn,
} from './types';

// Base class
export { BaseProvider } from './base.provider';

// Normalizers
export {
  normalizeOllamaResponse,
  normalizeAnthropicResponse,
  normalizeGeminiResponse,
  normalizeOpenAiResponse,
  normalizeOpenAiStreamChunk,
  parseSseStream,
  normalizeResponseAuto,
  type ProviderKind,
} from './normalizer';

// Tool normalizers
export {
  normalizeAnthropicToolCalls,
  normalizeAnthropicTools,
  normalizeGeminiToolCalls,
  normalizeOllamaToolCalls,
  denormalizeToAnthropicToolCalls,
  denormalizeToAnthropicToolResults,
  denormalizeToGeminiToolCalls,
  denormalizeToGeminiToolResults,
  hasToolCalls,
  extractToolCalls,
  buildToolResultMessage,
  validateToolDefinitions,
} from './tool-normalizer';

// Registry
export { ProviderRegistry, getProviderRegistry } from './provider-registry';

// Gateway
export { ProviderGateway } from './provider-gateway';
export type { AgentTemplate } from './provider-gateway';

// Pricing
export {
  getModelPricing,
  calculateCost,
  getAllPricing,
  getProviderPricing,
  type ModelPricing,
} from './pricing';

// Provider implementations
export { OpenCodeProvider } from './implementations/opencode.provider';
export { GroqProvider } from './implementations/groq.provider';
export { OpenAiProvider } from './implementations/openai.provider';
export { GeminiProvider } from './implementations/gemini.provider';
export { AnthropicProvider } from './implementations/anthropic.provider';
