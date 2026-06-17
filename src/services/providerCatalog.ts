import {
  clearModels,
  getModelById,
  getStateDb,
  listLlmSources,
  setModelActive,
  touchModelSync,
  upsertModels,
} from './stateDb';
import { ModelMeta } from '../types';

export type ProviderKind = 'groq' | 'openai-compatible' | 'opencode' | 'ollama' | 'gateway';

export interface ProviderSource {
  name: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeyEnv?: string;
  enabled: boolean;
  priority: number;
  notes?: string;
}

export interface ProviderModelRecord extends ModelMeta {
  provider: string;
  source_name: string;
  source_kind: ProviderKind;
  base_url: string;
  api_key_env?: string | null;
  source_model_id: string;
  status: 'active' | 'disabled' | 'offline' | 'unknown';
  is_active: boolean;
  is_free: boolean;
  sync_status: 'ok' | 'missing-key' | 'offline' | 'error';
  sync_error?: string | null;
  last_synced_at?: string | null;
}

function readEnv(name?: string): string {
  if (!name) return '';
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : '';
}

function trimBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

function openAiCompatiblePath(baseUrl: string): string {
  const trimmed = trimBaseUrl(baseUrl);
  return trimmed.endsWith('/v1') || trimmed.includes('/openai') || trimmed.includes('/zen')
    ? trimmed
    : `${trimmed}/v1`;
}

export function getDefaultSources(): ProviderSource[] {
  const sources: ProviderSource[] = [
    {
      name: 'opencode',
      label: 'OpenCode',
      kind: 'opencode',
      baseUrl: openAiCompatiblePath(process.env.OPENCODE_OPENAI_BASE_URL || 'https://opencode.ai/zen/v1'),
      apiKeyEnv: 'OPENCODE_API_KEY',
      enabled: true,
      priority: 100,
      notes: 'OpenCode Zen free/paid catalog — DEFAULT provider',
    },
    {
      name: 'groq',
      label: 'Groq',
      kind: 'groq',
      baseUrl: openAiCompatiblePath(process.env.GROQ_OPENAI_BASE_URL || 'https://api.groq.com/openai/v1'),
      apiKeyEnv: 'GROQ_API_KEY',
      enabled: true,
      priority: 90,
      notes: 'Groq fallback provider',
    },
    {
      name: 'openai',
      label: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: openAiCompatiblePath(process.env.OPENAI_OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      apiKeyEnv: 'OPENAI_API_KEY',
      enabled: true,
      priority: 80,
    },
    {
      name: 'gemini',
      label: 'Gemini',
      kind: 'openai-compatible',
      baseUrl: openAiCompatiblePath(process.env.GEMINI_OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'),
      apiKeyEnv: 'GEMINI_API_KEY',
      enabled: true,
      priority: 70,
      notes: 'Gemini OpenAI-compatible endpoint from Google AI',
    },
    {
      name: 'ollama',
      label: 'Ollama',
      kind: 'ollama',
      baseUrl: openAiCompatiblePath(process.env.OLLAMA_OPENAI_BASE_URL || 'http://localhost:11434/v1'),
      apiKeyEnv: 'OLLAMA_API_KEY',
      enabled: !!(process.env.OLLAMA_OPENAI_BASE_URL || process.env.OLLAMA_API_KEY),
      priority: 60,
    },
  ];

  const anthropicBase = process.env.ANTHROPIC_OPENAI_BASE_URL || '';
  if (anthropicBase.trim()) {
    sources.push({
      name: 'anthropic',
      label: 'Anthropic Gateway',
      kind: 'gateway',
      baseUrl: openAiCompatiblePath(anthropicBase),
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      enabled: true,
      priority: 65,
      notes: 'Anthropic models exposed through an OpenAI-compatible gateway',
    });
  }

  return sources
    .map((source) => ({ ...source, baseUrl: trimBaseUrl(source.baseUrl) }))
    .sort((a, b) => b.priority - a.priority);
}

export function getConfiguredSources(): ProviderSource[] {
  const db = getStateDb();
  if (!db) return getDefaultSources();

  const dbSources = (listLlmSources(db) || []).map((row: any) => ({
    name: String(row.name),
    label: String(row.name),
    kind: (row.provider_kind || 'openai-compatible') as ProviderKind,
    baseUrl: String(row.base_url),
    apiKeyEnv: row.api_key_env || undefined,
    enabled: row.is_active !== 0,
    priority: Number(row.priority || 0),
    notes: row.health_status ? `health:${row.health_status}` : undefined,
  }));

  const defaults = getDefaultSources();
  const merged = new Map<string, ProviderSource>();
  for (const source of defaults) merged.set(source.name, source);
  for (const source of dbSources) merged.set(source.name, source);
  return Array.from(merged.values()).sort((a, b) => b.priority - a.priority);
}

function inferCategory(modelId: string): ModelMeta['category'] {
  const lower = modelId.toLowerCase();
  if (lower.includes('guard') || lower.includes('safeguard')) return 'guard';
  if (lower.includes('whisper') || lower.includes('tts') || lower.includes('audio')) return 'audio';
  if (lower.includes('embed')) return 'embedding';
  if (lower.includes('vision')) return 'vision';
  // OpenCode models: deepseek, mimo, big-pickle, nemotron, kimi, qwen, minimax, claude, gpt, gemini
  if (lower.startsWith('deepseek-') || lower.startsWith('mimo-') || lower.startsWith('big-pickle') || lower.startsWith('nemotron-') || lower.startsWith('kimi-') || lower.startsWith('qwen3') || lower.startsWith('minimax-') || lower.startsWith('claude-') || lower.startsWith('gpt-') || lower.startsWith('gemini-')) return 'balanced';
  if (
    lower.includes('sonnet') ||
    lower.includes('opus') ||
    lower.includes('70b') ||
    lower.includes('120b')
  ) return 'balanced';
  if (
    lower.includes('mini') ||
    lower.includes('flash') ||
    lower.includes('haiku') ||
    lower.includes('8b') ||
    lower.includes('1b')
  ) return 'fast';
  return 'other';
}

function inferContextWindow(category: ModelMeta['category'], modelId: string): number {
  if (category === 'audio' || category === 'embedding') return 0;
  if (category === 'guard') return 512;
  if (modelId.toLowerCase().includes('gemini')) return 1048576;
  if (modelId.toLowerCase().includes('gpt-5')) return 131072;
  if (category === 'vision') return 131072;
  if (category === 'fast') return 32768;
  return 131072;
}

function inferMaxTokens(category: ModelMeta['category'], modelId: string): number {
  if (category === 'audio' || category === 'embedding') return 0;
  if (category === 'guard') return 512;
  // OpenCode models: deepseek, mimo, big-pickle, nemotron, kimi, qwen, minimax, claude, gpt, gemini
  const lower = modelId.toLowerCase();
  if (lower.startsWith('deepseek-') || lower.startsWith('mimo-') || lower.startsWith('big-pickle') || lower.startsWith('nemotron-') || lower.startsWith('kimi-') || lower.startsWith('qwen3') || lower.startsWith('minimax-') || lower.startsWith('claude-') || lower.startsWith('gpt-') || lower.startsWith('gemini-')) return 65536;
  if (lower.includes('gemini-2.5-pro')) return 65536;
  if (category === 'fast') return 8192;
  return 32768;
}

async function fetchModelsForSource(source: ProviderSource): Promise<ProviderModelRecord[]> {
  const apiKey = readEnv(source.apiKeyEnv);
  if (source.apiKeyEnv && !apiKey) {
    throw new Error(`missing api key in ${source.apiKeyEnv}`);
  }

  const resp = await fetch(`${trimBaseUrl(source.baseUrl)}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${source.name} /models failed (${resp.status}): ${body.slice(0, 400)}`);
  }

  const json = await resp.json() as any;
  const models = Array.isArray(json?.data) ? json.data : [];

  return models.map((m: any) => {
    const id = String(m.id || '').trim();
    const category = inferCategory(id);
    const contextWindow = typeof m.context_window === 'number'
      ? m.context_window
      : typeof m.context_window === 'string'
        ? Number(m.context_window)
        : inferContextWindow(category, id);
    const maxTokens = typeof m.max_tokens === 'number'
      ? m.max_tokens
      : inferMaxTokens(category, id);

    return {
      id,
      object: 'model' as const,
      created: typeof m.created === 'number' ? m.created : Math.floor(Date.now() / 1000),
      owned_by: String(m.owned_by || source.label),
      category,
      context_window: contextWindow,
      max_tokens: maxTokens,
      provider: source.label,
      source_name: source.name,
      source_kind: source.kind,
      base_url: source.baseUrl,
      api_key_env: source.apiKeyEnv || null,
      source_model_id: id,
      status: source.enabled ? 'active' : 'disabled',
      is_active: source.enabled,
      is_free: source.name === 'opencode' || source.name === 'ollama',
      sync_status: 'ok',
      sync_error: null,
      last_synced_at: new Date().toISOString(),
    };
  });
}

export async function syncModelCatalog(options?: { purge?: boolean }) {
  const db = getStateDb();
  if (!db) throw new Error('state db not initialized');

  const sources = getConfiguredSources();
  const activeSnapshot = db.prepare(`SELECT model_id, is_active FROM models`).all() as any[];
  const activeMap = new Map<string, number>(activeSnapshot.map((row) => [String(row.model_id), Number(row.is_active || 0)]));

  const synced: ProviderModelRecord[] = [];
  const errors: Array<{ source: string; error: string }> = [];

  if (options?.purge !== false) {
    clearModels(db);
  }

  for (const source of sources) {
    if (!source.enabled) {
      continue;
    }
    try {
      const models = await fetchModelsForSource(source);
      for (const model of models) {
        const preserved = activeMap.get(model.id);
        if (typeof preserved === 'number') {
          model.is_active = preserved === 1;
          model.status = preserved === 1 ? 'active' : 'disabled';
        }
        synced.push(model);
      }
    } catch (error: any) {
      errors.push({ source: source.name, error: error?.message || String(error) });
      continue;
    }
  }

  upsertModels(db, synced);
  return {
    sources,
    total: synced.length,
    errors,
    models: synced,
  };
}

export function getModelCatalogFromDb(): ProviderModelRecord[] {
  const db = getStateDb();
  if (!db) return [];
  return db.prepare(`SELECT * FROM models ORDER BY provider, category, model_id`).all() as unknown as ProviderModelRecord[];
}

export function getActiveModels(): ProviderModelRecord[] {
  return getModelCatalogFromDb().filter((m) => m.is_active !== false && String(m.status || 'active') !== 'disabled');
}

export function resolveModelCatalogEntry(modelId: string): ProviderModelRecord | null {
  const db = getStateDb();
  if (!db) return null;
  return getModelById(db, modelId) as ProviderModelRecord | null;
}

export function setCatalogModelActive(modelId: string, isActive: boolean) {
  const db = getStateDb();
  if (!db) throw new Error('state db not initialized');
  setModelActive(db, modelId, isActive);
}

export function markCatalogModelSync(modelId: string, status: string, error?: string | null) {
  const db = getStateDb();
  if (!db) throw new Error('state db not initialized');
  touchModelSync(db, modelId, status, error);
}

export interface OpenAiCompatibleRequestOptions {
  baseUrl: string;
  apiKey?: string;
  path: string;
  body: any;
}

export async function requestOpenAiCompatible({ baseUrl, apiKey, path: requestPath, body }: OpenAiCompatibleRequestOptions): Promise<Response> {
  const url = `${trimBaseUrl(baseUrl)}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function getSourceApiKey(source: ProviderSource): string {
  return readEnv(source.apiKeyEnv);
}

export function getSourceForModel(modelId: string): ProviderSource | null {
  // 1. Try resolving from the SQLite model catalog (populated by syncModelCatalog)
  const entry = resolveModelCatalogEntry(modelId);
  if (entry?.base_url) {
    return {
      name: entry.source_name || entry.provider || 'unknown',
      label: entry.provider || entry.source_name || 'unknown',
      kind: (entry.source_kind as ProviderKind) || 'openai-compatible',
      baseUrl: entry.base_url,
      apiKeyEnv: entry.api_key_env || undefined,
      enabled: Number(entry.is_active ?? 0) !== 0,
      priority: 0,
    };
  }

  // 2. Try matching by model ID prefix patterns (covers OpenCode Zen models)
  //    These are the model families known to belong to each source.
  const sourcePatterns: Array<{ name: string; match: (id: string) => boolean }> = [
    { name: 'opencode', match: (id) =>
      /^(big-pickle|deepseek|mimo|nemotron|minimax|kimi|qwen3\.|claude|gpt-5\.|gemini-3\.)/.test(id) },
    { name: 'groq', match: (id) =>
      /^(openai\/gpt-oss|groq\/|llama-|meta-llama\/|gemma|mixtral|allam|whisper|nomic|canopylabs)/.test(id) },
  ];

  for (const pattern of sourcePatterns) {
    if (pattern.match(modelId)) {
      const sources = getConfiguredSources();
      const matched = sources.find((s) => s.name === pattern.name && s.enabled);
      if (matched) return matched;
    }
  }

  // 3. Fallback: try substring matching (original logic)
  const sources = getConfiguredSources();
  return sources.find((s) => s.enabled && modelId.includes(s.name)) || sources[0] || null;
}
