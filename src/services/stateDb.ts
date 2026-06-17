// SQLite state store for agent/persona/models/rate-limits/memory.
// This is intentionally local-first: a single file per workspace (or per instance).

// @ts-ignore - better-sqlite3 has no @types package
import Database from 'better-sqlite3';

/** Minimal type interface for better-sqlite3 Database (no @types available). */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteTransaction {
  (fn: (...args: any[]) => void): (...args: any[]) => unknown;
}

export interface StateDb {
  prepare(sql: string): SqliteStatement;
  pragma(pragmaStr: string): unknown;
  transaction(fn: (...args: any[]) => void): SqliteTransaction;
}

let _globalDb: StateDb | null = null;
export function setStateDb(db: StateDb) { _globalDb = db; }
export function getStateDb(): StateDb | null { return _globalDb; }

export function initStateDb(dbPath: string): StateDb {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_personas (
      persona_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS models (
      model_id TEXT PRIMARY KEY,
      owned_by TEXT,
      category TEXT,
      context_window INTEGER,
      max_tokens INTEGER,
      provider TEXT,
      source_name TEXT,
      source_kind TEXT,
      base_url TEXT,
      api_key_env TEXT,
      source_model_id TEXT,
      is_active INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      is_free INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'unknown',
      sync_error TEXT,
      last_synced_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS model_rate_limits (
      model_id TEXT PRIMARY KEY,
      rpm INTEGER,
      tpm INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      trusted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      workspace_id TEXT,
      user_id TEXT,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS rag_documents (
      document_id TEXT PRIMARY KEY,
      workspace_id TEXT,
      source_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      chunk_count INTEGER DEFAULT 0,
      indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS rag_chunks (
      chunk_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      workspace_id TEXT,
      source_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL,
      token_count INTEGER DEFAULT 0,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_workspace
    ON rag_chunks(workspace_id, source_path, chunk_index);
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_document
    ON rag_chunks(document_id);
  `).run();

  // ─── Provider Orchestration Tables ───────────────────────
  db.prepare(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'openai-compatible',
      base_url TEXT NOT NULL,
      api_key_env TEXT,
      api_key TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      capabilities TEXT DEFAULT '{}',
      rate_limit_rpm INTEGER,
      rate_limit_tpm INTEGER,
      health_status TEXT DEFAULT 'unknown',
      last_health_check DATETIME,
      error_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS provider_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      context_window INTEGER DEFAULT 0,
      max_output_tokens INTEGER DEFAULT 0,
      category TEXT DEFAULT 'other',
      input_price_per_1k REAL DEFAULT 0,
      output_price_per_1k REAL DEFAULT 0,
      is_free INTEGER DEFAULT 0,
      supports_tools INTEGER DEFAULT 0,
      supports_vision INTEGER DEFAULT 0,
      supports_streaming INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_provider_models_provider
    ON provider_models(provider_id);
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT '',
      preferred_provider_id TEXT,
      preferred_model_id TEXT,
      budget_limit REAL DEFAULT 100,
      auto_select INTEGER DEFAULT 1,
      allowed_providers TEXT DEFAULT '[]',
      allowed_models TEXT DEFAULT '[]',
      memory TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS provider_tools (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_type TEXT NOT NULL DEFAULT 'chat',
      description TEXT DEFAULT '',
      is_available INTEGER DEFAULT 1,
      last_tested_at DATETIME,
      last_test_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_provider_tools_provider
    ON provider_tools(provider_id);
  `).run();

  // ─── Phase 2: New Tables ────────────────────────────────
  db.prepare(`
    CREATE TABLE IF NOT EXISTS identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'ZombieCoder',
      version TEXT NOT NULL DEFAULT '2.0.0',
      tagline TEXT DEFAULT 'Local-first AI execution engine',
      owner TEXT DEFAULT '',
      organization TEXT DEFAULT '',
      address TEXT DEFAULT '',
      location TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      website TEXT DEFAULT '',
      license TEXT DEFAULT 'MIT',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS llm_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_env TEXT,
      priority INTEGER NOT NULL DEFAULT 1,
      provider_kind TEXT DEFAULT 'openai-compatible',
      health_status TEXT DEFAULT 'unknown',
      last_verified DATETIME,
      models_json TEXT,
      is_active INTEGER DEFAULT 1,
      error_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  // Runtime config: stores persona, workflow, rules, competencies (survives restart)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS runtime_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      version INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS write_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_hash TEXT,
      new_hash TEXT,
      verified INTEGER DEFAULT 0,
      source_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  // Seed default identity row if not exists
  db.prepare(`
    INSERT OR IGNORE INTO identity (id, name, version, tagline)
    VALUES (1, 'ZombieCoder', '2.0.0', 'Local-first AI execution engine');
  `).run();

  const modelColumnDefs = [
    ['provider', "TEXT"],
    ['source_name', "TEXT"],
    ['source_kind', "TEXT"],
    ['base_url', "TEXT"],
    ['api_key_env', "TEXT"],
    ['source_model_id', "TEXT"],
    ['is_active', "INTEGER DEFAULT 1"],
    ['status', "TEXT DEFAULT 'active'"],
    ['is_free', "INTEGER DEFAULT 0"],
    ['sync_status', "TEXT DEFAULT 'unknown'"],
    ['sync_error', "TEXT"],
    ['last_synced_at', "DATETIME"],
  ] as const;
  for (const [column, ddl] of modelColumnDefs) {
    try {
      db.prepare(`ALTER TABLE models ADD COLUMN ${column} ${ddl}`).run();
    } catch {
      // column already exists or migration not applicable
    }
  }

  const sourceColumnDefs = [
    ['provider_kind', "TEXT DEFAULT 'openai-compatible'"],
  ] as const;
  for (const [column, ddl] of sourceColumnDefs) {
    try {
      db.prepare(`ALTER TABLE llm_sources ADD COLUMN ${column} ${ddl}`).run();
    } catch {
      // ignore
    }
  }

  return db;
}

export function clearModels(db: StateDb) {
  db.prepare(`DELETE FROM models`).run();
}

export function upsertPersona(db: StateDb, persona: { persona_id: string; name: string; system_prompt: string }) {
  db.prepare(`
    INSERT INTO agent_personas(persona_id, name, system_prompt, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(persona_id) DO UPDATE SET
      name=excluded.name,
      system_prompt=excluded.system_prompt,
      updated_at=CURRENT_TIMESTAMP
  `).run(persona.persona_id, persona.name, persona.system_prompt);
}

// ── Runtime Config CRUD ──────────────────────────────────────────
export function setRuntimeConfig(db: StateDb, key: string, value: string, category: string = 'general') {
  db.prepare(`
    INSERT INTO runtime_config(key, value, category, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,
      category=excluded.category,
      updated_at=CURRENT_TIMESTAMP
  `).run(key, value, category);
}

export function getRuntimeConfig(db: StateDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM runtime_config WHERE key = ?').get(key) as any;
  return row?.value ?? null;
}

export function getRuntimeConfigByCategory(db: StateDb, category: string): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM runtime_config WHERE category = ?').all(category) as any[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function getAllRuntimeConfig(db: StateDb): Array<{ key: string; value: string; category: string; updated_at: string }> {
  return db.prepare('SELECT key, value, category, updated_at FROM runtime_config ORDER BY category, key').all() as any[];
}

export function deleteRuntimeConfig(db: StateDb, key: string) {
  db.prepare('DELETE FROM runtime_config WHERE key = ?').run(key);
}

export function upsertModels(db: StateDb, models: Array<{
  id: string;
  owned_by?: string;
  category?: string;
  context_window?: number;
  max_tokens?: number;
  provider?: string;
  source_name?: string;
  source_kind?: string;
  base_url?: string;
  api_key_env?: string | null;
  source_model_id?: string;
  is_active?: boolean;
  status?: string;
  is_free?: boolean;
  sync_status?: string;
  sync_error?: string | null;
  last_synced_at?: string | null;
}>) {
  const stmt = db.prepare(`
    INSERT INTO models(
      model_id, owned_by, category, context_window, max_tokens,
      provider, source_name, source_kind, base_url, api_key_env, source_model_id,
      is_active, status, is_free, sync_status, sync_error, last_synced_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(model_id) DO UPDATE SET
      owned_by=excluded.owned_by,
      category=excluded.category,
      context_window=excluded.context_window,
      max_tokens=excluded.max_tokens,
      provider=excluded.provider,
      source_name=excluded.source_name,
      source_kind=excluded.source_kind,
      base_url=excluded.base_url,
      api_key_env=excluded.api_key_env,
      source_model_id=excluded.source_model_id,
      is_active=excluded.is_active,
      status=excluded.status,
      is_free=excluded.is_free,
      sync_status=excluded.sync_status,
      sync_error=excluded.sync_error,
      last_synced_at=excluded.last_synced_at,
      updated_at=CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((items: any[]) => {
    for (const m of items) {
      if (!m?.id) continue;
      stmt.run(
        m.id,
        m.owned_by || null,
        m.category || null,
        m.context_window ?? null,
        m.max_tokens ?? null,
        m.provider || m.owned_by || null,
        m.source_name || null,
        m.source_kind || null,
        m.base_url || null,
        m.api_key_env ?? null,
        m.source_model_id || null,
        m.is_active === false ? 0 : 1,
        m.status || (m.is_active === false ? 'disabled' : 'active'),
        m.is_free ? 1 : 0,
        m.sync_status || 'ok',
        m.sync_error ?? null,
        m.last_synced_at ?? null
      );
    }
  });
  tx(models as any);
}

export function getModelById(db: StateDb, modelId: string) {
  return db.prepare(`SELECT * FROM models WHERE model_id = ? LIMIT 1`).get(modelId) || null;
}

export function setModelActive(db: StateDb, modelId: string, isActive: boolean) {
  db.prepare(`
    UPDATE models
    SET is_active = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE model_id = ?
  `).run(isActive ? 1 : 0, isActive ? 'active' : 'disabled', modelId);
}

export function touchModelSync(db: StateDb, modelId: string, status: string, error?: string | null) {
  db.prepare(`
    UPDATE models
    SET sync_status = ?, sync_error = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE model_id = ?
  `).run(status, error || null, modelId);
}

export function upsertModelRateLimits(db: StateDb, limits: Array<{ model: string; rpm?: number; tpm?: number }>) {
  const stmt = db.prepare(`
    INSERT INTO model_rate_limits(model_id, rpm, tpm, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(model_id) DO UPDATE SET
      rpm=excluded.rpm,
      tpm=excluded.tpm,
      updated_at=CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((items: any[]) => {
    for (const lim of items) {
      if (!lim?.model) continue;
      stmt.run(lim.model, lim.rpm ?? null, lim.tpm ?? null);
    }
  });
  tx(limits as any);
}

export function upsertWorkspaceTrust(
  db: StateDb,
  ws: { workspace_id: string; user_id: string; directory: string; trusted: boolean }
) {
  db.prepare(`
    INSERT INTO workspaces(workspace_id, user_id, directory, trusted, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspace_id) DO UPDATE SET
      user_id=excluded.user_id,
      directory=excluded.directory,
      trusted=excluded.trusted,
      updated_at=CURRENT_TIMESTAMP
  `).run(ws.workspace_id, ws.user_id, ws.directory, ws.trusted ? 1 : 0);
}

export function isWorkspaceTrusted(db: StateDb, workspace_id: string, user_id: string, directory: string): boolean {
  const row = db.prepare(`
    SELECT trusted FROM workspaces
    WHERE workspace_id = ? AND user_id = ? AND directory = ?
    LIMIT 1
  `).get(workspace_id, user_id, directory);
  return !!row?.trusted;
}

export function ensureConversation(db: StateDb, convo: { conversation_id: string; workspace_id?: string; user_id?: string; title?: string }) {
  // Auto-generate title from first user message if no title provided
  let title = convo.title || null;
  if (!title) {
    try {
      const firstMsg = db.prepare(
        'SELECT content FROM conversation_messages WHERE conversation_id = ? AND role = ? ORDER BY id ASC LIMIT 1'
      ).get(convo.conversation_id, 'user') as any;
        if (firstMsg?.content) {
        const raw = String(firstMsg.content)
          .replace(/['"``]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 50);
        title = raw.length >= 47 ? raw + '...' : raw;
      }
    } catch { /* ignore */ }
  }

  db.prepare(`
    INSERT INTO conversations(conversation_id, workspace_id, user_id, title, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(conversation_id) DO UPDATE SET
      title = COALESCE(excluded.title, title),
      updated_at=CURRENT_TIMESTAMP
  `).run(convo.conversation_id, convo.workspace_id || null, convo.user_id || null, title);
}

export function addConversationMessage(db: StateDb, msg: { conversation_id: string; role: string; content: string }) {
  db.prepare(`
    INSERT INTO conversation_messages(conversation_id, role, content)
    VALUES (?, ?, ?)
  `).run(msg.conversation_id, msg.role, msg.content);
}

export function listConversationMessages(db: StateDb, conversation_id: string, limit = 200) {
  return db.prepare(`
    SELECT id, conversation_id, role, content, created_at
    FROM conversation_messages
    WHERE conversation_id = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(conversation_id, limit);
}

export function getConversation(db: StateDb, conversation_id: string) {
  return db.prepare(`
    SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
    FROM conversations
    WHERE conversation_id = ?
    LIMIT 1
  `).get(conversation_id);
}

export function listConversations(db: StateDb, limit = 50, workspace_id?: string) {
  if (workspace_id) {
    return db.prepare(`
      SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
      FROM conversations
      WHERE workspace_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(workspace_id, limit);
  }
  return db.prepare(`
    SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
    FROM conversations
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
}

export function upsertRagDocument(
  db: StateDb,
  doc: {
    document_id: string;
    workspace_id?: string | null;
    source_path: string;
    content_hash: string;
    chunk_count: number;
  }
) {
  db.prepare(`
    INSERT INTO rag_documents(document_id, workspace_id, source_path, content_hash, chunk_count, indexed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(document_id) DO UPDATE SET
      workspace_id=excluded.workspace_id,
      source_path=excluded.source_path,
      content_hash=excluded.content_hash,
      chunk_count=excluded.chunk_count,
      indexed_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
  `).run(doc.document_id, doc.workspace_id || null, doc.source_path, doc.content_hash, doc.chunk_count);
}

export function deleteRagChunksForDocument(db: StateDb, document_id: string) {
  db.prepare(`DELETE FROM rag_chunks WHERE document_id = ?`).run(document_id);
}

export function upsertRagChunk(
  db: StateDb,
  chunk: {
    chunk_id: string;
    document_id: string;
    workspace_id?: string | null;
    source_path: string;
    chunk_index: number;
    chunk_text: string;
    content_hash: string;
    embedding_json: string;
    embedding_dim: number;
    token_count: number;
    metadata_json?: string | null;
  }
) {
  db.prepare(`
    INSERT INTO rag_chunks(
      chunk_id, document_id, workspace_id, source_path, chunk_index, chunk_text,
      content_hash, embedding_json, embedding_dim, token_count, metadata_json,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(chunk_id) DO UPDATE SET
      document_id=excluded.document_id,
      workspace_id=excluded.workspace_id,
      source_path=excluded.source_path,
      chunk_index=excluded.chunk_index,
      chunk_text=excluded.chunk_text,
      content_hash=excluded.content_hash,
      embedding_json=excluded.embedding_json,
      embedding_dim=excluded.embedding_dim,
      token_count=excluded.token_count,
      metadata_json=excluded.metadata_json,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    chunk.chunk_id,
    chunk.document_id,
    chunk.workspace_id || null,
    chunk.source_path,
    chunk.chunk_index,
    chunk.chunk_text,
    chunk.content_hash,
    chunk.embedding_json,
    chunk.embedding_dim,
    chunk.token_count,
    chunk.metadata_json || null,
  );
}

export function listRagChunks(db: StateDb, workspace_id?: string | null, limit = 500) {
  if (workspace_id) {
    return db.prepare(`
      SELECT chunk_id, document_id, workspace_id, source_path, chunk_index, chunk_text,
             content_hash, embedding_json, embedding_dim, token_count, metadata_json,
             created_at, updated_at
      FROM rag_chunks
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, chunk_index ASC
      LIMIT ?
    `).all(workspace_id, limit);
  }
  return db.prepare(`
    SELECT chunk_id, document_id, workspace_id, source_path, chunk_index, chunk_text,
           content_hash, embedding_json, embedding_dim, token_count, metadata_json,
           created_at, updated_at
    FROM rag_chunks
    ORDER BY updated_at DESC, chunk_index ASC
    LIMIT ?
  `).all(limit);
}

export function getRagIndexStats(db: StateDb) {
  const docs = db.prepare(`SELECT COUNT(*) as count FROM rag_documents`).get()?.count || 0;
  const chunks = db.prepare(`SELECT COUNT(*) as count FROM rag_chunks`).get()?.count || 0;
  const workspaces = db.prepare(`SELECT COUNT(DISTINCT workspace_id) as count FROM rag_chunks WHERE workspace_id IS NOT NULL`).get()?.count || 0;
  return { documents: docs, chunks, workspaces };
}

// ═══════════════════════════════════════════════════════════════
// Phase 2 — Multi-Source DB Functions
// ═══════════════════════════════════════════════════════════════

// ─── Identity ──────────────────────────────────────────────
export function getIdentity(db: StateDb) {
  return db.prepare(`SELECT * FROM identity WHERE id = 1`).get() || null;
}

const IDENTITY_ALLOWED_COLUMNS = new Set([
  'name', 'version', 'tagline', 'owner', 'organization',
  'system_identity', 'profile_json', 'updated_at'
]);

export function upsertIdentity(db: StateDb, data: Record<string, any>) {
  const keys = Object.keys(data)
    .filter(k => k !== 'id' && k !== 'created_at' && IDENTITY_ALLOWED_COLUMNS.has(k));
  const sets = keys.map(k => `"${k}"=?`).join(',');
  const vals = keys.map(k => data[k]);
  if (!sets) return;
  db.prepare(`UPDATE identity SET ${sets}, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(...vals);
}

// ─── LLM Sources ───────────────────────────────────────────
export function listLlmSources(db: StateDb) {
  return db.prepare(`SELECT * FROM llm_sources ORDER BY priority ASC`).all();
}

export function getLlmSources(db: StateDb) {
  return listLlmSources(db);
}

export function getLlmSource(db: StateDb, id: number) {
  return db.prepare(`SELECT * FROM llm_sources WHERE id = ?`).get(id) || null;
}

export function upsertLlmSource(db: StateDb, src: {
  name: string; base_url: string; api_key_env?: string; priority: number;
}) {
  return db.prepare(`
    INSERT INTO llm_sources(name, base_url, api_key_env, priority, created_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      base_url=excluded.base_url, api_key_env=excluded.api_key_env,
      priority=excluded.priority, updated_at=CURRENT_TIMESTAMP
  `).run(src.name, src.base_url, src.api_key_env || null, src.priority);
}

export function deleteLlmSource(db: StateDb, id: number) {
  return db.prepare(`DELETE FROM llm_sources WHERE id = ?`).run(id);
}

export function deleteModelById(db: StateDb, modelId: string) {
  return db.prepare(`DELETE FROM models WHERE model_id = ?`).run(modelId);
}

export function updateModelById(
  db: StateDb,
  modelId: string,
  updates: Partial<{
    owned_by: string | null;
    category: string | null;
    context_window: number | null;
    max_tokens: number | null;
    provider: string | null;
    source_name: string | null;
    source_kind: string | null;
    base_url: string | null;
    api_key_env: string | null;
    source_model_id: string | null;
    is_active: boolean | number | null;
    status: string | null;
    is_free: boolean | number | null;
    sync_status: string | null;
    sync_error: string | null;
    last_synced_at: string | null;
  }>
) {
  const allowed = [
    ['owned_by', updates.owned_by],
    ['category', updates.category],
    ['context_window', updates.context_window],
    ['max_tokens', updates.max_tokens],
    ['provider', updates.provider],
    ['source_name', updates.source_name],
    ['source_kind', updates.source_kind],
    ['base_url', updates.base_url],
    ['api_key_env', updates.api_key_env],
    ['source_model_id', updates.source_model_id],
    ['status', updates.status],
    ['sync_status', updates.sync_status],
    ['sync_error', updates.sync_error],
    ['last_synced_at', updates.last_synced_at],
  ] as const;
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, value] of allowed) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active ? 1 : 0);
  }
  if (updates.is_free !== undefined) {
    fields.push('is_free = ?');
    values.push(updates.is_free ? 1 : 0);
  }
  if (!fields.length) return;
  values.push(modelId);
  db.prepare(`
    UPDATE models
    SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
    WHERE model_id = ?
  `).run(...values);
}

// ─── Agent Notes ───────────────────────────────────────────
export function listAgentNotes(db: StateDb, workspace_id?: string, category?: string) {
  let sql = `SELECT * FROM agent_notes WHERE 1=1`;
  const params: any[] = [];
  if (workspace_id) { sql += ` AND workspace_id=?`; params.push(workspace_id); }
  if (category) { sql += ` AND category=?`; params.push(category); }
  sql += ` ORDER BY updated_at DESC LIMIT 200`;
  return db.prepare(sql).all(...params);
}

export function getAgentNote(db: StateDb, key: string) {
  return db.prepare(`SELECT * FROM agent_notes WHERE key = ? ORDER BY version DESC LIMIT 1`).get(key) || null;
}

export function upsertAgentNote(db: StateDb, note: {
  workspace_id?: string; key: string; content: string; category?: string;
}) {
  const existing = db.prepare(`SELECT version FROM agent_notes WHERE key = ? ORDER BY version DESC LIMIT 1`).get(note.key) as any;
  const version = (existing?.version || 0) + 1;
  return db.prepare(`
    INSERT INTO agent_notes(workspace_id, key, content, category, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(note.workspace_id || null, note.key, note.content, note.category || 'general', version);
}

export function deleteAgentNote(db: StateDb, key: string) {
  return db.prepare(`DELETE FROM agent_notes WHERE key = ?`).run(key);
}

// ─── Write Log (Verification) ──────────────────────────────
export function listWriteLog(db: StateDb, table_name?: string, limit = 100) {
  let sql = `SELECT * FROM write_log WHERE 1=1`;
  const params: any[] = [];
  if (table_name) { sql += ` AND table_name=?`; params.push(table_name); }
  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function addWriteLog(db: StateDb, entry: {
  table_name: string; record_id: string; action: string;
  old_hash?: string; new_hash?: string; source_url?: string;
}) {
  return db.prepare(`
    INSERT INTO write_log(table_name, record_id, action, old_hash, new_hash, source_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entry.table_name, entry.record_id, entry.action,
    entry.old_hash || null, entry.new_hash || null, entry.source_url || null);
}

// ═══════════════════════════════════════════════════════════════
// Phase 3 — Write Verification
// ═══════════════════════════════════════════════════════════════

export function addWriteLogWithHash(db: StateDb, entry: {
  table_name: string; record_id: string; action: string;
  old_hash?: string; new_hash?: string; source_url?: string;
}) {
  return db.prepare(`
    INSERT INTO write_log(table_name, record_id, action, old_hash, new_hash, source_url, verified)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(entry.table_name, entry.record_id, entry.action,
    entry.old_hash || null, entry.new_hash || null, entry.source_url || null);
}

export async function verifyWriteLogEntry(db: StateDb, logId: number): Promise<any> {
  const entry = db.prepare(`SELECT * FROM write_log WHERE id = ?`).get(logId) as any;
  if (!entry) return { entry: null, computed_hash: null, matches: false };

  const tableName = entry.table_name;
  const recordId = entry.record_id;
  const pk = TABLE_PK[tableName] || 'id';

  const allowedTables = Object.keys(TABLE_PK);
  if (!allowedTables.includes(tableName)) {
    return { entry, computed_hash: null, matches: false, error: 'table not whitelisted' };
  }

  let row: any = null;
  try {
    row = db.prepare(`SELECT * FROM "${tableName}" WHERE "${pk}" = ? LIMIT 1`).get(recordId) as any;
  } catch {
    return { entry, computed_hash: null, matches: false };
  }
  if (!row) {
    return { entry, computed_hash: null, matches: false, error: 'record not found' };
  }

  const { hashRow: hashRowFn } = await import('./hashUtils');
  const computed = hashRowFn(row);
  const stored = entry.new_hash || '';
  const matches = computed === stored;

  db.prepare(`UPDATE write_log SET verified = ? WHERE id = ?`).run(matches ? 1 : 0, logId);

  return { entry, computed_hash: computed, matches };
}

export function getVerificationReport(db: StateDb): {
  total: number; verified: number; unverified: number; failed: number; entries: any[];
} {
  const all = db.prepare(`SELECT * FROM write_log ORDER BY id DESC`).all() as any[];
  const total = all.length;
  let verified = 0, unverified = 0, failed = 0;
  for (const e of all) {
    if (e.verified === 1) verified++;
    else if (e.verified === -1) failed++;
    else unverified++;
  }
  return { total, verified, unverified, failed, entries: all.slice(0, 50) };
}

// ─── Generic table query helpers ───────────────────────────
const TABLE_PK: Record<string, string> = {
  identity: 'id',
  llm_sources: 'id',
  agent_notes: 'id',
  write_log: 'id',
  agent_personas: 'persona_id',
  models: 'model_id',
  model_rate_limits: 'model_id',
  workspaces: 'workspace_id',
  conversations: 'conversation_id',
  conversation_messages: 'id',
  rag_documents: 'document_id',
  rag_chunks: 'chunk_id',
  providers: 'id',
  provider_models: 'id',
  provider_tools: 'id',
  agent_profiles: 'id',
};

export function getPkForTable(table: string): string {
  return TABLE_PK[table] || 'id';
}

export function listAllFromTable(db: StateDb, table: string, limit = 100) {
  // Whitelist allowed tables for safety
  const allowed = Object.keys(TABLE_PK);
  if (!allowed.includes(table)) throw new Error(`Table '${table}' not in whitelist`);
  const orderCol = TABLE_PK[table];
  return db.prepare(`SELECT * FROM "${table}" ORDER BY "${orderCol}" DESC LIMIT ?`).all(limit);
}

export function getByIdFromTable(db: StateDb, table: string, idCol: string, idVal: string) {
  const allowed = ['identity','llm_sources','agent_notes','write_log',
    'agent_personas','models','model_rate_limits','workspaces',
    'conversations','conversation_messages','rag_documents','rag_chunks',
    'providers','provider_models','provider_tools','agent_profiles'];
  if (!allowed.includes(table)) throw new Error(`Table '${table}' not in whitelist`);
  // Validate idCol against known PK columns to prevent SQL injection
  const validPk = TABLE_PK[table] || 'id';
  const safeCol = idCol && idCol === validPk ? validPk : 'id';
  return db.prepare(`SELECT * FROM "${table}" WHERE "${safeCol}" = ? LIMIT 1`).get(idVal) || null;
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 — Provider Orchestration DB Functions
// ═══════════════════════════════════════════════════════════════

// ─── Providers ───────────────────────────────────────────
export function listProviders(db: StateDb) {
  return db.prepare(`SELECT * FROM providers ORDER BY priority DESC`).all();
}

export function getProvider(db: StateDb, id: string) {
  return db.prepare(`SELECT * FROM providers WHERE id = ? LIMIT 1`).get(id) || null;
}

export function upsertProvider(db: StateDb, p: {
  id: string; name: string; type?: string; base_url: string;
  api_key_env?: string; api_key?: string; priority?: number;
  is_active?: boolean; capabilities?: any; rate_limit_rpm?: number;
  rate_limit_tpm?: number;
}) {
  db.prepare(`
    INSERT INTO providers(id, name, type, base_url, api_key_env, api_key, priority,
      is_active, capabilities, rate_limit_rpm, rate_limit_tpm, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, type=excluded.type, base_url=excluded.base_url,
      api_key_env=excluded.api_key_env, api_key=excluded.api_key,
      priority=excluded.priority, is_active=excluded.is_active,
      capabilities=excluded.capabilities, rate_limit_rpm=excluded.rate_limit_rpm,
      rate_limit_tpm=excluded.rate_limit_tpm, updated_at=CURRENT_TIMESTAMP
  `).run(
    p.id, p.name, p.type || 'openai-compatible', p.base_url,
    p.api_key_env || null, p.api_key || null, p.priority || 0,
    p.is_active !== false ? 1 : 0, JSON.stringify(p.capabilities || {}),
    p.rate_limit_rpm || null, p.rate_limit_tpm || null
  );
}

export function deleteProvider(db: StateDb, id: string) {
  db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
}

export function updateProviderHealth(db: StateDb, id: string, status: string, errorCount?: number) {
  db.prepare(`
    UPDATE providers
    SET health_status = ?, last_health_check = CURRENT_TIMESTAMP,
        error_count = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, errorCount ?? 0, id);
}

// ─── Provider Models ─────────────────────────────────────
export function listProviderModels(db: StateDb, providerId?: string) {
  if (providerId) {
    return db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? AND is_active = 1 ORDER BY category, model_id`).all(providerId);
  }
  return db.prepare(`SELECT * FROM provider_models WHERE is_active = 1 ORDER BY provider_id, category, model_id`).all();
}

export function getProviderModel(db: StateDb, id: string) {
  return db.prepare(`SELECT * FROM provider_models WHERE id = ? LIMIT 1`).get(id) || null;
}

export function upsertProviderModel(db: StateDb, m: {
  id: string; provider_id: string; model_id: string;
  context_window?: number; max_output_tokens?: number; category?: string;
  input_price_per_1k?: number; output_price_per_1k?: number;
  is_free?: boolean; supports_tools?: boolean; supports_vision?: boolean;
  supports_streaming?: boolean; is_active?: boolean;
}) {
  db.prepare(`
    INSERT INTO provider_models(id, provider_id, model_id, context_window, max_output_tokens,
      category, input_price_per_1k, output_price_per_1k, is_free, supports_tools,
      supports_vision, supports_streaming, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      provider_id=excluded.provider_id, model_id=excluded.model_id,
      context_window=excluded.context_window, max_output_tokens=excluded.max_output_tokens,
      category=excluded.category, input_price_per_1k=excluded.input_price_per_1k,
      output_price_per_1k=excluded.output_price_per_1k, is_free=excluded.is_free,
      supports_tools=excluded.supports_tools, supports_vision=excluded.supports_vision,
      supports_streaming=excluded.supports_streaming, is_active=excluded.is_active,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    m.id, m.provider_id, m.model_id, m.context_window || 0, m.max_output_tokens || 0,
    m.category || 'other', m.input_price_per_1k || 0, m.output_price_per_1k || 0,
    m.is_free ? 1 : 0, m.supports_tools ? 1 : 0, m.supports_vision ? 1 : 0,
    m.supports_streaming !== false ? 1 : 0, m.is_active !== false ? 1 : 0
  );
}

export function upsertProviderModels(db: StateDb, models: Array<{
  id: string; provider_id: string; model_id: string;
  context_window?: number; max_output_tokens?: number; category?: string;
  input_price_per_1k?: number; output_price_per_1k?: number;
  is_free?: boolean; supports_tools?: boolean; supports_vision?: boolean;
  supports_streaming?: boolean; is_active?: boolean;
}>) {
  for (const m of models) {
    upsertProviderModel(db, m);
  }
}

export function deleteProviderModels(db: StateDb, providerId: string) {
  db.prepare(`DELETE FROM provider_models WHERE provider_id = ?`).run(providerId);
}

// ─── Provider Tools ──────────────────────────────────────
export function listProviderTools(db: StateDb, providerId?: string) {
  if (providerId) {
    return db.prepare(`SELECT * FROM provider_tools WHERE provider_id = ? ORDER BY tool_type, tool_name`).all(providerId);
  }
  return db.prepare(`SELECT * FROM provider_tools ORDER BY provider_id, tool_type, tool_name`).all();
}

export function getProviderToolsByType(db: StateDb, providerId: string, toolType: string) {
  return db.prepare(`SELECT * FROM provider_tools WHERE provider_id = ? AND tool_type = ? AND is_available = 1`).all(providerId, toolType);
}

export function upsertProviderTool(db: StateDb, t: {
  id: string; provider_id: string; tool_name: string; tool_type: string;
  description?: string; is_available?: boolean;
}) {
  db.prepare(`
    INSERT INTO provider_tools(id, provider_id, tool_name, tool_type, description, is_available, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      provider_id=excluded.provider_id, tool_name=excluded.tool_name,
      tool_type=excluded.tool_type, description=excluded.description,
      is_available=excluded.is_available, updated_at=CURRENT_TIMESTAMP
  `).run(
    t.id, t.provider_id, t.tool_name, t.tool_type,
    t.description || '', t.is_available !== false ? 1 : 0
  );
}

export function upsertProviderTools(db: StateDb, tools: Array<{
  id: string; provider_id: string; tool_name: string; tool_type: string;
  description?: string; is_available?: boolean;
}>) {
  for (const t of tools) {
    upsertProviderTool(db, t);
  }
}

export function deleteProviderTools(db: StateDb, providerId: string) {
  db.prepare(`DELETE FROM provider_tools WHERE provider_id = ?`).run(providerId);
}

export function updateProviderToolTest(db: StateDb, id: string, status: string) {
  db.prepare(`
    UPDATE provider_tools
    SET last_tested_at = CURRENT_TIMESTAMP, last_test_status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, id);
}

export function getProviderToolSummary(db: StateDb, providerId: string) {
  return db.prepare(`
    SELECT tool_type, COUNT(*) as count, SUM(is_available) as available
    FROM provider_tools WHERE provider_id = ?
    GROUP BY tool_type
  `).all(providerId);
}
