// ─── Groq Provider ───────────────────────────────────────
// Routes requests to Groq API.
// Supports OpenAI-compatible format with streaming, tool calling.
// Includes rate limit awareness and terms-locked model detection.

import { BaseProvider } from '../base.provider';
import { ChatCompletionParams, ProviderCapabilities, ProviderConfig } from '../types';
import { normalizeOpenAiStreamChunk, parseSseStream } from '../normalizer';

export class GroqProvider extends BaseProvider {
  readonly id = 'groq';
  readonly name = 'Groq';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    audio: true,
    embeddings: true,
    systemMessages: true,
    multiTurn: true,
    responseFormat: true,
    maxContextWindow: 131072,
    maxOutputTokens: 32768,
  };

  /** Models that require terms acceptance (auto-disable on error) */
  private termsLockedModels: Set<string> = new Set();

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.groq.com/openai/v1',
      apiKeyEnv: config.apiKeyEnv || 'GROQ_API_KEY',
    });
  }

  protected async callApi(params: ChatCompletionParams): Promise<any> {
    const url = this.buildUrl('/chat/completions');
    const body = this.buildBody(params, false);

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[groq] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;

      // Detect terms-locked models
      if (errText.includes('model_terms_required') || errText.includes('requires terms acceptance')) {
        this.termsLockedModels.add(params.model);
        console.warn(`⚠️ Groq model '${params.model}' is terms-locked. Removing from routing.`);
      }

      throw err;
    }

    return resp.json();
  }

  protected async *callApiStream(params: ChatCompletionParams): AsyncGenerator<any, void, unknown> {
    const url = this.buildUrl('/chat/completions');
    const body = this.buildBody(params, true);

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const err: any = new Error(`[groq] ${resp.status}: ${errText.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }

    if (!resp.body) {
      throw new Error('[groq] No response body for stream');
    }

    yield* parseSseStream(resp.body, params.model, normalizeOpenAiStreamChunk as any);
  }

  protected async fetchModelsFromApi(): Promise<any[]> {
    const url = this.buildUrl('/models');
    const resp = await fetch(url, {
      headers: this.buildHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`[groq] /models failed: ${resp.status}`);
    }

    const json = await resp.json();
    return Array.isArray(json?.data) ? json.data : [];
  }

  /** Check if a model is terms-locked */
  isTermsLocked(model: string): boolean {
    return this.termsLockedModels.has(model);
  }

  private buildBody(params: ChatCompletionParams, stream: boolean): any {
    return {
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens,
      temperature: params.temperature,
      top_p: params.top_p,
      stream,
      ...(params.tools && { tools: params.tools }),
      ...(params.tool_choice && { tool_choice: params.tool_choice }),
    };
  }
}
