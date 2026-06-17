import { GroqService } from './groqService';
import { RouteDecision } from '../types';

type RouteKey = 'chat' | 'code' | 'rag' | 'guard';

const ROUTE_PREFERENCES: Record<RouteKey, { models: string[]; needsRag: boolean; confidence: number }> = {
  chat: {
    models: [
      // OpenCode free models (highest priority — free, fast, capable)
      'big-pickle',
      'deepseek-v4-flash-free',
      'mimo-v2.5-free',
      'nemotron-3-ultra-free',
      'minimax-m2.7',
      // OpenCode paid models
      'deepseek-v4-flash',
      'kimi-k2.5',
      'kimi-k2.6',
      'qwen3.7-plus',
      'qwen3.7-max',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gpt-5.3-codex',
      'gpt-5.1-codex',
      'gemini-3.5-flash',
      // Groq / community models (fallback)
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b',
      'groq/compound',
      'qwen/qwen3-32b',
      'llama-3.1-8b-instant',
    ],
    needsRag: false,
    confidence: 0.8,
  },
  code: {
    models: [
      // OpenCode free models first
      'big-pickle',
      'deepseek-v4-flash-free',
      'mimo-v2.5-free',
      'nemotron-3-ultra-free',
      'minimax-m2.7',
      // OpenCode paid / capable coding models
      'deepseek-v4-flash',
      'kimi-k2.5',
      'kimi-k2.6',
      'qwen3.7-plus',
      'qwen3.7-max',
      'gpt-5.3-codex',
      'gpt-5.1-codex',
      'claude-sonnet-4-6',
      'gemini-3.5-flash',
      // Groq / community fallback
      'qwen/qwen3-32b',
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b',
    ],
    needsRag: false,
    confidence: 0.75,
  },
  rag: {
    models: [
      // OpenCode free models first
      'big-pickle',
      'deepseek-v4-flash-free',
      'mimo-v2.5-free',
      'nemotron-3-ultra-free',
      'minimax-m2.7',
      // OpenCode / community fallback
      'deepseek-v4-flash',
      'kimi-k2.5',
      'claude-sonnet-4-6',
      'gemini-3.5-flash',
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b',
      'groq/compound',
      'qwen/qwen3-32b',
    ],
    needsRag: true,
    confidence: 0.7,
  },
  guard: {
    models: [
      'openai/gpt-oss-safeguard-20b',
      'big-pickle',
      'deepseek-v4-flash-free',
      'meta-llama/llama-prompt-guard-2-86m',
      'meta-llama/llama-prompt-guard-2-22m',
    ],
    needsRag: false,
    confidence: 0.7,
  },
};

export class MawlanaRouter {
  constructor(private groq: GroqService) {}

  private availableModelSet(): Set<string> {
    return new Set(this.groq.getModels().map(m => m.id));
  }

  private pickFirstAvailable(preferred: string[]): string | null {
    const available = this.availableModelSet();
    for (const id of preferred) {
      if (available.has(id)) return id;
    }
    // As a last resort, pick the first known model (deterministic).
    const first = this.groq.getModels()[0]?.id;
    return first || null;
  }

  async route(
    messages: { role: string; content: string }[],
    preferredCategory?: string,
  ): Promise<RouteDecision> {
    const prefKey = (preferredCategory || '').toLowerCase() as RouteKey;
    if (prefKey && (ROUTE_PREFERENCES as any)[prefKey]) {
      const model = this.pickFirstAvailable(ROUTE_PREFERENCES[prefKey].models) || 'mimo-v2.5-free';
      return {
        model,
        category: prefKey,
        needsRag: ROUTE_PREFERENCES[prefKey].needsRag,
        confidence: ROUTE_PREFERENCES[prefKey].confidence,
      };
    }

    const lastMsg = messages[messages.length - 1]?.content || '';
    if (lastMsg.length < 15) {
      const model = this.pickFirstAvailable(ROUTE_PREFERENCES.chat.models) || 'mimo-v2.5-free';
      return { model, category: 'chat', needsRag: false, confidence: 0.75 };
    }

    const categories: RouteKey[] = ['chat', 'code', 'rag', 'guard'];
    const detected = await this.classifyWithSmallModel(lastMsg, categories);
    const pref = ROUTE_PREFERENCES[detected] || ROUTE_PREFERENCES.chat;
    const model = this.pickFirstAvailable(pref.models) || 'mimo-v2.5-free';
    return { model, category: detected, needsRag: pref.needsRag, confidence: pref.confidence };
  }

  private async classifyWithSmallModel(input: string, categories: string[]): Promise<RouteKey> {
    const classifierModel =
      this.pickFirstAvailable(['mimo-v2.5-free', 'big-pickle', 'deepseek-v4-flash-free', 'nemotron-3-ultra-free', 'llama-3.1-8b-instant', 'groq/compound-mini', 'allam-2-7b']) ||
      this.pickFirstAvailable(ROUTE_PREFERENCES.chat.models) ||
      'mimo-v2.5-free';

    try {
      const response = await this.groq.createChatCompletion({
        model: classifierModel,
        messages: [
          {
            role: 'system',
            content: [
              'You are a classifier. Read the user message and respond with ONLY a JSON object.',
              'Valid categories: ' + categories.join(', '),
              'Example: {"category":"chat"}',
              'No explanation. No extra keys.',
            ].join('\n'),
          },
          { role: 'user', content: input } as any,
        ],
        max_tokens: 50,
        temperature: 0,
        stream: false,
      });

      const text = (response as any).choices?.[0]?.message?.content || '';
      const match = text.match(/"category"\s*:\s*"([a-zA-Z]+)"/);
      const category = (match?.[1] || 'chat').toLowerCase();
      if (categories.includes(category)) return category as RouteKey;
      return 'chat';
    } catch {
      return 'chat';
    }
  }

  getAllRoutes(): Record<string, RouteDecision> {
    const out: Record<string, RouteDecision> = {};
    (Object.keys(ROUTE_PREFERENCES) as RouteKey[]).forEach((k) => {
      const model = this.pickFirstAvailable(ROUTE_PREFERENCES[k].models) || 'mimo-v2.5-free';
      out[k] = {
        model,
        category: k,
        needsRag: ROUTE_PREFERENCES[k].needsRag,
        confidence: ROUTE_PREFERENCES[k].confidence,
      };
    });
    return out;
  }
}
