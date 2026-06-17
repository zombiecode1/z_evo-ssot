import { Request, Response } from 'express';
import { initStateDb, getStateDb, setStateDb } from '../services/stateDb';
import * as db from '../services/stateDb';
import path from 'path';
import { hashRow } from '../services/hashUtils';

function getDb(): any {
  const d = getStateDb();
  if (!d) throw new Error('state db not initialized');
  return d;
}

// ─── Whitelisted tables (SQL injection prevention) ────────────
const ALLOWED_TABLES = [
  'identity', 'llm_sources', 'agent_notes', 'write_log',
  'agent_personas', 'models', 'model_rate_limits', 'workspaces',
  'conversations', 'conversation_messages', 'rag_documents', 'rag_chunks',
];

function validateTableName(table: string): void {
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error(`Table "${table}" is not whitelisted. Allowed: ${ALLOWED_TABLES.join(', ')}`);
  }
}

function sanitizeError(error: any): string {
  // Don't leak internal details in production
  if (process.env.NODE_ENV === 'production') {
    return 'Internal server error';
  }
  return error?.message || String(error);
}

// ─── Generic: list any whitelisted table ───────────────────
export function handleDbList(req: Request, res: Response) {
  try {
    const table = req.params.table;
    validateTableName(table);
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const rows = db.listAllFromTable(getDb(), table, limit);
    res.json({ table, count: rows.length, rows });
  } catch (e: any) {
    res.status(400).json({ error: sanitizeError(e) });
  }
}

// ─── Generic: get one row by id ───────────────────────────
export function handleDbGet(req: Request, res: Response) {
  try {
    const table = req.params.table;
    validateTableName(table);
    const idCol = req.query.idCol as string || 'id';
    const idVal = req.params.id;
    const row = db.getByIdFromTable(getDb(), table, idCol, idVal);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ table, row });
  } catch (e: any) {
    res.status(400).json({ error: sanitizeError(e) });
  }
}

// ─── Identity ─────────────────────────────────────────────
export function handleGetIdentity(_req: Request, res: Response) {
  try {
    const row = db.getIdentity(getDb());
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function handleUpdateIdentity(req: Request, res: Response) {
  try {
    const allowedFields = ['name','version','tagline','owner','organization',
      'address','location','phone','email','website','license'];
    const updates: Record<string, any> = {};
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no valid fields provided' });
    }
    db.upsertIdentity(getDb(), updates);
    const row = db.getIdentity(getDb());
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ─── LLM Sources ──────────────────────────────────────────
export function handleListLlmSources(_req: Request, res: Response) {
  try {
    const rows = db.listLlmSources(getDb());
    res.json({ count: rows.length, sources: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function handleCreateLlmSource(req: Request, res: Response) {
  try {
    const { name, base_url, api_key_env, priority } = req.body;
    if (!name || !base_url) return res.status(400).json({ error: 'name and base_url required' });
    
    // Validate URL format
    try {
      new URL(base_url);
    } catch {
      return res.status(400).json({ error: 'Invalid base_url format' });
    }
    
    // Sanitize name (no special characters)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: 'name must be alphanumeric (letters, numbers, _, -)' });
    }
    
    const row = db.upsertLlmSource(getDb(), { name, base_url, api_key_env, priority: priority || 999 });
    res.status(201).json({ success: true, source: { name, base_url, priority: priority || 999 } });
  } catch (e: any) {
    res.status(500).json({ error: sanitizeError(e) });
  }
}

export function handleDeleteLlmSource(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    db.deleteLlmSource(getDb(), id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ─── Agent Notes ───────────────────────────────────────────
export function handleListAgentNotes(req: Request, res: Response) {
  try {
    const workspace = req.query.workspace_id as string;
    const category = req.query.category as string;
    const rows = db.listAgentNotes(getDb(), workspace, category);
    res.json({ count: rows.length, notes: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function handleCreateAgentNote(req: Request, res: Response) {
  try {
    const { workspace_id, key, content, category } = req.body;
    if (!key || !content) return res.status(400).json({ error: 'key and content required' });
    const row = db.upsertAgentNote(getDb(), { workspace_id, key, content, category });
    res.status(201).json({ success: true, key, version: 1 });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function handleGetAgentNote(req: Request, res: Response) {
  try {
    const row = db.getAgentNote(getDb(), req.params.key);
    if (!row) return res.status(404).json({ error: 'note not found' });
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function handleDeleteAgentNote(req: Request, res: Response) {
  try {
    db.deleteAgentNote(getDb(), req.params.key);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ─── Write Log ─────────────────────────────────────────────
export function handleListWriteLog(req: Request, res: Response) {
  try {
    const table = req.query.table_name as string;
    const limit = parseInt(req.query.limit as string) || 100;
    const rows = db.listWriteLog(getDb(), table, limit);
    res.json({ count: rows.length, entries: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function handleCreateWriteLog(req: Request, res: Response) {
  try {
    const { table_name, record_id, action, old_hash, new_hash, source_url } = req.body;
    if (!table_name || !record_id || !action) {
      return res.status(400).json({ error: 'table_name, record_id, action required' });
    }
    db.addWriteLog(getDb(), { table_name, record_id, action, old_hash, new_hash, source_url });
    res.status(201).json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 3 — Write Verification
// ═══════════════════════════════════════════════════════════════

export function handleWriteLogWithHash(req: Request, res: Response) {
  try {
    const { table_name, record_id, action, old_hash, new_hash, source_url } = req.body;
    if (!table_name || !record_id || !action) {
      return res.status(400).json({ error: 'table_name, record_id, action required' });
    }
    db.addWriteLogWithHash(getDb(), { table_name, record_id, action, old_hash, new_hash, source_url });
    res.status(201).json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export async function handleVerifyEntry(req: Request, res: Response) {
  try {
    const logId = parseInt(req.params.id);
    if (isNaN(logId)) return res.status(400).json({ error: 'invalid log id' });
    const result = await db.verifyWriteLogEntry(getDb(), logId);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function handleVerifyReport(_req: Request, res: Response) {
  try {
    const report = db.getVerificationReport(getDb());
    res.json(report);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function handleVerifyWriteRead(req: Request, res: Response) {
  try {
    const { table_name, record_id, id_col } = req.body;
    if (!table_name || !record_id) return res.status(400).json({ error: 'table_name and record_id required' });

    const allowed = ['identity','llm_sources','agent_notes','write_log',
      'agent_personas','models','model_rate_limits','workspaces',
      'conversations','conversation_messages','rag_documents','rag_chunks'];
    if (!allowed.includes(table_name)) return res.status(400).json({ error: 'table not whitelisted' });

    // Validate id_col to prevent SQL injection — only allow known PK columns
    const validPk = db.getPkForTable(table_name);
    const pk = (id_col && id_col === validPk) ? validPk : validPk;
    let row: any = null;
    try {
      row = getDb().prepare(`SELECT * FROM "${table_name}" WHERE "${pk}" = ? LIMIT 1`).get(record_id);
    } catch {
      return res.status(404).json({ error: 'table or record not found' });
    }
    if (!row) return res.status(404).json({ error: 'record not found' });

    const hash = hashRow(row);

    const logEntries = db.listWriteLog(getDb(), table_name, 10)
      .filter((e: any) => e.record_id === record_id);

    res.json({
      verified: true,
      current_hash: hash,
      row,
      recent_logs: logEntries,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ─── DB Stats ──────────────────────────────────────────────
export function handleDbStats(_req: Request, res: Response) {
  try {
    const db = getDb();
    const tables = ['identity','llm_sources','agent_notes','write_log',
      'agent_personas','models','model_rate_limits','workspaces',
      'conversations','conversation_messages','rag_documents','rag_chunks'];
    const stats: Record<string, number> = {};
    for (const t of tables) {
      try {
        const r = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get() as any;
        stats[t] = r?.c || 0;
      } catch { stats[t] = -1; }
    }
    res.json({ database: 'state.db', stats });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}
