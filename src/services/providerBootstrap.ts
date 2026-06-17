// ─── Provider Bootstrap Script ────────────────────────────
// Runs on startup to discover providers from environment variables,
// sync their models, and register their capabilities/tools.
// This ensures the database is always populated with available providers.
//
// Architecture: Uses AI SDK Provider Registry (ai-sdk-registry.ts) for model calls.
// Old provider implementations (base.provider.ts, implementations/) are NO LONGER USED.
// This file only handles DB population (providers, models, tools).

import { getStateDb, upsertProvider, upsertProviderModel, upsertProviderTool, listProviders } from '../services/stateDb';

// ─── Provider Definitions ────────────────────────────────
// Each provider defines how to discover it from env vars

interface ProviderDef {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKeyEnv: string;
  priority: number;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    vision: boolean;
    audio: boolean;
    embeddings: boolean;
    systemMessages: boolean;
  };
  tools: Array<{ name: string; type: string; description: string }>;
}

const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    type: 'opencode',
    baseUrl: process.env.OPENCODE_OPENAI_BASE_URL || 'https://opencode.ai/zen/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    priority: 100,
    capabilities: { streaming: true, toolCalling: true, vision: true, audio: false, embeddings: false, systemMessages: true },
    tools: [
      { name: 'chat', type: 'chat', description: 'Chat completion' },
      { name: 'stream', type: 'streaming', description: 'Streaming chat' },
      { name: 'tools', type: 'tool_call', description: 'Tool/function calling' },
      { name: 'vision', type: 'vision', description: 'Image understanding' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    type: 'groq',
    baseUrl: process.env.GROQ_OPENAI_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    priority: 90,
    capabilities: { streaming: true, toolCalling: true, vision: true, audio: true, embeddings: true, systemMessages: true },
    tools: [
      { name: 'chat', type: 'chat', description: 'Chat completion' },
      { name: 'stream', type: 'streaming', description: 'Streaming chat' },
      { name: 'tools', type: 'tool_call', description: 'Tool/function calling' },
      { name: 'vision', type: 'vision', description: 'Image understanding' },
      { name: 'audio', type: 'audio', description: 'Speech-to-text (Whisper)' },
      { name: 'embeddings', type: 'embedding', description: 'Text embeddings' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: process.env.OPENAI_OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    priority: 80,
    capabilities: { streaming: true, toolCalling: true, vision: true, audio: true, embeddings: true, systemMessages: true },
    tools: [
      { name: 'chat', type: 'chat', description: 'Chat completion' },
      { name: 'stream', type: 'streaming', description: 'Streaming chat' },
      { name: 'tools', type: 'tool_call', description: 'Tool/function calling' },
      { name: 'vision', type: 'vision', description: 'Image understanding' },
      { name: 'audio', type: 'audio', description: 'Speech-to-text & text-to-speech' },
      { name: 'embeddings', type: 'embedding', description: 'Text embeddings' },
      { name: 'images', type: 'image_gen', description: 'Image generation (DALL-E)' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    type: 'gemini',
    baseUrl: process.env.GEMINI_OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    priority: 70,
    capabilities: { streaming: true, toolCalling: true, vision: true, audio: false, embeddings: true, systemMessages: true },
    tools: [
      { name: 'chat', type: 'chat', description: 'Chat completion' },
      { name: 'stream', type: 'streaming', description: 'Streaming chat' },
      { name: 'tools', type: 'tool_call', description: 'Tool/function calling' },
      { name: 'vision', type: 'vision', description: 'Image understanding' },
      { name: 'embeddings', type: 'embedding', description: 'Text embeddings' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: process.env.ANTHROPIC_OPENAI_BASE_URL || 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    priority: 65,
    capabilities: { streaming: true, toolCalling: true, vision: true, audio: false, embeddings: false, systemMessages: true },
    tools: [
      { name: 'chat', type: 'chat', description: 'Chat completion' },
      { name: 'stream', type: 'streaming', description: 'Streaming chat' },
      { name: 'tools', type: 'tool_call', description: 'Tool/function calling' },
      { name: 'vision', type: 'vision', description: 'Image understanding' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'ollama',
    baseUrl: process.env.OLLAMA_OPENAI_BASE_URL || 'http://localhost:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    priority: 60,
    capabilities: { streaming: true, toolCalling: true, vision: true, audio: false, embeddings: true, systemMessages: true },
    tools: [
      { name: 'chat', type: 'chat', description: 'Chat completion' },
      { name: 'stream', type: 'streaming', description: 'Streaming chat' },
      { name: 'tools', type: 'tool_call', description: 'Tool/function calling' },
      { name: 'vision', type: 'vision', description: 'Image understanding' },
      { name: 'embeddings', type: 'embedding', description: 'Text embeddings' },
    ],
  },
];

// ─── Known Models per Provider ───────────────────────────
// Models that we know exist even if /models endpoint fails

const KNOWN_MODELS: Record<string, Array<{ id: string; category: string; context_window: number; max_output_tokens: number; is_free: boolean; supports_tools: boolean; supports_vision: boolean }>> = {
  opencode: [
    { id: 'deepseek-v4-flash-free', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'mimo-v2.5-free', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'nemotron-3-ultra-free', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'big-pickle', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'deepseek-v4-flash', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'kimi-k2.5', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'kimi-k2.6', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'qwen3.7-plus', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'qwen3.7-max', category: 'powerful', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'minimax-m2.7', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'claude-sonnet-4-6', category: 'powerful', context_window: 200000, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: true },
    { id: 'claude-haiku-4-5', category: 'fast', context_window: 200000, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: true },
    { id: 'gpt-5.1-codex', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'gpt-5.3-codex', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'gemini-3.5-flash', category: 'fast', context_window: 131072, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: true },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', category: 'balanced', context_window: 131072, max_output_tokens: 32768, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'llama-3.1-8b-instant', category: 'fast', context_window: 131072, max_output_tokens: 131072, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'qwen/qwen3-32b', category: 'balanced', context_window: 131072, max_output_tokens: 40960, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', category: 'balanced', context_window: 131072, max_output_tokens: 8192, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'groq/compound', category: 'balanced', context_window: 131072, max_output_tokens: 8192, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'groq/compound-mini', category: 'fast', context_window: 131072, max_output_tokens: 8192, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'openai/gpt-oss-20b', category: 'balanced', context_window: 131072, max_output_tokens: 65536, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'openai/gpt-oss-120b', category: 'powerful', context_window: 131072, max_output_tokens: 65536, is_free: true, supports_tools: true, supports_vision: false },
    { id: 'allam-2-7b', category: 'fast', context_window: 8192, max_output_tokens: 8192, is_free: true, supports_tools: false, supports_vision: false },
  ],
  openai: [
    { id: 'gpt-4o', category: 'balanced', context_window: 128000, max_output_tokens: 16384, is_free: false, supports_tools: true, supports_vision: true },
    { id: 'gpt-4o-mini', category: 'fast', context_window: 128000, max_output_tokens: 16384, is_free: false, supports_tools: true, supports_vision: true },
    { id: 'gpt-4-turbo', category: 'powerful', context_window: 128000, max_output_tokens: 4096, is_free: false, supports_tools: true, supports_vision: true },
    { id: 'o1', category: 'powerful', context_window: 200000, max_output_tokens: 100000, is_free: false, supports_tools: true, supports_vision: false },
    { id: 'o1-mini', category: 'balanced', context_window: 128000, max_output_tokens: 65536, is_free: false, supports_tools: false, supports_vision: false },
    { id: 'o3-mini', category: 'balanced', context_window: 200000, max_output_tokens: 100000, is_free: false, supports_tools: true, supports_vision: false },
  ],
  gemini: [
    { id: 'gemini-2.0-flash', category: 'fast', context_window: 1048576, max_output_tokens: 8192, is_free: true, supports_tools: true, supports_vision: true },
    { id: 'gemini-2.5-pro', category: 'powerful', context_window: 1048576, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: true },
    { id: 'gemini-2.5-flash', category: 'balanced', context_window: 1048576, max_output_tokens: 65536, is_free: true, supports_tools: true, supports_vision: true },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-6', category: 'powerful', context_window: 200000, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: true },
    { id: 'claude-haiku-4-5', category: 'fast', context_window: 200000, max_output_tokens: 65536, is_free: false, supports_tools: true, supports_vision: true },
    { id: 'claude-3-5-sonnet-20241022', category: 'balanced', context_window: 200000, max_output_tokens: 8192, is_free: false, supports_tools: true, supports_vision: true },
  ],
};

// ─── Bootstrap Function ──────────────────────────────────

export async function bootstrapProviders(): Promise<{
  discovered: number;
  synced: number;
  toolsRegistered: number;
  errors: string[];
}> {
  const db = getStateDb();
  if (!db) return { discovered: 0, synced: 0, toolsRegistered: 0, errors: ['Database not initialized'] };

  const result = { discovered: 0, synced: 0, toolsRegistered: 0, errors: [] as string[] };

  for (const def of PROVIDER_DEFS) {
    try {
      // Check if API key is available
      const apiKey = process.env[def.apiKeyEnv] || '';
      const hasKey = apiKey.trim().length > 0;

      // Check if provider already exists in DB
      const existing = db.prepare(`SELECT id FROM providers WHERE id = ?`).get(def.id) as any;

      // Upsert provider (always, to update capabilities)
      upsertProvider(db, {
        id: def.id,
        name: def.name,
        type: def.type,
        base_url: def.baseUrl,
        api_key_env: def.apiKeyEnv,
        priority: def.priority,
        is_active: hasKey,
        capabilities: def.capabilities,
      });

      result.discovered++;

      // Register tools for this provider
      for (const tool of def.tools) {
        const toolId = `${def.id}:${tool.name}`;
        upsertProviderTool(db, {
          id: toolId,
          provider_id: def.id,
          tool_name: tool.name,
          tool_type: tool.type,
          description: tool.description,
          is_available: hasKey,
        });
        result.toolsRegistered++;
      }

      // If has API key, try to sync models from API
      if (hasKey) {
        try {
          const models = await fetchModelsFromProvider(def);
          for (const m of models) {
            const modelId = `${def.id}:${m.id}`;
            upsertProviderModel(db, {
              id: modelId,
              provider_id: def.id,
              model_id: m.id,
              context_window: m.context_window || 0,
              max_output_tokens: m.max_output_tokens || 0,
              category: m.category || 'other',
              is_free: m.is_free || false,
              supports_tools: m.supports_tools || false,
              supports_vision: m.supports_vision || false,
              supports_streaming: true,
            });
            result.synced++;
          }
        } catch (err: any) {
          // If API sync fails, use known models
          const known = KNOWN_MODELS[def.id] || [];
          for (const m of known) {
            const modelId = `${def.id}:${m.id}`;
            upsertProviderModel(db, {
              id: modelId,
              provider_id: def.id,
              model_id: m.id,
              context_window: m.context_window,
              max_output_tokens: m.max_output_tokens,
              category: m.category,
              is_free: m.is_free,
              supports_tools: m.supports_tools,
              supports_vision: m.supports_vision,
              supports_streaming: true,
            });
            result.synced++;
          }
        }
      } else {
        // No API key — still register known models as inactive
        const known = KNOWN_MODELS[def.id] || [];
        for (const m of known) {
          const modelId = `${def.id}:${m.id}`;
          upsertProviderModel(db, {
            id: modelId,
            provider_id: def.id,
            model_id: m.id,
            context_window: m.context_window,
            max_output_tokens: m.max_output_tokens,
            category: m.category,
            is_free: m.is_free,
            supports_tools: m.supports_tools,
            supports_vision: m.supports_vision,
            supports_streaming: true,
            is_active: false,
          });
          result.synced++;
        }
      }
    } catch (err: any) {
      result.errors.push(`${def.id}: ${err.message}`);
    }
  }

  console.log(`✅ Bootstrap: ${result.discovered} providers, ${result.synced} models, ${result.toolsRegistered} tools`);
  if (result.errors.length > 0) {
    console.warn(`⚠️ Bootstrap errors: ${result.errors.join('; ')}`);
  }

  return result;
}

// ─── Fetch Models from Provider API ──────────────────────

async function fetchModelsFromProvider(def: ProviderDef): Promise<Array<{
  id: string; category: string; context_window: number; max_output_tokens: number;
  is_free: boolean; supports_tools: boolean; supports_vision: boolean;
}>> {
  const apiKey = process.env[def.apiKeyEnv] || '';
  const baseUrl = def.baseUrl.replace(/\/+$/, '');

  const resp = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const json = await resp.json();
  const data = Array.isArray(json?.data) ? json.data : [];

  return data.map((m: any) => {
    const id = String(m.id || '').trim();
    const category = inferCategory(id);
    return {
      id,
      category,
      context_window: m.context_window ?? inferContextWindow(category, id),
      max_output_tokens: m.max_tokens ?? inferMaxTokens(category, id),
      is_free: def.id === 'opencode' || def.id === 'groq',
      supports_tools: !id.includes('embed') && !id.includes('whisper') && !id.includes('guard'),
      supports_vision: id.includes('vision') || id.includes('gpt-4o'),
    };
  }).filter((m: any) => m.id);
}

// ─── Helpers ─────────────────────────────────────────────

function inferCategory(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes('guard') || lower.includes('safeguard')) return 'guard';
  if (lower.includes('whisper') || lower.includes('tts') || lower.includes('audio')) return 'audio';
  if (lower.includes('embed')) return 'embedding';
  if (lower.includes('vision')) return 'vision';
  // OpenCode models: deepseek, mimo, big-pickle, nemotron, kimi, qwen, minimax, claude, gpt, gemini
  if (lower.startsWith('deepseek-') || lower.startsWith('mimo-') || lower.startsWith('big-pickle') || lower.startsWith('nemotron-') || lower.startsWith('kimi-') || lower.startsWith('qwen3') || lower.startsWith('minimax-') || lower.startsWith('claude-') || lower.startsWith('gpt-') || lower.startsWith('gemini-')) return 'balanced';
  if (lower.includes('mini') || lower.includes('flash') || lower.includes('haiku') || lower.includes('8b') || lower.includes('1b') || lower.includes('instant')) return 'fast';
  if (lower.includes('70b') || lower.includes('120b') || lower.includes('opus') || lower.includes('pro') || lower.includes('max')) return 'powerful';
  return 'balanced';
}

function inferContextWindow(category: string, modelId: string): number {
  if (category === 'audio' || category === 'embedding') return 0;
  if (category === 'guard') return 512;
  if (modelId.toLowerCase().includes('gemini')) return 1048576;
  if (modelId.toLowerCase().includes('claude')) return 200000;
  return 131072;
}

function inferMaxTokens(category: string, modelId: string): number {
  if (category === 'audio' || category === 'embedding') return 0;
  if (category === 'guard') return 512;
  // OpenCode models: deepseek, mimo, big-pickle, nemotron, kimi, qwen, minimax, claude, gpt, gemini
  const lower = modelId.toLowerCase();
  if (lower.startsWith('deepseek-') || lower.startsWith('mimo-') || lower.startsWith('big-pickle') || lower.startsWith('nemotron-') || lower.startsWith('kimi-') || lower.startsWith('qwen3') || lower.startsWith('minimax-') || lower.startsWith('claude-') || lower.startsWith('gpt-') || lower.startsWith('gemini-')) return 65536;
  if (category === 'fast') return 8192;
  return 32768;
}
