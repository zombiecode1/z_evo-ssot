export interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  model: string;
  status: number;
  duration_ms: number;
  tokens: number;
  success: boolean;
  error?: string;
}

export interface ModelMeta {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  context_window: number;
  max_tokens: number;
  category: 'fast' | 'balanced' | 'powerful' | 'vision' | 'audio' | 'embedding' | 'guard' | 'other';
  provider?: string;
  source_name?: string;
  source_kind?: 'groq' | 'openai-compatible' | 'opencode' | 'ollama' | 'gateway';
  base_url?: string;
  api_key_env?: string | null;
  source_model_id?: string;
  status?: 'active' | 'disabled' | 'offline' | 'unknown';
  is_active?: boolean;
  is_free?: boolean;
}

export interface RateLimitState {
  model: string;
  rpm: number;
  tpm: number;
  current_rpm: number;
  current_tpm: number;
  resets_in_seconds: number;
}

export interface ServerStatus {
  status: 'ok' | 'degraded';
  uptime: number;
  models_count: number;
  total_requests: number;
  auto_select: boolean;
  memory_mb: number;
}

export interface DashboardData {
  models: ModelMeta[];
  logs: LogEntry[];
  status: ServerStatus;
  rate_limits: RateLimitState[];
}

// ─── Agent & RAG Types ────────────────────────────────────
export interface AgentFlags {
  type: 'chat' | 'code' | 'tool' | 'error';
  execute?: boolean;
  language?: string;
  safety?: 'safe' | 'unsafe' | 'unknown';
}

export interface AgentResponse {
  content: string;
  model: string;
  flags: AgentFlags;
  ragUsed: boolean;
  toolResults?: Record<string, unknown>[];
  durationMs: number;
}

export interface RouteDecision {
  model: string;
  category: string;
  needsRag: boolean;
  confidence: number;
}

export interface ProjectScanResult {
  tree: string;
  files: { path: string; type: 'source' | 'config' | 'doc' | 'test'; summary: string }[];
  dependencies: Record<string, string>;
}

export interface Permission {
  directory: string;
  grantedAt: number;
  scope: 'scan' | 'write' | 'execute';
  signature?: string;
}
