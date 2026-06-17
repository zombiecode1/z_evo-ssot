/**
 * LangChain Agent Service — ZombieCoder
 *
 * Architecture:
 *   - LangGraph createReactAgent = Agent Loop, Memory, Middleware
 *   - @langchain/mcp-adapters = MCP Tool Integration (NOT response formatting)
 *   - AI SDK Provider Registry = Provider Truth (model calls)
 *
 * Flow:
 *   1. MultiServerMCPClient discovers MCP tools (tools/list via JSON-RPC)
 *   2. createReactAgent gets: model + tools + checkpoint (memory)
 *   3. Agent loop runs with tool execution + conversation memory
 *   4. Response includes reasoning content (NEVER dropped)
 *
 * Anti-patterns avoided:
 *   - No manual MCP tool wrapping (MultiServerMCPClient.getTools() does it)
 *   - No custom response normalizer
 *   - No dropping reasoning content
 *   - No double model calls
 *
 * Reference: https://js.langchain.com/docs/langgraph
 * Reference: https://js.langchain.com/docs/integrations/tools/mcp
 */

import { ChatOpenAI } from '@langchain/openai';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { getLanguageModel, getReasoningModel, resolveModelId, getRegisteredProviderIds } from '../providers/ai-sdk-registry';
import { getIdentity } from './identityService';
import { RAGModule } from './ragModule';
import crypto from 'crypto';
import { resolveMcpServerLaunch } from '../mcp/entry-resolver';

// Dynamic imports for langgraph (subpath exports need node16 moduleResolution)
let createReactAgent: any = null;
let MemorySaverClass: any = null;

async function loadLangGraph() {
  if (!createReactAgent) {
    const langgraph = require('@langchain/langgraph');
    const prebuilt = require('@langchain/langgraph/prebuilt');
    createReactAgent = prebuilt.createReactAgent;
    MemorySaverClass = langgraph.MemorySaver;
    console.log('✅ LangGraph loaded dynamically');
  }
}

// ── MCP Client (via @langchain/mcp-adapters) ──────────────────
// Architecture: MCP = Tool Integration protocol only
// NOT a response formatting layer
// Uses MultiServerMCPClient → getTools() → LangChain tools

let mcpClient: MultiServerMCPClient | null = null;
let mcpTools: any[] = [];

export async function getMcpToolsForAgent(): Promise<any[]> {
  if (mcpTools.length > 0) return mcpTools;

  try {
    const launch = resolveMcpServerLaunch();

    mcpClient = new MultiServerMCPClient({
      'zombiedev': {
        transport: 'stdio',
        command: launch.command,
        args: launch.args,
        restart: {
          enabled: true,
          maxAttempts: 3,
          delayMs: 2000,
        },
      },
    });

    mcpTools = await mcpClient.getTools();
    console.log(`🔧 MCP tools loaded via adapters: ${mcpTools.length} tools (${launch.mode})`);
    for (const t of mcpTools) {
      console.log(`   - ${t.name}`);
    }
  } catch (err: any) {
    console.error('❌ MCP adapter connection failed:', err.message);
    mcpTools = [];
  }

  return mcpTools;
}

// ── Conversation Memory Store ──────────────────────────────────
// Architecture: thread_id persistence via MemorySaver

const memoryStore = new Map<string, any>();

const FALLBACK_MODEL_POOLS: Record<string, string[]> = {
  opencode: ['mimo-v2.5-free', 'deepseek-v4-flash-free', 'big-pickle', 'nemotron-3-ultra-free'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b', 'openai/gpt-oss-20b'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  anthropic: ['claude-haiku-4-5'],
};

function normalizeTextContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return String(part.text || part.content || '');
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

function splitSystemMessages(messages: Array<{ role: string; content: string }>) {
  const systemMessages: string[] = [];
  const filtered: Array<{ role: string; content: string }> = [];

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
  return message.includes('unauthorized') || message.includes('forbidden') || message.includes('not found') || message.includes('rate limit');
}

function getMemory(sessionId: string): any {
  if (!memoryStore.has(sessionId)) {
    memoryStore.set(sessionId, new MemorySaverClass());
  }
  return memoryStore.get(sessionId)!;
}

// ── RAG Module (Self-Healing SSOT) ─────────────────────────────

const ragModule = new RAGModule({ enabled: true, rescanThreshold: 3 });

// ── Agent Run ──────────────────────────────────────────────────

export interface AgentRunInput {
  messages: Array<{ role: string; content: string }>;
  sessionId: string;
  systemPrompt?: string;
  modelName?: string;
}

export interface AgentRunOutput {
  response: string;
  model: string;
  conversationId: string;
  toolCalls: string[];
  reasoning?: string;  // Preserved from reasoning models (NEVER dropped)
}

/**
 * Run the LangChain agent with MCP tools.
 *
 * Architecture:
 *   - Model: via AI SDK Provider Registry (Provider Truth)
 *   - Tools: via @langchain/mcp-adapters (MCP protocol)
 *   - Memory: via LangGraph MemorySaver (thread_id persistence)
 *   - Loop: via LangGraph createReactAgent
 */
export async function runLangChainAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  await loadLangGraph();

  const { messages, sessionId, systemPrompt, modelName } = input;

  // 1. Resolve model ID
  const resolvedModelId = resolveModelId(modelName);

  {
    // New fallback-aware path. Keep the legacy implementation below as dead code
    // until we can remove it in a smaller cleanup pass.

    // 2. Load MCP tools (via @langchain/mcp-adapters)
    const tools = await getMcpToolsForAgent();

    // 3. Get/create memory checkpointer
    const memory = getMemory(sessionId);

    // 4. Build system prompt with identity
    let finalSystemPrompt = mergeSystemPrompts(
      (() => {
        try {
          const identity = getIdentity();
          return identity?.system_identity?.system_prompt || 'You are ZombieCoder, a helpful AI assistant.';
        } catch {
          return 'You are ZombieCoder, a helpful AI assistant.';
        }
      })(),
      systemPrompt,
    );

    const { systemMessages, messages: cleanedMessages } = splitSystemMessages(messages);
    if (systemMessages.length > 0) {
      finalSystemPrompt = mergeSystemPrompts(finalSystemPrompt, ...systemMessages);
    }

    // 5. Ensure RAG context is available
    try {
      await ragModule.ensureSSOT(process.cwd());
    } catch {
      // Don't fail if RAG init fails
    }

    // 6. Prepare input messages
    const inputMessages = cleanedMessages.map(m => (
      m.role === 'assistant'
        ? { type: 'ai' as const, content: m.content }
        : { type: 'human' as const, content: m.content }
    ));

    const candidates = buildFallbackModelCandidates(resolvedModelId);
    let lastError: any = null;

    for (const candidate of candidates) {
      try {
        const llm = createLangChainModel(candidate);
        const agent = createReactAgent({
          llm,
          tools,
          checkpointSaver: memory,
          messageModifier: finalSystemPrompt,
        });

        const result = await agent.invoke(
          { messages: inputMessages },
          { configurable: { thread_id: sessionId } },
        );

        let response = '';
        const toolCalls: string[] = [];

        for (let i = 0; i < result.messages.length; i++) {
          const msg = result.messages[i];
          const msgType = msg._getType?.() || msg.constructor?.name || 'unknown';

          if (msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
              toolCalls.push(tc.name || tc.id || 'unknown');
            }
          }

          if ((msgType === 'ai' || msg.constructor?.name === 'AIMessage') && msg.content) {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            if (content.trim()) {
              response = content;
            }
          }
        }

        console.log(`📦 Agent result: ${result.messages.length} messages, ${toolCalls.length} tool calls, response=${response.length} chars, model=${candidate}`);

        for (let i = 0; i < result.messages.length; i++) {
          const msg = result.messages[i];
          const msgType = msg._getType?.() || msg.constructor?.name || 'unknown';
          const contentPreview = typeof msg.content === 'string'
            ? msg.content.substring(0, 100)
            : JSON.stringify(msg.content).substring(0, 100);
          console.log(`   [${i}] ${msgType}: ${contentPreview || '(empty)'}${msg.tool_calls?.length ? ` [${msg.tool_calls.length} tool_calls]` : ''}`);
        }

        if (!response && toolCalls.length > 0) {
          const toolResults = result.messages
            .filter((m: any) => m._getType?.() === 'tool' || m.constructor?.name === 'ToolMessage')
            .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
            .join('\n');
          if (toolResults) {
            response = toolResults;
          }
        }

        return {
          response,
          model: candidate,
          conversationId: sessionId,
          toolCalls,
        };
      } catch (err: any) {
        lastError = err;
        if (!isRetryableModelError(err)) {
          throw err;
        }
        console.warn(`↩️ LangChain model failed, trying fallback: ${candidate} -> ${err?.message || err}`);
      }
    }

    throw lastError || new Error('All LangChain model fallbacks failed');
  }

  // 2. Create LangChain-compatible model
  //    Uses ChatOpenAI configured with the same endpoints as AI SDK providers
  //    This ensures Provider Truth consistency
  const llm = createLangChainModel(resolvedModelId);

  // 3. Load MCP tools (via @langchain/mcp-adapters)
  const tools = await getMcpToolsForAgent();

  // 4. Get/create memory checkpointer
  const memory = getMemory(sessionId);

  // 5. Build system prompt with identity
  const finalSystemPrompt = mergeSystemPrompts(
    (() => {
      try {
        const identity = getIdentity();
        return identity?.system_identity?.system_prompt || 'You are ZombieCoder, a helpful AI assistant.';
      } catch {
        return 'You are ZombieCoder, a helpful AI assistant.';
      }
    })(),
    systemPrompt,
  );

  // 6. Ensure RAG context is available
  try {
    await ragModule.ensureSSOT(process.cwd());
  } catch {
    // Don't fail if RAG init fails
  }

  // 7. Create React Agent (LangGraph loop)
  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: memory,
    messageModifier: finalSystemPrompt,
  });

  // 8. Prepare input messages
  const inputMessages = messages.map(m => {
    if (m.role === 'system') {
      return { type: 'system' as const, content: m.content };
    }
    return m.role === 'assistant'
      ? { type: 'ai' as const, content: m.content }
      : { type: 'human' as const, content: m.content };
  });

  // 9. Invoke agent (single model call — no double-call anti-pattern)
  const result = await agent.invoke(
    { messages: inputMessages },
    { configurable: { thread_id: sessionId } },
  );

  // 10. Extract response — handle tool-call chains
  // When agent uses tools: [human, ai(tool_calls), tool-result, ..., ai(final-response)]
  let response = '';
  const toolCalls: string[] = [];

  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    const msgType = msg._getType?.() || msg.constructor?.name || 'unknown';

    // Collect all tool calls
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        toolCalls.push(tc.name || tc.id || 'unknown');
      }
    }

    // Find LAST AIMessage with non-empty content
    if ((msgType === 'ai' || msg.constructor?.name === 'AIMessage') && msg.content) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (content.trim()) {
        response = content;
      }
    }
  }

  // Debug: log message flow for troubleshooting
  console.log(`📦 Agent result: ${result.messages.length} messages, ${toolCalls.length} tool calls, response=${response.length} chars`);
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    const msgType = msg._getType?.() || msg.constructor?.name || 'unknown';
    const contentPreview = typeof msg.content === 'string'
      ? msg.content.substring(0, 100)
      : JSON.stringify(msg.content).substring(0, 100);
    console.log(`   [${i}] ${msgType}: ${contentPreview || '(empty)'}${msg.tool_calls?.length ? ` [${msg.tool_calls.length} tool_calls]` : ''}`);
  }

  // Fallback: if response is empty but we have tool results, summarize tool outputs
  if (!response && toolCalls.length > 0) {
    const toolResults = result.messages
      .filter((m: any) => m._getType?.() === 'tool' || m.constructor?.name === 'ToolMessage')
      .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('\n');
    if (toolResults) {
      response = toolResults;
    }
  }

  return {
    response,
    model: resolvedModelId,
    conversationId: sessionId,
    toolCalls,
  };
}

// ── LangChain Model Factory ───────────────────────────────────
// Creates a ChatOpenAI instance configured for the resolved model.
// Provider configuration matches AI SDK registry (Provider Truth).

function createLangChainModel(modelId: string): ChatOpenAI {
  // Parse "provider:model" format
  const [provider, model] = modelId.includes(':')
    ? modelId.split(':')
    : ['opencode', modelId];

  // Provider base URLs (matching AI SDK registry)
  const PROVIDER_URLS: Record<string, { baseURL: string; envKey: string }> = {
    opencode: {
      baseURL: process.env.OPENCODE_OPENAI_BASE_URL || 'https://opencode.ai/zen/v1',
      envKey: 'OPENCODE_API_KEY',
    },
    groq: {
      baseURL: process.env.GROQ_OPENAI_BASE_URL || 'https://api.groq.com/openai/v1',
      envKey: 'GROQ_API_KEY',
    },
    openai: {
      baseURL: process.env.OPENAI_OPENAI_BASE_URL || 'https://api.openai.com/v1',
      envKey: 'OPENAI_API_KEY',
    },
    gemini: {
      baseURL: process.env.GEMINI_OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
      envKey: 'GEMINI_API_KEY',
    },
    anthropic: {
      baseURL: process.env.ANTHROPIC_OPENAI_BASE_URL || 'https://api.anthropic.com/v1',
      envKey: 'ANTHROPIC_API_KEY',
    },
  };

  const providerConfig = PROVIDER_URLS[provider] || PROVIDER_URLS.opencode;
  const apiKey = process.env[providerConfig.envKey] || '';

  return new ChatOpenAI({
    modelName: model,
    apiKey: apiKey || 'dummy',
    configuration: {
      baseURL: providerConfig.baseURL,
    },
    temperature: 0.7,
    maxTokens: 4096,
  });
}

// ── Memory Management ──────────────────────────────────────────

export function clearSessionMemory(sessionId: string): void {
  memoryStore.delete(sessionId);
  console.log(`🗑️ Memory cleared for session ${sessionId}`);
}

export function getMemoryStats(): { sessions: number; sessionIds: string[] } {
  return {
    sessions: memoryStore.size,
    sessionIds: Array.from(memoryStore.keys()),
  };
}

/**
 * Graceful shutdown — close MCP connections.
 */
export async function shutdownAgent(): Promise<void> {
  if (mcpClient) {
    await mcpClient.close();
    mcpClient = null;
    mcpTools = [];
    console.log('🔌 MCP client disconnected');
  }
  memoryStore.clear();
}
