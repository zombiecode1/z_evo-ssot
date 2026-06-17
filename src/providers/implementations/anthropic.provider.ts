// ─── Anthropic Provider ──────────────────────────────────
// Routes requests to Anthropic API (Claude models).
// Requires an OpenAI-compatible gateway/proxy.
// Native Anthropic format is handled by normalizer.ts.

import { BaseProvider } from '../base.provider';
import { ChatCompletionParams, ProviderCapabilities, ProviderConfig, ChatMessage } from '../types';
import { normalizeOpenAiResponse, parseSseStream, normalizeAnthropicResponse } from '../normalizer';
import { denormalizeToAnthropicToolCalls, denormalizeToAnthropicToolResults } from '../tool-normalizer';

export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    audio: false,
    embeddings: false,
    systemMessages: true,
    multiTurn: true,
    responseFormat: false,
    maxContextWindow: 200000,
    maxOutputTokens: 65536,
  };

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.anthropic.com',
      apiKeyEnv: config.apiKeyEnv || 'ANTHROPIC_API_KEY',
    });
  }

  protected async callApi(params: ChatCompletionParams): Promise<any> {
    // If using OpenAI-compatible gateway, use standard format
    if (this.isUsingOpenAiGateway()) {
      return this.callOpenAiGateway(params);
    }

    // Native Anthropic format
    return this.callNativeAnthropic(params);
  }

  protected async *callApiStream(params: ChatCompletionParams): AsyncGenerator<any, void, unknown> {
    if (this.isUsingOpenAiGateway()) {
      yield* this.streamOpenAiGateway(params);
      return;
    }

    yield* this.streamNativeAnthropic(params);
  }

  // ─── OpenAI-Compatible Gateway ────────────────────────

  private isUsingOpenAiGateway(): boolean {
    return this.getBaseUrl().includes('/v1') || this.getBaseUrl().includes('/openai');
  }

  private async callOpenAiGateway(params: ChatCompletionParams): Promise<any> {
    const url = this.buildUrl('/chat/completions');
    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens,
      temperature: params.temperature,
      stream: false,
      ...(params.tools && { tools: params.tools }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[anthropic-gateway] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    return resp.json();
  }

  private async *streamOpenAiGateway(params: ChatCompletionParams): AsyncGenerator<any, void, unknown> {
    const url = this.buildUrl('/chat/completions');
    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens,
      temperature: params.temperature,
      stream: true,
      ...(params.tools && { tools: params.tools }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[anthropic-gateway] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    if (!resp.body) {
      throw new Error('[anthropic-gateway] No response body for stream');
    }

    yield* parseSseStream(resp.body, params.model, normalizeOpenAiResponse as any);
  }

  // ─── Native Anthropic Format ──────────────────────────

  private async callNativeAnthropic(params: ChatCompletionParams): Promise<any> {
    const url = `${this.getBaseUrl()}/v1/messages`;
    const { system, messages } = this.splitSystemMessages(params.messages);

    const body: any = {
      model: params.model,
      max_tokens: params.max_tokens || 4096,
      messages,
      ...(system && { system }),
      ...(params.temperature != null && { temperature: params.temperature }),
      ...(params.tools && {
        tools: params.tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters || {},
        })),
      }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.getApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[anthropic] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    const raw = await resp.json();
    return this.convertNativeToOpenAi(raw, params.model);
  }

  private async *streamNativeAnthropic(params: ChatCompletionParams): AsyncGenerator<any, void, unknown> {
    const url = `${this.getBaseUrl()}/v1/messages`;
    const { system, messages } = this.splitSystemMessages(params.messages);

    const body: any = {
      model: params.model,
      max_tokens: params.max_tokens || 4096,
      messages,
      stream: true,
      ...(system && { system }),
      ...(params.temperature != null && { temperature: params.temperature }),
      ...(params.tools && {
        tools: params.tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters || {},
        })),
      }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.getApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[anthropic] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    if (!resp.body) {
      throw new Error('[anthropic] No response body for stream');
    }

    // Parse Anthropic SSE events
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentContent = '';
    let stopReason: string | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          try {
            const event = JSON.parse(data);

            if (event.type === 'content_block_delta' && event.delta?.text) {
              currentContent += event.delta.text;
              yield {
                id: `chatcmpl-anthropic-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: params.model,
                choices: [{
                  index: 0,
                  delta: { content: event.delta.text },
                  finish_reason: null,
                }],
              };
            }

            if (event.type === 'message_delta' && event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
              yield {
                id: `chatcmpl-anthropic-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: params.model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: mapAnthropicStopReason(stopReason),
                }],
              };
            }
          } catch {
            // Skip unparseable events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  private splitSystemMessages(messages: ChatMessage[]): { system: string | undefined; messages: any[] } {
    let system: string | undefined;
    const filtered: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = typeof msg.content === 'string' ? msg.content : undefined;
      } else if (msg.role === 'tool') {
        // Convert tool results to Anthropic format
        filtered.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : '',
          }],
        });
      } else {
        filtered.push({
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : '',
          ...(msg.tool_calls && {
            content: [
              ...(typeof msg.content === 'string' && msg.content ? [{ type: 'text', text: msg.content }] : []),
              ...denormalizeToAnthropicToolCalls(msg.tool_calls),
            ],
          }),
        });
      }
    }

    return { system, messages: filtered };
  }

  private convertNativeToOpenAi(raw: any, model: string): any {
    const textContent = raw.content
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text || '')
      .join('') || '';

    const toolCalls = raw.content
      ?.filter((c: any) => c.type === 'tool_use')
      .map((c: any, i: number) => ({
        id: c.id,
        type: 'function' as const,
        function: {
          name: c.name,
          arguments: JSON.stringify(c.input || {}),
        },
      }));

    return {
      id: raw.id,
      model: raw.model || model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          ...(toolCalls && toolCalls.length > 0 && { tool_calls: toolCalls }),
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

  protected async fetchModelsFromApi(): Promise<any[]> {
    // Anthropic doesn't have a /models endpoint; return known models
    return [
      { id: 'claude-sonnet-4-6', context_window: 200000, max_output_tokens: 65536 },
      { id: 'claude-haiku-4-5', context_window: 200000, max_output_tokens: 65536 },
      { id: 'claude-3-5-sonnet-20241022', context_window: 200000, max_output_tokens: 8192 },
      { id: 'claude-3-5-haiku-20241022', context_window: 200000, max_output_tokens: 8192 },
    ];
  }
}

function mapAnthropicStopReason(reason: string | null): string {
  if (!reason) return 'stop';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}
