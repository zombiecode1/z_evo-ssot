// ─── Provider Orchestration Types ─────────────────────────
// These types define the contract for all provider implementations.
// Every provider must conform to these interfaces.

// ─── Core Chat Types ──────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<ContentPart>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  user?: string;
  /** Provider-specific extra body fields */
  [key: string]: unknown;
}

// ─── Response Types ───────────────────────────────────────

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: UsageInfo;
  system_fingerprint?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: StreamChoice[];
  usage?: UsageInfo | null;
  system_fingerprint?: string;
}

export interface StreamChoice {
  index: number;
  delta: Partial<ChatMessage>;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

// ─── Provider Capabilities ────────────────────────────────

export interface ProviderCapabilities {
  /** Provider supports streaming responses */
  streaming: boolean;
  /** Provider supports tool/function calling */
  toolCalling: boolean;
  /** Provider supports vision (image inputs) */
  vision: boolean;
  /** Provider supports audio input/output */
  audio: boolean;
  /** Provider supports embeddings */
  embeddings: boolean;
  /** Provider supports system messages */
  systemMessages: boolean;
  /** Provider supports multi-turn conversations */
  multiTurn: boolean;
  /** Provider supports response_format (JSON mode etc.) */
  responseFormat: boolean;
  /** Max context window (tokens) - 0 if unknown */
  maxContextWindow: number;
  /** Max output tokens - 0 if unknown */
  maxOutputTokens: number;
  /** Provider-specific extensions */
  extensions?: Record<string, unknown>;
}

// ─── Provider Health ──────────────────────────────────────

export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'error' | 'unknown';
  latencyMs?: number;
  lastChecked?: Date;
  errorMessage?: string;
  errorCount?: number;
}

// ─── Provider Config (from database) ─────────────────────

export interface ProviderConfig {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKey?: string;
  priority: number;
  isActive: boolean;
  capabilities: ProviderCapabilities;
  rateLimitRpm?: number;
  rateLimitTpm?: number;
  healthStatus?: string;
  lastHealthCheck?: Date;
  errorCount: number;
}

// ─── Model Info (from database) ──────────────────────────

export interface ModelInfo {
  id: string;
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  category: 'fast' | 'balanced' | 'powerful' | 'vision' | 'audio' | 'embedding' | 'other';
  inputPricePer1k: number;
  outputPricePer1k: number;
  isFree: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  isActive: boolean;
}

// ─── Provider Interface ──────────────────────────────────

export interface ILLMProvider {
  /** Unique provider identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Provider capabilities */
  readonly capabilities: ProviderCapabilities;

  /** Send a chat completion request (non-streaming) */
  chat(params: ChatCompletionParams): Promise<ChatCompletionResponse>;

  /** Send a chat completion request (streaming) */
  chatStream(params: ChatCompletionParams): AsyncGenerator<StreamChunk, void, unknown>;

  /** Test the provider connection */
  testConnection(): Promise<ProviderHealth>;

  /** List available models from this provider */
  listModels(): Promise<ModelInfo[]>;

  /** Get provider health status */
  getHealth(): ProviderHealth;

  /** Dispose of resources */
  dispose(): void;
}

// ─── Provider Registry Types ─────────────────────────────

export interface ProviderRegistryEntry {
  provider: ILLMProvider;
  config: ProviderConfig;
  lastUsed?: Date;
  useCount: number;
}

// ─── Gateway Types ───────────────────────────────────────

export interface GatewayConfig {
  /** Default model for auto-selection */
  defaultModel?: string;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Retry delay in ms */
  retryDelayMs?: number;
  /** Cache TTL in ms */
  cacheTtlMs?: number;
  /** Budget limit in USD */
  budgetLimit?: number;
  /** Current spend in USD */
  currentSpend?: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  persona: string;
  preferredProviderId?: string;
  preferredModelId?: string;
  budgetLimit: number;
  autoSelect: boolean;
  allowedProviders: string[];
  allowedModels: string[];
  memory?: Record<string, unknown>;
}

// ─── Selection Result ────────────────────────────────────

export interface ModelSelectionResult {
  providerId: string;
  modelId: string;
  score: number;
  reason: string;
}

// ─── Provider Factory Types ─────────────────────────────

export type ProviderFactoryFn = (config: ProviderConfig) => ILLMProvider;
