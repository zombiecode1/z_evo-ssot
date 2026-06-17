import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { ZombieCoderConfig } from "../../agent.config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseInstance = any;

export interface ConversationMessage {
  id?: number;
  session_id: string;
  agent_name: string;
  role: "user" | "assistant" | "system";
  content: string;
  model_used?: string;
  tokens_used?: number;
  metadata?: string; // JSON string
  created_at?: string;
}

export interface SessionInfo {
  session_id: string;
  agent_name: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  total_tokens: number;
}

export interface MemoryStats {
  total_sessions: number;
  total_messages: number;
  total_tokens: number;
  sessions_by_agent: Record<string, number>;
  messages_by_agent: Record<string, number>;
}

export class MemoryService {
  private static instance: MemoryService;
  private db: DatabaseInstance = null;
  private dbPath: string;

  private constructor() {
    this.dbPath = ZombieCoderConfig.project.memory_db_path;
  }

  public static getInstance(): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService();
    }
    return MemoryService.instance;
  }

  /**
   * Initialize the database connection and create tables if needed
   */
  public initialize(): void {
    try {
      // Ensure the directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.createTables();
      console.log(`[MemoryService] Database initialized at ${this.dbPath}`);
    } catch (error) {
      console.error(`[MemoryService] Failed to initialize database: ${error}`);
      throw error;
    }
  }

  /**
   * Create the necessary tables
   */
  private createTables(): void {
    if (!this.db) throw new Error("Database not initialized");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        model_used TEXT,
        tokens_used INTEGER DEFAULT 0,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_name);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_name);
    `);
  }

  /**
   * Ensure database is initialized
   */
  private ensureDb(): void {
    if (!this.db) {
      this.initialize();
    }
  }

  // ─── Session Management ─────────────────────────────────

  /**
   * Create a new session
   */
  public createSession(sessionId: string, agentName: string): void {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      INSERT OR IGNORE INTO sessions (session_id, agent_name) VALUES (?, ?)
    `);
    stmt.run(sessionId, agentName);
  }

  /**
   * Get session info
   */
  public getSession(sessionId: string): SessionInfo | null {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      SELECT 
        s.session_id,
        s.agent_name,
        s.created_at,
        s.updated_at,
        COUNT(m.id) as message_count,
        COALESCE(SUM(m.tokens_used), 0) as total_tokens
      FROM sessions s
      LEFT JOIN messages m ON s.session_id = m.session_id
      WHERE s.session_id = ?
      GROUP BY s.session_id
    `);
    return stmt.get(sessionId) as SessionInfo | null;
  }

  /**
   * Get all sessions for an agent
   */
  public getSessionsByAgent(agentName: string): SessionInfo[] {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      SELECT 
        s.session_id,
        s.agent_name,
        s.created_at,
        s.updated_at,
        COUNT(m.id) as message_count,
        COALESCE(SUM(m.tokens_used), 0) as total_tokens
      FROM sessions s
      LEFT JOIN messages m ON s.session_id = m.session_id
      WHERE s.agent_name = ?
      GROUP BY s.session_id
      ORDER BY s.updated_at DESC
    `);
    return stmt.all(agentName) as SessionInfo[];
  }

  // ─── Message Management ─────────────────────────────────

  /**
   * Add a message to a session
   */
  public addMessage(message: ConversationMessage): number {
    this.ensureDb();

    // Ensure session exists
    this.createSession(message.session_id, message.agent_name);

    const stmt = this.db!.prepare(`
      INSERT INTO messages (session_id, agent_name, role, content, model_used, tokens_used, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      message.session_id,
      message.agent_name,
      message.role,
      message.content,
      message.model_used || null,
      message.tokens_used || 0,
      message.metadata || null
    );

    // Update session's updated_at
    this.db!.prepare(`
      UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE session_id = ?
    `).run(message.session_id);

    return result.lastInsertRowid as number;
  }

  /**
   * Get messages for a session
   */
  public getMessages(sessionId: string, limit: number = 50, offset: number = 0): ConversationMessage[] {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(sessionId, limit, offset) as ConversationMessage[];
  }

  /**
   * Get recent messages for context
   */
  public getRecentMessages(sessionId: string, count: number = 10): ConversationMessage[] {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      ) ORDER BY created_at ASC
    `);
    return stmt.all(sessionId, count) as ConversationMessage[];
  }

  /**
   * Search messages by content
   */
  public searchMessages(query: string, agentName?: string, limit: number = 20): ConversationMessage[] {
    this.ensureDb();
    let stmt;
    if (agentName) {
      stmt = this.db!.prepare(`
        SELECT * FROM messages
        WHERE content LIKE ? AND agent_name = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      return stmt.all(`%${query}%`, agentName, limit) as ConversationMessage[];
    } else {
      stmt = this.db!.prepare(`
        SELECT * FROM messages
        WHERE content LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      return stmt.all(`%${query}%`, limit) as ConversationMessage[];
    }
  }

  // ─── Context Building ───────────────────────────────────

  /**
   * Build context string from recent messages for LLM
   */
  public buildContext(sessionId: string, maxMessages: number = 10): string {
    const messages = this.getRecentMessages(sessionId, maxMessages);
    if (messages.length === 0) return "";

    return messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");
  }

  /**
   * Get token usage for a session
   */
  public getSessionTokens(sessionId: string): number {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      SELECT COALESCE(SUM(tokens_used), 0) as total FROM messages WHERE session_id = ?
    `);
    const result = stmt.get(sessionId) as { total: number };
    return result.total;
  }

  // ─── Cleanup & Stats ────────────────────────────────────

  /**
   * Delete old sessions (older than specified days)
   */
  public cleanupOldSessions(daysOld: number = 30): number {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      DELETE FROM sessions WHERE created_at < datetime('now', '-' || ? || ' days')
    `);
    const result = stmt.run(daysOld);
    return result.changes;
  }

  /**
   * Delete a specific session and its messages
   */
  public deleteSession(sessionId: string): void {
    this.ensureDb();
    this.db!.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  /**
   * Get memory statistics
   */
  public getStats(): MemoryStats {
    this.ensureDb();

    const totalSessions = (this.db!.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count;
    const totalMessages = (this.db!.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number }).count;
    const totalTokens = (this.db!.prepare("SELECT COALESCE(SUM(tokens_used), 0) as total FROM messages").get() as { total: number }).total;

    const sessionsByAgent = this.db!.prepare(
      "SELECT agent_name, COUNT(*) as count FROM sessions GROUP BY agent_name"
    ).all() as Array<{ agent_name: string; count: number }>;

    const messagesByAgent = this.db!.prepare(
      "SELECT agent_name, COUNT(*) as count FROM messages GROUP BY agent_name"
    ).all() as Array<{ agent_name: string; count: number }>;

    return {
      total_sessions: totalSessions,
      total_messages: totalMessages,
      total_tokens: totalTokens,
      sessions_by_agent: Object.fromEntries(sessionsByAgent.map((r) => [r.agent_name, r.count])),
      messages_by_agent: Object.fromEntries(messagesByAgent.map((r) => [r.agent_name, r.count])),
    };
  }

  /**
   * Close database connection
   */
  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log("[MemoryService] Database connection closed");
    }
  }
}
