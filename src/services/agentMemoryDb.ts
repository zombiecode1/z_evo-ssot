/**
 * Agent Memory Database — জম্বিদের সকল কার্যক্রম ট্র্যাক করে
 * SQLite database for agent activity logging and statistics
 */

import path from 'path';

const DB_PATH = process.env.AGENT_MEMORY_DB || path.join(process.cwd(), 'agent_memory.db');

// Dynamic require to avoid TypeScript type issues
let BetterSqlite3: any;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch (e) {
  console.warn('better-sqlite3 not available, agent memory disabled');
}

let db: any = null;

function getDb(): any {
  if (!db && BetterSqlite3) {
    db = new BetterSqlite3(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  if (!db) return;

  db.exec(`
    -- Agent profiles (5 zombie agents)
    CREATE TABLE IF NOT EXISTS agent_profiles (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Agent activity log (every request)
    CREATE TABLE IF NOT EXISTS agent_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      response TEXT,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      duration_ms INTEGER,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Agent statistics (aggregated)
    CREATE TABLE IF NOT EXISTS agent_stats (
      agent_id TEXT PRIMARY KEY,
      total_requests INTEGER DEFAULT 0,
      successful_requests INTEGER DEFAULT 0,
      failed_requests INTEGER DEFAULT 0,
      avg_duration_ms REAL DEFAULT 0,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_activity_agent ON agent_activity(agent_id);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON agent_activity(created_at);
  `);

  // Seed default agent profiles
  const agents = [
    { agent_id: 'architect', name: 'Solution Architect', model: process.env.ZOMBIE_AGENT_ARCHITECT_MODEL || 'nemotron-3-ultra-free' },
    { agent_id: 'engineer', name: 'Development Engineer', model: process.env.ZOMBIE_AGENT_ENGINEER_MODEL || 'deepseek-v4-flash-free' },
    { agent_id: 'qa', name: 'Quality Assurance', model: process.env.ZOMBIE_AGENT_QA_MODEL || 'big-pickle' },
    { agent_id: 'docs', name: 'Documentation', model: process.env.ZOMBIE_AGENT_DOCS_MODEL || 'mimo-v2.5-free' },
    { agent_id: 'ops', name: 'Operations', model: process.env.ZOMBIE_AGENT_OPS_MODEL || 'nemotron-3-ultra-free' },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO agent_profiles (agent_id, name, model) VALUES (?, ?, ?)
  `);

  const insertStats = db.prepare(`
    INSERT OR IGNORE INTO agent_stats (agent_id) VALUES (?)
  `);

  for (const agent of agents) {
    insert.run(agent.agent_id, agent.name, agent.model);
    insertStats.run(agent.agent_id);
  }
}

// ─── Public API ──────────────────────────────────────────────

export interface AgentActivityLog {
  agent_id: string;
  prompt: string;
  response?: string;
  model: string;
  status: 'success' | 'error' | 'timeout';
  error_message?: string;
  duration_ms?: number;
  tokens_input?: number;
  tokens_output?: number;
}

export interface AgentStats {
  agent_id: string;
  name: string;
  model: string;
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  avg_duration_ms: number;
  last_used_at: string | null;
}

export interface AgentActivityRow extends AgentActivityLog {
  id: number;
  created_at: string;
}

export function logAgentActivity(log: AgentActivityLog): number {
  const db = getDb();
  if (!db) return 0;
  
  const insert = db.prepare(`
    INSERT INTO agent_activity (agent_id, prompt, response, model, status, error_message, duration_ms, tokens_input, tokens_output)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    log.agent_id,
    log.prompt,
    log.response || null,
    log.model,
    log.status,
    log.error_message || null,
    log.duration_ms || null,
    log.tokens_input || 0,
    log.tokens_output || 0
  );

  // Update stats
  const isSuccess = log.status === 'success' ? 1 : 0;
  db.prepare(`
    UPDATE agent_stats SET
      total_requests = total_requests + 1,
      successful_requests = successful_requests + ?,
      failed_requests = failed_requests + ?,
      avg_duration_ms = CASE 
        WHEN total_requests = 0 THEN ? 
        ELSE (avg_duration_ms * total_requests + ?) / (total_requests + 1)
      END,
      last_used_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE agent_id = ?
  `).run(isSuccess, 1 - isSuccess, log.duration_ms || 0, log.duration_ms || 0, log.agent_id);

  return Number(result.lastInsertRowid);
}

export function getAgentStats(): AgentStats[] {
  const db = getDb();
  if (!db) return [];
  return db.prepare(`
    SELECT 
      ap.agent_id,
      ap.name,
      ap.model,
      COALESCE(ast.total_requests, 0) as total_requests,
      COALESCE(ast.successful_requests, 0) as successful_requests,
      COALESCE(ast.failed_requests, 0) as failed_requests,
      COALESCE(ast.avg_duration_ms, 0) as avg_duration_ms,
      ast.last_used_at
    FROM agent_profiles ap
    LEFT JOIN agent_stats ast ON ap.agent_id = ast.agent_id
    ORDER BY ap.agent_id
  `).all();
}

export function getAgentActivity(agentId?: string, limit: number = 50): AgentActivityRow[] {
  const db = getDb();
  if (!db) return [];
  if (agentId) {
    return db.prepare(`
      SELECT * FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(agentId, limit);
  }
  return db.prepare(`
    SELECT * FROM agent_activity ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

export function getAgentActivitySummary() {
  const db = getDb();
  if (!db) return { total_requests: 0, successful_requests: 0, failed_requests: 0, by_agent: [] };
  
  const total = db.prepare('SELECT COUNT(*) as count FROM agent_activity').get();
  const success = db.prepare("SELECT COUNT(*) as count FROM agent_activity WHERE status = 'success'").get();
  const failed = db.prepare("SELECT COUNT(*) as count FROM agent_activity WHERE status = 'error'").get();
  const byAgent = db.prepare(`
    SELECT agent_id, COUNT(*) as count FROM agent_activity GROUP BY agent_id
  `).all();

  return {
    total_requests: total?.count || 0,
    successful_requests: success?.count || 0,
    failed_requests: failed?.count || 0,
    by_agent: byAgent,
  };
}

// Initialize on import
getDb();
