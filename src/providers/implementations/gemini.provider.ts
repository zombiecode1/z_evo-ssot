// ─── Gemini Provider ─────────────────────────────────────
// Routes requests to Google Gemini API via OpenAI-compatible endpoint.
// Supports streaming, tool calling, vision.

import { BaseProvider } from '../base.provider';
import { ChatCompletionParams, ProviderCapabilities, ProviderConfig } from '../types';
import { normalizeOpenAiStreamChunk, parseSseStream } from '../normalizer';

export class GeminiProvider extends BaseProvider {
  readonly id = 'gemini';
  readonly name = 'Gemini';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    audio: false,
    embeddings: true,
    systemMessages: true,
    multiTurn: true,
    responseFormat: true,
    maxContextWindow: 1048576,
    maxOutputTokens: 65536,
  };

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyEnv: config.apiKeyEnv || 'GEMINI_API_KEY',
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
      const err: any = new Error(`[gemini] ${resp.status}: ${errText.slice(0, 400)}`);
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
      const err: any = new Error(`[gemini] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    if (!resp.body) {
      throw new Error('[gemini] No response body for stream');
    }

    yield* parseSseStream(resp.body, params.model, normalizeOpenAiStreamChunk as any);
  }

  protected async fetchModelsFromApi(): Promise<any[]> {
    const url = this.buildUrl('/models');
    const resp = await fetch(url, {
      headers: this.buildHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`[gemini] /models failed: ${resp.status}`);
    }

    const json = await resp.json();
    return Array.isArray(json?.data) ? json.data : [];
  }

  protected override parseModelInfo(raw: any): any {
    return {
      id: raw.id,
      providerId: this.id,
      modelId: raw.id,
      contextWindow: raw.context_window || 1048576,
      maxOutputTokens: raw.max_output_tokens || 65536,
      category: this.inferCategory(raw.id),
      inputPricePer1k: 0,
      outputPricePer1k: 0,
      isFree: raw.id?.includes('free') || false,
      supportsTools: true,
      supportsVision: raw.id?.includes('vision') || true,
      supportsStreaming: true,
      isActive: true,
    };
  }

  private inferCategory(id: string): string {
    const lower = id.toLowerCase();
    if (lower.includes('flash') || lower.includes('lite')) return 'fast';
    if (lower.includes('pro')) return 'powerful';
    return 'balanced';
  }
}
