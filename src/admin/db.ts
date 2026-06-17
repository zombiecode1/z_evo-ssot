import { getStateDb } from '../services/stateDb';

export function initAdminTables() {
  const db = getStateDb();
  if (!db) return;

  db.prepare(`
    CREATE TABLE IF NOT EXISTS provider_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_pattern TEXT NOT NULL,
      provider_name TEXT NOT NULL DEFAULT 'proxi',
      backend_url TEXT,
      priority INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS usage_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      provider TEXT,
      tokens_prompt INTEGER DEFAULT 0,
      tokens_completion INTEGER DEFAULT 0,
      requests INTEGER DEFAULT 1,
      duration_ms INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT,
      provider TEXT,
      model TEXT,
      status TEXT DEFAULT 'active',
      messages_count INTEGER DEFAULT 0,
      tokens_used INTEGER DEFAULT 0,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS editor_connections (
      connection_id TEXT PRIMARY KEY,
      editor_name TEXT NOT NULL,
      client_name TEXT,
      workspace_id TEXT,
      directory TEXT,
      session_path TEXT,
      active INTEGER DEFAULT 1,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_usage_stats_model ON usage_stats(model_id);
  `).run();
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_usage_stats_timestamp ON usage_stats(timestamp);
  `).run();

  // Add priority column to model_rate_limits if not exists
  try {
    db.prepare(`ALTER TABLE model_rate_limits ADD COLUMN priority INTEGER DEFAULT 0`).run();
  } catch { /* column exists */ }

  seedDefaultMapping(db);
}

function seedDefaultMapping(db: any) {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM provider_mapping').get() as any;
  if (count.cnt > 0) return;

  const stmt = db.prepare(`
    INSERT INTO provider_mapping (model_pattern, provider_name, backend_url, priority)
    VALUES (?, ?, ?, ?)
  `);

  const mappings = [
    ['gemma', 'Groq', 'https://api.groq.com/openai/v1', 10],
    ['llama', 'Groq', 'https://api.groq.com/openai/v1', 10],
    ['mixtral', 'Groq', 'https://api.groq.com/openai/v1', 10],
    ['qwen', 'OpenRouter', 'https://openrouter.ai/api/v1', 5],
    ['claude', 'OpenRouter', 'https://openrouter.ai/api/v1', 5],
    ['gpt-4', 'OpenRouter', 'https://openrouter.ai/api/v1', 5],
    ['gpt-3.5', 'OpenRouter', 'https://openrouter.ai/api/v1', 5],
    ['deepseek', 'OpenRouter', 'https://openrouter.ai/api/v1', 5],
    ['gemini', 'Google', 'https://generativelanguage.googleapis.com/v1beta', 8],
    ['zombie', 'ZombieCoder', 'http://localhost:9999/v1', 20],
    ['proxi', 'proxi-bridge', 'http://localhost:9999/v1', 20],
    ['ollama', 'Ollama Cloud', 'https://api.ollama.cloud/v1', 3],
    ['o1-', 'OpenCode Go', 'https://api.opencode.ai/v1', 2],
    ['o3-', 'OpenCode Go', 'https://api.opencode.ai/v1', 2],
    ['opencode', 'OpenCode Zen', 'https://api.opencode.ai/v1', 2],
  ];

  const tx = db.transaction((items: any[]) => {
    for (const m of items) stmt.run(...m);
  });
  tx(mappings);
}

export function getProviderMapping(db: any) {
  return db.prepare('SELECT * FROM provider_mapping ORDER BY priority DESC, provider_name').all();
}

export function upsertProviderMapping(db: any, mapping: {
  model_pattern: string;
  provider_name: string;
  backend_url?: string | null;
  priority?: number;
  is_active?: boolean | number;
  id?: number;
}) {
  if (mapping.id) {
    return db.prepare(`
      UPDATE provider_mapping
      SET model_pattern = ?, provider_name = ?, backend_url = ?, priority = ?, is_active = ?, created_at = created_at
      WHERE id = ?
    `).run(
      mapping.model_pattern,
      mapping.provider_name,
      mapping.backend_url || null,
      Number(mapping.priority ?? 0),
      mapping.is_active === false ? 0 : 1,
      mapping.id,
    );
  }

  return db.prepare(`
    INSERT INTO provider_mapping (model_pattern, provider_name, backend_url, priority, is_active)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    mapping.model_pattern,
    mapping.provider_name,
    mapping.backend_url || null,
    Number(mapping.priority ?? 0),
    mapping.is_active === false ? 0 : 1,
  );
}

export function deleteProviderMapping(db: any, id: number) {
  return db.prepare('DELETE FROM provider_mapping WHERE id = ?').run(id);
}

export function getEditorConnections(db: any, limit = 100) {
  return db.prepare(`
    SELECT *
    FROM editor_connections
    ORDER BY last_seen_at DESC, connected_at DESC
    LIMIT ?
  `).all(limit);
}

export function addEditorConnection(db: any, data: {
  connection_id: string;
  editor_name: string;
  client_name?: string | null;
  workspace_id?: string | null;
  directory?: string | null;
  session_path?: string | null;
  active?: boolean | number;
}) {
  return db.prepare(`
    INSERT INTO editor_connections (
      connection_id, editor_name, client_name, workspace_id, directory, session_path, active, connected_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(connection_id) DO UPDATE SET
      editor_name = excluded.editor_name,
      client_name = excluded.client_name,
      workspace_id = excluded.workspace_id,
      directory = excluded.directory,
      session_path = excluded.session_path,
      active = excluded.active,
      last_seen_at = CURRENT_TIMESTAMP
  `).run(
    data.connection_id,
    data.editor_name,
    data.client_name || null,
    data.workspace_id || null,
    data.directory || null,
    data.session_path || null,
    data.active === false ? 0 : 1,
  );
}

export function getEditorConnectionStats(db: any) {
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM editor_connections`).get()?.cnt || 0;
  const active = db.prepare(`SELECT COUNT(*) as cnt FROM editor_connections WHERE active = 1`).get()?.cnt || 0;
  const editors = db.prepare(`
    SELECT editor_name, COUNT(*) as count
    FROM editor_connections
    GROUP BY editor_name
    ORDER BY count DESC, editor_name ASC
  `).all();
  return { total, active, editors };
}

export function inferProvider(modelId: string): string {
  const db = getStateDb();
  if (!db) return 'unknown';
  const rows = db.prepare(`
    SELECT provider_name FROM provider_mapping
    WHERE ? LIKE '%' || model_pattern || '%'
    ORDER BY priority DESC LIMIT 1
  `).all(modelId);
  if (rows.length > 0) return String(rows[0].provider_name || 'proxi-bridge');
  if (modelId.includes('/')) return modelId.split('/')[0];
  return 'proxi-bridge';
}

export function logUsage(modelId: string, promptTokens: number, completionTokens: number, durationMs: number) {
  const db = getStateDb();
  if (!db) return;
  const provider = inferProvider(modelId);
  db.prepare(`
    INSERT INTO usage_stats (model_id, provider, tokens_prompt, tokens_completion, requests, duration_ms)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(modelId, provider, promptTokens, completionTokens, durationMs);
}

export function getUsageStats(days = 7) {
  const db = getStateDb();
  if (!db) return [];
  return db.prepare(`
    SELECT
      model_id,
      provider,
      SUM(requests) as total_requests,
      SUM(tokens_prompt) as total_prompt_tokens,
      SUM(tokens_completion) as total_completion_tokens,
      SUM(duration_ms) as total_duration_ms,
      COUNT(*) as entries
    FROM usage_stats
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY model_id
    ORDER BY total_requests DESC
  `).all(days);
}

export function getUsageByDay(days = 14) {
  const db = getStateDb();
  if (!db) return [];
  return db.prepare(`
    SELECT
      date(timestamp) as day,
      provider,
      SUM(requests) as requests,
      SUM(tokens_prompt + tokens_completion) as total_tokens
    FROM usage_stats
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY date(timestamp), provider
    ORDER BY day ASC
  `).all(days);
}

export function recordSession(sessionId: string, agentName?: string, provider?: string, model?: string) {
  const db = getStateDb();
  if (!db) return;
  db.prepare(`
    INSERT INTO admin_sessions (session_id, agent_name, provider, model, status, started_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET
      updated_at=CURRENT_TIMESTAMP,
      messages_count=messages_count+1
  `).run(sessionId, agentName || null, provider || null, model || null);
}

export function endSession(sessionId: string) {
  const db = getStateDb();
  if (!db) return;
  db.prepare(`
    UPDATE admin_sessions SET status='ended', ended_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE session_id = ?
  `).run(sessionId);
}

export function getSessions(limit = 50) {
  const db = getStateDb();
  if (!db) return [];
  return db.prepare(`
    SELECT * FROM admin_sessions ORDER BY updated_at DESC LIMIT ?
  `).all(limit);
}

export function getConversations(limit = 50) {
  const db = getStateDb();
  if (!db) return [];
  return db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM conversation_messages cm WHERE cm.conversation_id = c.conversation_id) as message_count
    FROM conversations c ORDER BY c.updated_at DESC LIMIT ?
  `).all(limit);
}

export function getConversationDetail(conversationId: string) {
  const db = getStateDb();
  if (!db) return null;
  return db.prepare(`
    SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC
  `).all(conversationId);
}

export function getModelList() {
  const db = getStateDb();
  if (!db) return [];
  return db.prepare('SELECT * FROM models ORDER BY category, model_id').all();
}

// ─── Delete / Cleanup Functions ──────────────────────────
export function deleteSession(sessionId: string) {
  const db = getStateDb();
  if (!db) return;
  db.prepare('DELETE FROM admin_sessions WHERE session_id = ?').run(sessionId);
}

export function deleteAllSessions() {
  const db = getStateDb();
  if (!db) return { deleted: 0 };
  const result = db.prepare('DELETE FROM admin_sessions').run() as any;
  return { deleted: result?.changes || 0 };
}

export function deleteConversation(conversationId: string) {
  const db = getStateDb();
  if (!db) return;
  db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM conversations WHERE conversation_id = ?').run(conversationId);
}

export function deleteAllConversations() {
  const db = getStateDb();
  if (!db) return { deleted: 0 };
  const msgResult = db.prepare('DELETE FROM conversation_messages').run() as any;
  const convResult = db.prepare('DELETE FROM conversations').run() as any;
  return { deleted: convResult?.changes || 0, messagesDeleted: msgResult?.changes || 0 };
}

export function clearUsageStats() {
  const db = getStateDb();
  if (!db) return { deleted: 0 };
  const result = db.prepare('DELETE FROM usage_stats').run() as any;
  return { deleted: result?.changes || 0 };
}

// ─── Model Priority ─────────────────────────────────────
export function getModelPriority(modelId: string): number {
  const db = getStateDb();
  if (!db) return 0;
  const row = db.prepare('SELECT priority FROM model_rate_limits WHERE model_id = ?').get(modelId) as any;
  return row?.priority || 0;
}

export function setModelPriority(modelId: string, priority: number) {
  const db = getStateDb();
  if (!db) return;
  db.prepare(`
    INSERT INTO model_rate_limits(model_id, priority, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(model_id) DO UPDATE SET priority=excluded.priority, updated_at=CURRENT_TIMESTAMP
  `).run(modelId, Math.max(0, Math.min(10, priority)));
}

export function getModelsWithPriority() {
  const db = getStateDb();
  if (!db) return [];
  return db.prepare(`
    SELECT m.*, COALESCE(r.priority, 0) as priority
    FROM models m
    LEFT JOIN model_rate_limits r ON m.model_id = r.model_id
    ORDER BY COALESCE(r.priority, 0) DESC, m.category, m.model_id
  `).all();
}

// ─── Per-Model Usage Stats ──────────────────────────────
export function getModelUsage(modelId: string) {
  const db = getStateDb();
  if (!db) return null;
  return db.prepare(`
    SELECT
      model_id,
      provider,
      SUM(requests) as total_requests,
      SUM(tokens_prompt) as total_prompt_tokens,
      SUM(tokens_completion) as total_completion_tokens,
      SUM(duration_ms) as total_duration_ms,
      MAX(timestamp) as last_used
    FROM usage_stats
    WHERE model_id = ?
    GROUP BY model_id
  `).get(modelId) || null;
}
