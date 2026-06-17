// ─── Response Normalizer ──────────────────────────────────
// Converts provider-native responses to OpenAI-compatible format.
// Each provider may return slightly different formats; this module
// ensures a unified output.

import {
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatMessage,
  StreamChunk,
  StreamChoice,
  UsageInfo,
} from './types';

// ─── Ollama Format ───────────────────────────────────────

export interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

export function normalizeOllamaResponse(raw: OllamaChatResponse, model: string): ChatCompletionResponse {
  return {
    id: `chatcmpl-ollama-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: raw.model || model,
    choices: [{
      index: 0,
      message: {
        role: (raw.message?.role as any) || 'assistant',
        content: raw.message?.content ?? null,
      },
      finish_reason: raw.done ? 'stop' : 'length',
    }],
    usage: {
      prompt_tokens: raw.prompt_eval_count || 0,
      completion_tokens: raw.eval_count || 0,
      total_tokens: (raw.prompt_eval_count || 0) + (raw.eval_count || 0),
    },
  };
}

export function* normalizeOllamaStream(rawChunks: any[], model: string): Generator<StreamChunk, void, unknown> {
  for (const chunk of rawChunks) {
    if (!chunk) continue;
    yield {
      id: `chatcmpl-ollama-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: chunk.model || model,
      choices: [{
        index: 0,
        delta: {
          role: chunk.message?.role || 'assistant',
          content: chunk.message?.content || '',
        },
        finish_reason: chunk.done ? 'stop' : null,
      }],
      usage: null,
    };
  }
}

// ─── Anthropic Format ────────────────────────────────────

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

export function normalizeAnthropicResponse(raw: AnthropicResponse, model: string): ChatCompletionResponse {
  const textContent = raw.content
    ?.filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join('') || '';

  return {
    id: raw.id || `chatcmpl-anthropic-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: raw.model || model,
    choices: [{
      index: 0,
      message: {
        role: (raw.role as any) || 'assistant',
        content: textContent || null,
      },
      finish_reason: mapAnthropicStopReason(raw.stop_reason),
    }],
    usage: raw.usage ? {
      prompt_tokens: raw.usage.input_tokens || 0,
      completion_tokens: raw.usage.output_tokens || 0,
      total_tokens: (raw.usage.input_tokens || 0) + (raw.usage.output_tokens || 0),
    } : undefined,
  };
}

function mapAnthropicStopReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | null {
  if (!reason) return null;
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

// ─── Gemini Format ───────────────────────────────────────

export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
}

export function normalizeGeminiResponse(raw: GeminiResponse, model: string): ChatCompletionResponse {
  const candidate = raw.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join('');

  return {
    id: `chatcmpl-gemini-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: raw.modelVersion || model,
    choices: [{
      index: 0,
      message: {
        role: (candidate?.content?.role as any) || 'assistant',
        content: text || null,
      },
      finish_reason: mapGeminiFinishReason(candidate?.finishReason),
    }],
    usage: raw.usageMetadata ? {
      prompt_tokens: raw.usageMetadata.promptTokenCount || 0,
      completion_tokens: raw.usageMetadata.candidatesTokenCount || 0,
      total_tokens: raw.usageMetadata.totalTokenCount || 0,
    } : undefined,
  };
}

function mapGeminiFinishReason(reason?: string): 'stop' | 'length' | 'tool_calls' | null {
  if (!reason) return null;
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  return 'stop';
}

// ─── Generic OpenAI-Compatible ───────────────────────────

/** Normalize any OpenAI-compatible response (most providers) */
export function normalizeOpenAiResponse(raw: any, model: string): ChatCompletionResponse {
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

/** Normalize any OpenAI-compatible stream chunk */
export function normalizeOpenAiStreamChunk(chunk: any, model: string): StreamChunk | null {
  if (!chunk?.choices && !chunk?.id) return null;

  return {
    id: chunk.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: chunk.created || Math.floor(Date.now() / 1000),
    model: chunk.model || model,
    choices: (chunk.choices || []).map((c: any) => ({
      index: c.index ?? 0,
      delta: c.delta || {},
      finish_reason: c.finish_reason || null,
    })),
    usage: chunk.usage || null,
  };
}

// ─── Streaming Parser ────────────────────────────────────

/** Parse SSE stream from any OpenAI-compatible provider */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  normalizer?: (data: any, model: string) => StreamChunk | null,
): AsyncGenerator<StreamChunk, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const chunk = normalizer
            ? normalizer(parsed, model)
            : normalizeOpenAiStreamChunk(parsed, model);
          if (chunk) yield chunk;
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Auto-Detect Normalizer ──────────────────────────────

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'openai-compatible';

/** Auto-detect which normalizer to use based on provider kind */
export function normalizeResponseAuto(raw: any, model: string, kind: ProviderKind = 'openai'): ChatCompletionResponse {
  switch (kind) {
    case 'anthropic':
      return normalizeAnthropicResponse(raw, model);
    case 'gemini':
      return normalizeGeminiResponse(raw, model);
    case 'ollama':
      return normalizeOllamaResponse(raw, model);
    case 'openai':
    case 'openai-compatible':
    default:
      return normalizeOpenAiResponse(raw, model);
  }
}
