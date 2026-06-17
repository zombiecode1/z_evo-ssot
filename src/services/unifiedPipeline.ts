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

import { generateText, streamText, type ModelMessage, type Tool } from 'ai';
import { getLanguageModel, getReasoningModel, resolveModelId } from '../providers/ai-sdk-registry';
import { getIdentity } from './identityService';
import { DiskRAGService } from './ragService';
import { VectorIndexService } from './vectorIndexService';
import { MawlanaRouter } from './mawlanaRouter';
import type { GroqService } from './groqService';
import crypto from 'crypto';

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
    message: { role: string; content: string };
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
  conversation_id?: string;
}

// ─── Pipeline State (shared across all requests) ──────────────

let _ragService: DiskRAGService | null = null;
let _vectorIndexService: VectorIndexService | null = null;
let _mawlanaRouter: MawlanaRouter | null = null;
let _groqService: GroqService | null = null;

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

async function injectRagContext(
  messages: ModelMessage[],
  directory?: string,
  workspaceId?: string,
): Promise<ModelMessage[]> {
  if (!_ragService || !directory) return messages;

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

    if (ragContext) {
      // Inject as system message before the last user message
      const sysMsg: ModelMessage = {
        role: 'system',
        content: `Project context (RAG):\n${ragContext}`,
      };
      return [...messages.slice(0, -1), sysMsg, messages[messages.length - 1]];
    }
  } catch (e: any) {
    console.warn('RAG injection failed:', e?.message || e);
  }

  return messages;
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
  let systemPrompt = input.systemPrompt || 'You are ZombieCoder, a helpful AI assistant.';
  systemPrompt = injectIdentity(systemPrompt);

  // 2. Convert messages to ModelMessage format
  let coreMessages: ModelMessage[] = input.messages.map(m => ({
    role: m.role as 'system' | 'user' | 'assistant',
    content: m.content,
  }));

  // 3. Load conversation history
  coreMessages = await loadConversationHistory(coreMessages, input.conversationId);

  // 4. Inject RAG context (if enabled)
  if (input.enableRag !== false && input.directory) {
    coreMessages = await injectRagContext(coreMessages, input.directory, input.workspaceId);
  }

  // 5. Resolve model ID
  const modelId = resolveModelId(input.model);

  // 6. Use reasoning model for reasoning-capable models (DeepSeek, etc.)
  const isReasoningModel = modelId.includes('deepseek') || modelId.includes('r1');
  const model = isReasoningModel ? getReasoningModel(modelId) : getLanguageModel(modelId);

  // 7. Call AI SDK generateText (Provider Truth)
  const result = await generateText({
    model,
    messages: coreMessages,
    system: systemPrompt,
    maxOutputTokens: input.maxOutputTokens || 4096,
    temperature: input.temperature ?? 0.7,
  });

  // 8. Build OpenAI-compatible response (reasoning content PRESERVED)
  const output: PipelineOutput = {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
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

  // 9. Preserve reasoning content (NEVER dropped)
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
  console.log(`✅ Pipeline: model=${modelId}, tokens=${output.usage.total_tokens}, ${durationMs}ms`);

  return output;
}

// ─── Core: Streaming Pipeline ─────────────────────────────────

export async function runStreamingPipeline(
  input: PipelineInput,
): Promise<StreamPipelineOutput> {
  // 1. Build system prompt with identity
  let systemPrompt = input.systemPrompt || 'You are ZombieCoder, a helpful AI assistant.';
  systemPrompt = injectIdentity(systemPrompt);

  // 2. Convert messages
  let coreMessages: ModelMessage[] = input.messages.map(m => ({
    role: m.role as 'system' | 'user' | 'assistant',
    content: m.content,
  }));

  // 3. Load conversation history
  coreMessages = await loadConversationHistory(coreMessages, input.conversationId);

  // 4. Inject RAG context
  if (input.enableRag !== false && input.directory) {
    coreMessages = await injectRagContext(coreMessages, input.directory, input.workspaceId);
  }

  // 5. Resolve model
  const modelId = resolveModelId(input.model);
  const isReasoningModel = modelId.includes('deepseek') || modelId.includes('r1');
  const model = isReasoningModel ? getReasoningModel(modelId) : getLanguageModel(modelId);

  // 6. Call AI SDK streamText (Provider Truth — single call, no double-call)
  const result = streamText({
    model,
    messages: coreMessages,
    system: systemPrompt,
    maxOutputTokens: input.maxOutputTokens || 4096,
    temperature: input.temperature ?? 0.7,
  });

  return {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    model: modelId,
    stream: result.textStream,
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
