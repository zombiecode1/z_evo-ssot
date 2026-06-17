/**
 * ResponseNormalizer — Standardizes LLM responses across providers
 *
 * Problem: Different OpenAI-compatible providers return responses in slightly
 * different formats. When switching models at runtime, the client may receive
 * inconsistent shapes (e.g. Ollama omits `choices`, Gemini uses `candidates`,
 * Anthropic uses `content[]`).
 *
 * Solution: This module normalizes every provider response into a single
 * OpenAI-compatible shape before it reaches the controller layer.
 *
 * Providers handled:
 *   - Groq / OpenAI standard:  { choices: [{ message: { content } }] }
 *   - Ollama:                  { message: { content } }  (no choices)
 *   - Gemini:                  { candidates: [{ content: { parts: [{ text }] } }] }
 *   - Anthropic:               { content: [{ text }] }
 *   - Zen / OpenCode:          standard or streaming SSE
 */

// ─── Standard Response Shape ──────────────────────────────────
// Every provider gets mapped to this shape.

export interface NormalizedChoice {
  index: number;
  message: {
    role: 'assistant' | 'system' | 'user';
    content: string;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | null;
}

export interface NormalizedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface NormalizedResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: NormalizedChoice[];
  usage: NormalizedUsage;
  provider?: string;
}

// ─── Stream Chunk Shape ───────────────────────────────────────

export interface NormalizedStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

// ─── Provider Detection ───────────────────────────────────────
// Best-effort detection based on response shape.

export type ProviderType =
  | 'openai'      // Groq, OpenCode Zen, standard OpenAI-compatible
  | 'ollama'      // Ollama local
  | 'gemini'      // Google Gemini REST
  | 'anthropic'   // Anthropic Messages API
  | 'unknown';

export function detectProvider(raw: any): ProviderType {
  if (!raw || typeof raw !== 'object') return 'unknown';

  // Gemini: has `candidates` array
  if (Array.isArray(raw.candidates) && raw.candidates[0]?.content?.parts) {
    return 'gemini';
  }

  // Anthropic: has `content` as array of blocks
  if (Array.isArray(raw.content) && raw.content[0]?.type === 'text') {
    return 'anthropic';
  }

  // Ollama: has `message` at top level but no `choices`
  if (raw.message && raw.message.content && !raw.choices) {
    return 'ollama';
  }

  // OpenAI-compatible: has `choices` array
  if (Array.isArray(raw.choices)) {
    return 'openai';
  }

  return 'unknown';
}

// ─── Content Extraction ───────────────────────────────────────
// Pulls the assistant message text from any provider shape.

function extractContent(raw: any, provider: ProviderType): string {
  switch (provider) {
    case 'openai':
      return raw.choices?.[0]?.message?.content ?? '';

    case 'ollama':
      return raw.message?.content ?? '';

    case 'gemini':
      return raw.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    case 'anthropic': {
      const block = raw.content?.find((b: any) => b.type === 'text');
      return block?.text ?? '';
    }

    default:
      // Fallback: try common paths
      return (
        raw.choices?.[0]?.message?.content ??
        raw.message?.content ??
        raw.candidates?.[0]?.content?.parts?.[0]?.text ??
        raw.content?.[0]?.text ??
        (typeof raw === 'string' ? raw : '')
      );
  }
}

// ─── Usage Extraction ─────────────────────────────────────────

function extractUsage(raw: any, provider: ProviderType): NormalizedUsage {
  const zero: NormalizedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  switch (provider) {
    case 'openai':
      if (raw.usage) {
        return {
          prompt_tokens: raw.usage.prompt_tokens ?? 0,
          completion_tokens: raw.usage.completion_tokens ?? 0,
          total_tokens: raw.usage.total_tokens ?? 0,
        };
      }
      return zero;

    case 'ollama':
      // Ollama returns prompt_eval_count / eval_count
      if (raw.prompt_eval_count != null || raw.eval_count != null) {
        const prompt = raw.prompt_eval_count ?? 0;
        const completion = raw.eval_count ?? 0;
        return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
      }
      // Also check standard usage key
      if (raw.usage) {
        return {
          prompt_tokens: raw.usage.prompt_tokens ?? 0,
          completion_tokens: raw.usage.completion_tokens ?? 0,
          total_tokens: raw.usage.total_tokens ?? 0,
        };
      }
      return zero;

    case 'gemini':
      if (raw.usageMetadata) {
        return {
          prompt_tokens: raw.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: raw.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: raw.usageMetadata.totalTokenCount ?? 0,
        };
      }
      return zero;

    case 'anthropic':
      if (raw.usage) {
        return {
          prompt_tokens: raw.usage.input_tokens ?? 0,
          completion_tokens: raw.usage.output_tokens ?? 0,
          total_tokens: (raw.usage.input_tokens ?? 0) + (raw.usage.output_tokens ?? 0),
        };
      }
      return zero;

    default:
      return raw.usage ? {
        prompt_tokens: raw.usage.prompt_tokens ?? 0,
        completion_tokens: raw.usage.completion_tokens ?? 0,
        total_tokens: raw.usage.total_tokens ?? 0,
      } : zero;
  }
}

// ─── Finish Reason Mapping ────────────────────────────────────

function normalizeFinishReason(raw: any, provider: ProviderType): NormalizedChoice['finish_reason'] {
  let reason: string | null = null;

  switch (provider) {
    case 'openai':
      reason = raw.choices?.[0]?.finish_reason ?? null;
      break;
    case 'ollama':
      // Ollama may use `done_reason` or `finish_reason`
      reason = raw.done_reason ?? raw.choices?.[0]?.finish_reason ?? null;
      break;
    case 'gemini':
      // Gemini uses STOP or MAX_TOKENS
      if (raw.candidates?.[0]?.finishReason) {
        const gr = raw.candidates[0].finishReason;
        if (gr === 'STOP') reason = 'stop';
        else if (gr === 'MAX_TOKENS') reason = 'length';
        else if (gr === 'SAFETY') reason = 'stop';
        else reason = 'stop';
      }
      break;
    case 'anthropic':
      reason = raw.stop_reason === 'end_turn' ? 'stop' : raw.stop_reason ?? 'stop';
      break;
    default:
      reason = raw.choices?.[0]?.finish_reason ?? 'stop';
  }

  if (reason === 'stop' || reason === 'length' || reason === 'tool_calls') {
    return reason;
  }
  return 'stop';
}

// ─── ID Generation ────────────────────────────────────────────

function extractId(raw: any, provider: ProviderType): string {
  if (raw.id) return String(raw.id);

  // Ollama has no id, generate one
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Main Normalizer ──────────────────────────────────────────

export class ResponseNormalizer {

  /**
   * Normalize any provider response into OpenAI-compatible shape.
   *
   * @param raw     - The raw response object from any provider
   * @param model   - The model name to stamp on the response
   * @param provider - Optional explicit provider hint (auto-detected if omitted)
   * @returns Normalized OpenAI-compatible response
   */
  static normalize(raw: any, model: string, provider?: ProviderType): NormalizedResponse {
    if (!raw || typeof raw !== 'object') {
      return {
        id: `chatcmpl-${Date.now()}-empty`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        provider: 'unknown',
      };
    }

    const detected = provider ?? detectProvider(raw);
    const content = extractContent(raw, detected);
    const usage = extractUsage(raw, detected);
    const finishReason = normalizeFinishReason(raw, detected);
    const id = extractId(raw, detected);

    return {
      id,
      object: 'chat.completion',
      created: raw.created ?? Math.floor(Date.now() / 1000),
      model: raw.model ?? model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      }],
      usage,
      provider: detected,
    };
  }

  /**
   * Extract content from any provider response (quick path).
   * Use this when you only need the text, not the full normalized shape.
   */
  static extractContent(raw: any, provider?: ProviderType): string {
    const detected = provider ?? detectProvider(raw);
    return extractContent(raw, detected);
  }

  /**
   * Normalize a streaming SSE chunk from any provider.
   * Returns null if the chunk should be skipped (e.g. [DONE] marker).
   */
  static normalizeChunk(raw: any, model: string, provider?: ProviderType): NormalizedStreamChunk | null {
    if (!raw || typeof raw !== 'object') return null;

    // Skip [DONE] or empty chunks
    if (raw.data === '[DONE]' || raw.data === null) return null;

    const detected = provider ?? detectProvider(raw);
    const id = raw.id || `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    switch (detected) {
      case 'openai':
        return {
          id,
          object: 'chat.completion.chunk',
          created: raw.created ?? Math.floor(Date.now() / 1000),
          model: raw.model ?? model,
          choices: (raw.choices ?? []).map((c: any) => ({
            index: c.index ?? 0,
            delta: c.delta ?? { content: '' },
            finish_reason: c.finish_reason ?? null,
          })),
        };

      case 'ollama': {
        // Ollama streaming emits `message.content` per chunk
        const content = raw.message?.content ?? '';
        return {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: raw.model ?? model,
          choices: [{
            index: 0,
            delta: { content },
            finish_reason: raw.done ? 'stop' : null,
          }],
        };
      }

      case 'gemini': {
        const text = raw.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: text },
            finish_reason: raw.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : null,
          }],
        };
      }

      default:
        // Try OpenAI-compatible path as fallback
        if (raw.choices?.[0]?.delta?.content !== undefined) {
          return {
            id,
            object: 'chat.completion.chunk',
            created: raw.created ?? Math.floor(Date.now() / 1000),
            model: raw.model ?? model,
            choices: [{
              index: 0,
              delta: raw.choices[0].delta,
              finish_reason: raw.choices[0].finish_reason ?? null,
            }],
          };
        }
        return null;
    }
  }

  /**
   * Strip <think>...</think> blocks from model output.
   * Many reasoning models wrap their thinking in these tags.
   */
  static stripThinkBlocks(text: string): string {
    if (!text) return text;
    return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
  }

  /**
   * Get a human-readable provider name for logging.
   */
  static providerLabel(provider: ProviderType): string {
    switch (provider) {
      case 'openai': return 'OpenAI-compatible';
      case 'ollama': return 'Ollama';
      case 'gemini': return 'Gemini';
      case 'anthropic': return 'Anthropic';
      default: return 'Unknown';
    }
  }
}
