// ─── OpenCode Provider ───────────────────────────────────
// Routes requests to OpenCode Zen API (free/paid catalog).
// Supports OpenAI-compatible format with streaming.

import { BaseProvider } from '../base.provider';
import { ChatCompletionParams, ProviderCapabilities, ProviderConfig } from '../types';
import { normalizeOpenAiStreamChunk, parseSseStream } from '../normalizer';

export class OpenCodeProvider extends BaseProvider {
  readonly id = 'opencode';
  readonly name = 'OpenCode';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    audio: false,
    embeddings: false,
    systemMessages: true,
    multiTurn: true,
    responseFormat: true,
    maxContextWindow: 131072,
    maxOutputTokens: 65536,
  };

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://opencode.ai/zen/v1',
      apiKeyEnv: config.apiKeyEnv || 'OPENCODE_API_KEY',
    });
  }

  protected async callApi(params: ChatCompletionParams): Promise<any> {
    const url = this.buildUrl('/chat/completions');
    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens,
      temperature: params.temperature ?? 0.7,
      stream: false,
      ...(params.tools && { tools: params.tools }),
      ...(params.tool_choice && { tool_choice: params.tool_choice }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[opencode] ${resp.status}: ${errText.slice(0, 400)}`);
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
      temperature: params.temperature ?? 0.7,
      stream: true,
      ...(params.tools && { tools: params.tools }),
      ...(params.tool_choice && { tool_choice: params.tool_choice }),
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[opencode] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    if (!resp.body) {
      throw new Error('[opencode] No response body for stream');
    }

    yield* parseSseStream(resp.body, params.model, normalizeOpenAiStreamChunk as any);
  }

  protected async fetchModelsFromApi(): Promise<any[]> {
    const url = this.buildUrl('/models');
    const resp = await fetch(url, {
      headers: this.buildHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`[opencode] /models failed: ${resp.status}`);
    }

    const json = await resp.json();
    return Array.isArray(json?.data) ? json.data : [];
  }

  protected override parseModelInfo(raw: any): any {
    return {
      id: raw.id,
      providerId: this.id,
      modelId: raw.id,
      contextWindow: raw.context_window ?? 131072,
      maxOutputTokens: raw.max_tokens ?? 65536,
      category: raw.category || 'balanced',
      inputPricePer1k: raw.input_price_per_1k || 0,
      outputPricePer1k: raw.output_price_per_1k || 0,
      isFree: raw.id?.includes('-free') || false,
      supportsTools: true,
      supportsVision: raw.id?.includes('vision') || true,
      supportsStreaming: true,
      isActive: true,
    };
  }
}
