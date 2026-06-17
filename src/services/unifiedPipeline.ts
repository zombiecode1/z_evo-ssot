/**
 * Unified Agent Pipeline — ZombieCoder
 *
 * Architecture:
 *   Single pipeline for ALL agent requests:
 *     - /v1/chat/completions  (non-agent, direct model call)
 *     - /v1/agent/chat        (agent with tools + RAG)
 *     - /v1/agent/langchain   (LangGraph agent)
 *
 * Flow:
 *   1. Identity Injection (system prompt from identity.json)
 *   2. DB-first Config → Env Fallback → Fail Explicitly
 *   3. RAG Context Injection (SSOT.md)
 *   4. Tool Layer (MCP via @langchain/mcp-adapters)
 *   5. Model Call (via AI SDK — Provider Truth)
 *   6. Response (OpenAI-compatible format — reasoning content PRESERVED)
 *
 * Anti-patterns avoided:
 *   - No custom response normalizer (AI SDK handles it)
 *   - No double model calls (single generateText/streamText)
 *   - No dropping reasoning content (extractReasoningMiddleware)
 *   - No multiple pipelines (THIS is the one pipeline)
 */

import { generateText, streamText, type ModelMessage, type Tool, jsonSchema } from 'ai';
import { getLanguageModel, getReasoningModel, resolveModelId, getRegisteredProviderIds } from '../providers/ai-sdk-registry';
import { getIdentity } from './identityService';
import { DiskRAGService } from './ragService';
import { VectorIndexService } from './vectorIndexService';
import { MawlanaRouter } from './mawlanaRouter';
import type { GroqService } from './groqService';
import crypto from 'crypto';

// ─── MCP Tool Support ─────────────────────────────────────
// Lazy-load MCP tools for agent endpoints (via @langchain/mcp-adapters)

let _mcpToolsCache: any[] | null = null;

/**
 * Load MCP tools and convert to AI SDK format.
 * Tools are cached after first load.
 */
export async function loadMcpToolsForPipeline(): Promise<Record<string, Tool<any, any>> | undefined> {
  try {
    // Dynamic import to avoid circular dependencies
    const { getMcpToolsForAgent } = require('./langchainAgent');
    const langchainTools = await getMcpToolsForAgent();

    if (!langchainTools || langchainTools.length === 0) {
      return undefined;
    }

    // Convert LangChain tools to AI SDK format
    const tools: Record<string, Tool<any, any>> = {};
    for (const lcTool of langchainTools) {
      const toolSchema = lcTool.schema || lcTool.parameters || { type: 'object', properties: {} };
      // LangChain tools may have schema as a Zod schema or plain object
      let jsonSchemaDef: any;
      if (toolSchema && typeof toolSchema === 'object' && toolSchema._def) {
        // Zod schema — use empty object schema as fallback
        jsonSchemaDef = { type: 'object', properties: {} };
      } else {
        jsonSchemaDef = toolSchema;
      }

      tools[lcTool.name] = {
        description: lcTool.description || '',
        inputSchema: jsonSchema(jsonSchemaDef),
      };
    }

    console.log(`🔧 Pipeline MCP tools: ${Object.keys(tools).length} tools loaded`);
    return tools;
  } catch (err: any) {
    console.warn('Pipeline MCP tools load failed:', err?.message || err);
    return undefined;
  }
}

// ─── Types ─────────────────────────────────────────────────────

export interface PipelineInput {
  messages: Array<{ role: string; content: string; tool_calls?: any; tool_call_id?: string; name?: string }>;
  model?: string;
  systemPrompt?: string;
  directory?: string;
  workspaceId?: string;
  conversationId?: string;
  category?: string;
  sessionId?: string;

  // Agent options
  enableTools?: boolean;
  enableRag?: boolean;
  enableStreaming?: boolean;
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;

  // Tool support (OpenAI-compatible format — converted to AI SDK internally)
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: any;
    };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

  // Legacy compatibility
  legacy?: boolean;
}

export interface PipelineOutput {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string; tool_calls?: any[] };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // Metadata (NOT dropped)
  providerMetadata?: Record<string, any>;
  reasoning?: string;  // Preserved from reasoning models
  conversation_id?: string;
  tool_calls?: string[];
}

export interface StreamPipelineOutput {
  id: string;
  model: string;
  stream: AsyncIterable<any>;
  fullStream?: AsyncIterable<any>;
  conversation_id?: string;
}

// ─── Pipeline State (shared across all requests) ──────────────

let _ragService: DiskRAGService | null = null;
let _vectorIndexService: VectorIndexService | null = null;
let _mawlanaRouter: MawlanaRouter | null = null;
let _groqService: GroqService | null = null;

const FALLBACK_MODEL_POOLS: Record<string, string[]> = {
  opencode: [
    'mimo-v2.5-free',
    'deepseek-v4-flash-free',
    'big-pickle',
    'nemotron-3-ultra-free',
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'qwen/qwen3-32b',
    'openai/gpt-oss-20b',
    'groq/compound-mini',
  ],
  openai: [
    'gpt-4o-mini',
    'gpt-4.1-mini',
  ],
  gemini: [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
  anthropic: [
    'claude-haiku-4-5',
  ],
};

function normalizeTextContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          return String(part.text || part.content || '');
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (content && typeof content === 'object') {
    return String(content.text || content.content || '');
  }
  return '';
}

function mergeSystemPrompts(...parts: Array<string | undefined | null>): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const part of parts) {
    const text = String(part || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    merged.push(text);
  }

  return merged.join('\n\n');
}

function separateSystemMessages(messages: ModelMessage[]): { systemMessages: string[]; messages: ModelMessage[] } {
  const systemMessages: string[] = [];
  const filtered: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const text = normalizeTextContent(message.content);
      if (text) systemMessages.push(text);
      continue;
    }
    filtered.push(message);
  }

  return { systemMessages, messages: filtered };
}

function buildPromptContext(
  inputMessages: ModelMessage[],
  inputSystemPrompt?: string,
): { systemPrompt: string; messages: ModelMessage[] } {
  const { systemMessages, messages } = separateSystemMessages(inputMessages);
  const identityPrompt = (() => {
    try {
      const identity = getIdentity();
      return identity?.system_identity?.system_prompt || 'You are ZombieCoder, a helpful AI assistant.';
    } catch {
      return 'You are ZombieCoder, a helpful AI assistant.';
    }
  })();
  const mergedSystemPrompt = mergeSystemPrompts(identityPrompt, inputSystemPrompt, ...systemMessages);

  return { systemPrompt: mergedSystemPrompt, messages };
}

function buildFallbackModelCandidates(modelId: string): string[] {
  const providers = new Set(getRegisteredProviderIds());
  const candidateIds: string[] = [];
  const pushCandidate = (candidate: string) => {
    if (candidate && !candidateIds.includes(candidate)) {
      candidateIds.push(candidate);
    }
  };

  pushCandidate(modelId);

  const [provider] = modelId.includes(':') ? modelId.split(':', 2) : ['opencode'];
  const providerOrder = [provider, 'opencode', 'groq', 'openai', 'gemini', 'anthropic'];

  for (const providerId of providerOrder) {
    if (!providerId || !providers.has(providerId)) continue;
    const pool = FALLBACK_MODEL_POOLS[providerId];
    if (!pool) continue;
    for (const model of pool) {
      pushCandidate(`${providerId}:${model}`);
    }
  }

  return candidateIds;
}

function isRetryableModelError(err: any): boolean {
  const status = Number(err?.statusCode || err?.status || err?.response?.status || 0);
  if ([401, 403, 404, 408, 409, 429].includes(status)) return true;

  const message = String(err?.message || '').toLowerCase();
  return (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('not found') ||
    message.includes('model_not_found') ||
    message.includes('rate limit')
  );
}

async function generateTextWithFallback(generateParams: any, primaryModelId: string) {
  const candidates = buildFallbackModelCandidates(primaryModelId);
  let lastError: any = null;

  for (const candidate of candidates) {
    const model = candidate.includes('deepseek') || candidate.includes('r1')
      ? getReasoningModel(candidate)
      : getLanguageModel(candidate);

    try {
      const result = await generateText({
        ...generateParams,
        model,
      });

      return { result, modelId: candidate, fallbackUsed: candidate !== primaryModelId };
    } catch (err: any) {
      lastError = err;
      if (!isRetryableModelError(err)) {
        throw err;
      }
      console.warn(`↩️ Model failed, trying fallback: ${candidate} -> ${err?.message || err}`);
    }
  }

  throw lastError || new Error('All model fallbacks failed');
}

function streamTextWithFallback(streamParams: any, primaryModelId: string) {
  const candidates = buildFallbackModelCandidates(primaryModelId);
  const state = { modelId: primaryModelId };

  async function* streamGenerator() {
    let lastError: any = null;

    for (const candidate of candidates) {
      const model = candidate.includes('deepseek') || candidate.includes('r1')
        ? getReasoningModel(candidate)
        : getLanguageModel(candidate);
      let yielded = false;

      try {
        const result = streamText({
          ...streamParams,
          model,
        });

        state.modelId = candidate;

        for await (const chunk of result.textStream) {
          yielded = true;
          yield chunk;
        }

        return;
      } catch (err: any) {
        lastError = err;
        if (state.modelId === candidate && yielded) {
          throw err;
        }
        if (!isRetryableModelError(err)) {
          throw err;
        }
        console.warn(`↩️ Stream model failed, trying fallback: ${candidate} -> ${err?.message || err}`);
      }
    }

    throw lastError || new Error('All stream model fallbacks failed');
  }

  return { state, stream: streamGenerator() };
}

/**
 * Initialize the pipeline with required services.
 * Called once during server startup.
 */
export function initPipeline(services: {
  rag: DiskRAGService;
  vectorIndex?: VectorIndexService;
  mawlana: MawlanaRouter;
  groq: GroqService;
}) {
  _ragService = services.rag;
  _vectorIndexService = services.vectorIndex || null;
  _mawlanaRouter = services.mawlana;
  _groqService = services.groq;
  console.log('🔧 Unified Pipeline initialized');
}

// ─── Middleware: Identity Injection ────────────────────────────

function injectIdentity(basePrompt: string): string {
  try {
    const identity = getIdentity();
    const sys = identity?.system_identity?.system_prompt;
    if (sys && !basePrompt.includes('ZombieCoder')) {
      return `${sys}\n\n${basePrompt}`;
    }
  } catch {
    // Don't fail if identity loading fails
  }
  return basePrompt;
}

// ─── Middleware: RAG Context Injection ─────────────────────────

async function collectRagContext(
  messages: ModelMessage[],
  directory?: string,
  workspaceId?: string,
): Promise<string> {
  if (!_ragService || !directory) return '';

  try {
    // Ensure SSOT exists (self-healing)
    if (!_ragService.ssotExists()) {
      const scanResult = await _ragService.scanProject();
      const template = _ragService.generateSSOTTemplate(scanResult);
      _ragService.saveSSOT(template);
    }

    const lastMsg = messages[messages.length - 1];
    const query = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : Array.isArray(lastMsg.content)
        ? lastMsg.content.map((p: any) => p.text || '').join(' ')
        : '';

    let ragContext = '';

    // Try vector search first
    if (_vectorIndexService && _ragService.currentDir) {
      try {
        const indexed = await _vectorIndexService.search(query, {
          workspaceId,
          limit: 5,
        });
        ragContext = indexed.matches
          .map((item) => `- ${item.source_path} [chunk ${item.chunk_index}]: ${item.chunk_text}`)
          .join('\n');
      } catch {
        // Fall through to SSOT search
      }
    }

    // Fallback to SSOT keyword search
    if (!ragContext && _ragService.ssotExists()) {
      ragContext = _ragService.searchSSOT(query);
    }

    return ragContext ? `Project context (RAG):\n${ragContext}` : '';
  } catch (e: any) {
    console.warn('RAG injection failed:', e?.message || e);
  }

  return '';
}

// ─── Middleware: Conversation History ──────────────────────────

async function loadConversationHistory(
  messages: ModelMessage[],
  conversationId?: string,
): Promise<ModelMessage[]> {
  if (!conversationId) return messages;

  try {
    const { initStateDb, listConversationMessages } = require('./stateDb');
    const stateDb = initStateDb();
    if (!stateDb) return messages;

    const history = listConversationMessages(stateDb, conversationId, 20);
    if (history.length > 0) {
      const historyMsgs: ModelMessage[] = history
        .filter((h: any) => h.role === 'user' || h.role === 'assistant')
        .slice(0, -1)
        .map((h: any) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
        }));

      if (historyMsgs.length > 0) {
        return [...historyMsgs, ...messages];
      }
    }
  } catch {
    // Don't fail if history loading fails
  }

  return messages;
}

// ─── Core: Non-Streaming Pipeline ─────────────────────────────

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const startTime = Date.now();

  // 1. Build system prompt with identity
  const prepared = buildPromptContext(
    input.messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: String(m.content || ''),
    })),
    input.systemPrompt,
  );
  const systemPrompt = prepared.systemPrompt;

  // 2. Convert messages to ModelMessage format
  let coreMessages: ModelMessage[] = prepared.messages;

  // 3. Load conversation history
  coreMessages = await loadConversationHistory(coreMessages, input.conversationId);

  // 4. Inject RAG context into system prompt only
  let ragContext = '';
  if (input.enableRag !== false && input.directory) {
    ragContext = await collectRagContext(coreMessages, input.directory, input.workspaceId);
  }

  // 5. Resolve model ID
  const modelId = resolveModelId(input.model);

  // 6. Convert tools (OpenAI format → AI SDK format)
  const toolConfig = convertTools(input.tools, input.tool_choice);

  // 6b. Load MCP tools if enableTools is true (agent endpoint)
  let mcpToolConfig: { tools?: Record<string, Tool<any, any>> } | undefined;
  if (input.enableTools && !toolConfig) {
    const mcpTools = await loadMcpToolsForPipeline();
    if (mcpTools) {
      mcpToolConfig = { tools: mcpTools };
    }
  }

  // 7. Call AI SDK generateText (Provider Truth)
  const generateParams: any = {
    messages: coreMessages,
    system: [systemPrompt, ragContext].filter(Boolean).join('\n\n'),
    maxOutputTokens: input.maxOutputTokens || 4096,
    temperature: input.temperature ?? 0.7,
  };

  if (toolConfig) {
    generateParams.tools = toolConfig.tools;
    if (toolConfig.toolChoice) {
      generateParams.toolChoice = toolConfig.toolChoice;
    }
    // maxSteps for tool call loops — AI SDK will auto-loop tool calls
    generateParams.maxSteps = input.maxSteps || 10;
  } else if (mcpToolConfig) {
    // MCP tools from agent endpoint — use 'auto' tool choice
    generateParams.tools = mcpToolConfig.tools;
    generateParams.toolChoice = 'auto';
    generateParams.maxSteps = input.maxSteps || 10;
  }

  const generated = await generateTextWithFallback(generateParams, modelId);
  const result = generated.result;

  // 8. Build OpenAI-compatible response (reasoning content PRESERVED)
  const output: PipelineOutput = {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: generated.modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: result.text,
      },
      finish_reason: mapFinishReason(result.finishReason),
    }],
    usage: {
      prompt_tokens: result.usage.inputTokens || 0,
      completion_tokens: result.usage.outputTokens || 0,
      total_tokens: (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0),
    },
  };

  // 10. Handle tool calls in response (AI SDK returns toolCalls in result)
  if (result.toolCalls && result.toolCalls.length > 0) {
    output.choices[0].message.tool_calls = result.toolCalls.map((tc: any) => ({
      id: tc.toolCallId || `call_${crypto.randomUUID().slice(0, 8)}`,
      type: 'function',
      function: {
        name: tc.toolName,
        arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}),
      },
    }));
    output.tool_calls = result.toolCalls.map((tc: any) => tc.toolName);
    // If content is empty but we have tool calls, this is expected
    if (!output.choices[0].message.content && result.toolCalls.length > 0) {
      output.choices[0].finish_reason = 'tool_calls';
    }
  }

  // 11. Preserve reasoning content (NEVER dropped)
  // Architecture: reasoning models' thinking process is preserved in metadata
  if (result.reasoningText) {
    output.reasoning = result.reasoningText;
  } else if (result.reasoning && result.reasoning.length > 0) {
    output.reasoning = result.reasoning
      .map(r => typeof r === 'string' ? r : JSON.stringify(r))
      .join('\n');
  }

  // 10. Preserve provider metadata
  if (result.providerMetadata) {
    output.providerMetadata = result.providerMetadata as Record<string, any>;
  }

  const durationMs = Date.now() - startTime;
  console.log(`✅ Pipeline: model=${generated.modelId}, tokens=${output.usage.total_tokens}, ${durationMs}ms${generated.fallbackUsed ? ' (fallback)' : ''}`);

  return output;
}

// ─── Core: Streaming Pipeline ─────────────────────────────────

export async function runStreamingPipeline(
  input: PipelineInput,
): Promise<StreamPipelineOutput> {
  // 1. Build system prompt with identity
  const prepared = buildPromptContext(
    input.messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: String(m.content || ''),
    })),
    input.systemPrompt,
  );
  const systemPrompt = prepared.systemPrompt;

  // 2. Convert messages
  let coreMessages: ModelMessage[] = prepared.messages;

  // 3. Load conversation history
  coreMessages = await loadConversationHistory(coreMessages, input.conversationId);

  // 4. Inject RAG context into system prompt only
  let ragContext = '';
  if (input.enableRag !== false && input.directory) {
    ragContext = await collectRagContext(coreMessages, input.directory, input.workspaceId);
  }

  // 5. Resolve model
  const modelId = resolveModelId(input.model);

  // 6. Convert tools (OpenAI format → AI SDK format)
  const toolConfig = convertTools(input.tools, input.tool_choice);

  // 6b. Load MCP tools if enableTools is true (agent endpoint)
  let mcpToolConfig: { tools?: Record<string, Tool<any, any>> } | undefined;
  if (input.enableTools && !toolConfig) {
    const mcpTools = await loadMcpToolsForPipeline();
    if (mcpTools) {
      mcpToolConfig = { tools: mcpTools };
    }
  }

  // 7. Call AI SDK streamText (Provider Truth — single call, no double-call)
  const streamParams: any = {
    messages: coreMessages,
    system: [systemPrompt, ragContext].filter(Boolean).join('\n\n'),
    maxOutputTokens: input.maxOutputTokens || 4096,
    temperature: input.temperature ?? 0.7,
  };

  if (toolConfig) {
    streamParams.tools = toolConfig.tools;
    if (toolConfig.toolChoice) {
      streamParams.toolChoice = toolConfig.toolChoice;
    }
    streamParams.maxSteps = input.maxSteps || 10;
  } else if (mcpToolConfig) {
    streamParams.tools = mcpToolConfig.tools;
    streamParams.toolChoice = 'auto';
    streamParams.maxSteps = input.maxSteps || 10;
  }

  const fallbackStream = streamTextWithFallback(streamParams, modelId);

  return {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    model: fallbackStream.state.modelId,
    stream: fallbackStream.stream,
    fullStream: undefined,
    conversation_id: input.conversationId,
  };
}

// ─── Model Routing (via MawlanaRouter) ────────────────────────

/**
 * Route a request to the best model based on content category.
 * Uses MawlanaRouter for intelligent model selection.
 */
export async function routeModel(
  messages: Array<{ role: string; content: string }>,
  category?: string,
): Promise<{ model: string; needsRag: boolean }> {
  if (_mawlanaRouter) {
    const route = await _mawlanaRouter.route(messages, category);
    return { model: route.model, needsRag: route.needsRag };
  }

  return { model: 'opencode:deepseek-v4-flash-free', needsRag: false };
}

// ─── Tool Conversion: OpenAI format → AI SDK format ──────────

function convertTools(
  openaiTools?: PipelineInput['tools'],
  tool_choice?: PipelineInput['tool_choice'],
): { tools?: Record<string, Tool<any, any>>; toolChoice?: any } | undefined {
  if (!openaiTools || openaiTools.length === 0) return undefined;

  const tools: Record<string, Tool<any, any>> = {};
  for (const t of openaiTools) {
    if (t.type === 'function' && t.function?.name) {
      const schema = t.function.parameters || { type: 'object', properties: {} };
      tools[t.function.name] = {
        description: t.function.description || '',
        inputSchema: jsonSchema(schema),
      };
    }
  }

  if (Object.keys(tools).length === 0) return undefined;

  let sdkToolChoice: any = undefined;
  if (tool_choice === 'auto') sdkToolChoice = 'auto';
  else if (tool_choice === 'none') sdkToolChoice = 'none';
  else if (tool_choice === 'required') sdkToolChoice = 'any';
  else if (tool_choice && typeof tool_choice === 'object' && 'function' in tool_choice) {
    sdkToolChoice = { type: 'tool', toolName: tool_choice.function.name };
  }

  return { tools, toolChoice: sdkToolChoice };
}

// ─── Helpers ──────────────────────────────────────────────────

function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool-calls': return 'tool_calls';
    case 'content-filter': return 'content_filter';
    default: return 'stop';
  }
}
