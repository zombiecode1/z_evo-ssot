// ─── OpenAI Provider ─────────────────────────────────────
// Routes requests to OpenAI API.
// Supports full feature set: streaming, tool calling, vision, audio, embeddings.

import { BaseProvider } from '../base.provider';
import { ChatCompletionParams, ProviderCapabilities, ProviderConfig } from '../types';
import { normalizeOpenAiStreamChunk, parseSseStream } from '../normalizer';

export class OpenAiProvider extends BaseProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    audio: true,
    embeddings: true,
    systemMessages: true,
    multiTurn: true,
    responseFormat: true,
    maxContextWindow: 200000,
    maxOutputTokens: 16384,
  };

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      apiKeyEnv: config.apiKeyEnv || 'OPENAI_API_KEY',
    });
  }

  protected async callApi(params: ChatCompletionParams): Promise<any> {
    const url = this.buildUrl('/chat/completions');
    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens,
      temperature: params.temperature,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty: params.presence_penalty,
      stop: params.stop,
      stream: false,
      ...(params.tools && { tools: params.tools }),
      ...(params.tool_choice && { tool_choice: params.tool_choice }),
      ...(params.user && { user: params.user }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[openai] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    return resp.json();
  }

  protected async *callApiStream(params: ChatCompletionParams): AsyncGenerator<any, void, unknown> {
    const url = this.buildUrl('/chat/completions');
    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens,
      temperature: params.temperature,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty: params.presence_penalty,
      stop: params.stop,
      stream: true,
      ...(params.tools && { tools: params.tools }),
      ...(params.tool_choice && { tool_choice: params.tool_choice }),
      ...(params.user && { user: params.user }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[openai] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    if (!resp.body) {
      throw new Error('[openai] No response body for stream');
    }

    yield* parseSseStream(resp.body, params.model, normalizeOpenAiStreamChunk as any);
  }

  protected async fetchModelsFromApi(): Promise<any[]> {
    const url = this.buildUrl('/models');
    const resp = await fetch(url, {
      headers: this.buildHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`[openai] /models failed: ${resp.status}`);
    }

    const json = await resp.json();
    return Array.isArray(json?.data) ? json.data : [];
  }

  protected override parseModelInfo(raw: any): any {
    return {
      id: raw.id,
      providerId: this.id,
      modelId: raw.id,
      contextWindow: raw.context_window || 128000,
      maxOutputTokens: raw.max_output_tokens || 16384,
      category: this.inferCategory(raw.id),
      inputPricePer1k: 0,
      outputPricePer1k: 0,
      isFree: false,
      supportsTools: !raw.id.includes('embedding'),
      supportsVision: raw.id.includes('vision') || raw.id.includes('gpt-4o'),
      supportsStreaming: true,
      isActive: true,
    };
  }

  private inferCategory(id: string): string {
    const lower = id.toLowerCase();
    if (lower.includes('mini') || lower.includes('flash') || lower.includes('haiku')) return 'fast';
    if (lower.includes('opus') || lower.includes('pro')) return 'powerful';
    if (lower.includes('vision')) return 'vision';
    return 'balanced';
  }
}
