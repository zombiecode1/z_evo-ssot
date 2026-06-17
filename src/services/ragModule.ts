/**
 * RAGModule — Self-Healing SSOT Integration for Agents
 *
 * This module sits between any agent and the DiskRAGService, providing:
 *   1. Lazy SSOT initialization (create on first access)
 *   2. Automatic rescan when files change
 *   3. Session memory per conversation
 *   4. State persistence (flag: 0=missing, 1=active)
 *
 * Core principle: Every agent request goes through ensureSSOT() first.
 * If SSOT.md exists and is current, use it.
 * If not, create it. Then use it.
 * The agent never works blind.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DiskRAGService } from './ragService';

// ─── State Types ──────────────────────────────────────────────

export interface SSOTState {
  directory: string;
  flag: 0 | 1;
  lastScan: number;
  lastModified: number;
  fileCount: number;
  contentHash: string;
}

export interface RAGModuleConfig {
  enabled: boolean;
  maxChunks: number;
  maxSessionMessages: number;
  autoDetectIntent: boolean;
  rescanThreshold: number; // file count diff to trigger rescan
}

const DEFAULT_CONFIG: RAGModuleConfig = {
  enabled: true,
  maxChunks: 5,
  maxSessionMessages: 20,
  autoDetectIntent: true,
  rescanThreshold: 1,
};

// ─── Intent Keywords ──────────────────────────────────────────
// Keywords that signal the user wants project documentation context.

const RAG_KEYWORDS = [
  'documentation', 'docs', 'how to', 'what is', 'explain', 'guide',
  'manual', 'readme', 'project', 'code', 'function', 'class',
  'api', 'endpoint', 'route', 'service', 'config', 'setup',
  'install', 'deploy', 'architecture', 'structure', 'dependency',
];

// ─── RAGModule Class ──────────────────────────────────────────

export class RAGModule {
  private rag: DiskRAGService;
  private stateMap: Map<string, SSOTState>;
  private sessionBuffers: Map<string, string[]>;
  private config: RAGModuleConfig;

  constructor(config?: Partial<RAGModuleConfig>) {
    this.rag = new DiskRAGService();
    this.stateMap = new Map();
    this.sessionBuffers = new Map();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Ensure SSOT.md exists and is current for the given directory.
   * This is the primary entry point — every agent request should call this.
   *
   * Flow:
   *   1. Check state flag
   *   2. If flag=1, check file count for staleness
   *   3. If flag=0 or stale, create/rescan SSOT
   *   4. Return SSOT content
   */
  async ensureSSOT(directory: string): Promise<string> {
    if (!this.config.enabled) return '';

    const resolved = path.resolve(directory);
    const state = this.getState(resolved);

    // Case 1: SSOT already exists and is current
    if (state.flag === 1) {
      const currentFileCount = this.countFiles(resolved);
      const diff = Math.abs(currentFileCount - state.fileCount);

      if (diff <= this.config.rescanThreshold) {
        // No significant change — read existing SSOT
        return this.rag.readSSOT();
      }

      // Files changed significantly — rescan
      console.log(
        `[RAG] Files changed in ${resolved} (${state.fileCount} -> ${currentFileCount}). Rescanning...`
      );
      await this.rescanSSOT(resolved);
      return this.rag.readSSOT();
    }

    // Case 2: SSOT does not exist — create it
    console.log(`[RAG] No SSOT for ${resolved}. Creating...`);
    await this.createSSOT(resolved);
    return this.rag.readSSOT();
  }

  /**
   * Search SSOT for relevant context based on a query.
   * Returns matching sections (up to maxChunks).
   */
  searchContext(query: string): string {
    if (!this.config.enabled) return '';
    return this.rag.searchSSOT(query);
  }

  /**
   * Check if the user message likely needs RAG context.
   * Uses keyword matching for fast detection.
   */
  detectRagIntent(message: string): boolean {
    if (!this.config.autoDetectIntent) return false;
    const lower = message.toLowerCase();
    return RAG_KEYWORDS.some(kw => lower.includes(kw));
  }

  /**
   * Get combined context: SSOT base + relevant search results.
   * This is what gets injected into the agent's system prompt.
   */
  getFullContext(query: string): string {
    if (!this.config.enabled) return '';

    const parts: string[] = [];

    // Always include SSOT base (project structure, deps, etc.)
    const ssot = this.rag.readSSOT();
    if (ssot) {
      parts.push('--- Project Documentation (SSOT) ---');
      parts.push(ssot);
    }

    // Add search-specific context if query provided
    if (query) {
      const searchResult = this.rag.searchSSOT(query);
      if (searchResult && searchResult !== ssot) {
        parts.push('--- Relevant Sections ---');
        parts.push(searchResult);
      }
    }

    // Add session context (recent conversation)
    // Note: sessionId not available here; caller should add it
    return parts.join('\n\n');
  }

  // ─── Session Memory ────────────────────────────────────────

  /**
   * Add a message to the session buffer.
   */
  addToSession(sessionId: string, message: string): void {
    const buf = this.sessionBuffers.get(sessionId) || [];
    buf.push(message);
    if (buf.length > this.config.maxSessionMessages) {
      buf.shift();
    }
    this.sessionBuffers.set(sessionId, buf);
  }

  /**
   * Get recent session messages as context string.
   */
  getSessionContext(sessionId: string): string {
    const buf = this.sessionBuffers.get(sessionId) || [];
    return buf.join('\n');
  }

  /**
   * Clear session buffer (e.g. on conversation end).
   */
  clearSession(sessionId: string): void {
    this.sessionBuffers.delete(sessionId);
  }

  // ─── SSOT Operations ───────────────────────────────────────

  /**
   * Force update SSOT for a directory (manual rescan).
   */
  async rescanSSOT(directory: string): Promise<void> {
    const resolved = path.resolve(directory);

    try {
      await this.rag.setWorkingDirectory(resolved, { autoInit: true });
    } catch (e: any) {
      console.warn(`[RAG] rescanSSOT failed for ${resolved}:`, e?.message || e);
      return;
    }

    const fileCount = this.countFiles(resolved);
    const content = this.rag.readSSOT();
    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

    this.setState(resolved, {
      directory: resolved,
      flag: 1,
      lastScan: Date.now(),
      lastModified: Date.now(),
      fileCount,
      contentHash,
    });
  }

  /**
   * Create SSOT from scratch for a directory.
   */
  async createSSOT(directory: string): Promise<void> {
    const resolved = path.resolve(directory);

    try {
      const { needsPermission } = await this.rag.setWorkingDirectory(resolved, { autoInit: true });
      if (needsPermission) {
        console.warn(`[RAG] Permission required for ${resolved}`);
        return;
      }
    } catch (e: any) {
      console.warn(`[RAG] createSSOT failed for ${resolved}:`, e?.message || e);
      return;
    }

    const fileCount = this.countFiles(resolved);
    const content = this.rag.readSSOT();
    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

    this.setState(resolved, {
      directory: resolved,
      flag: 1,
      lastScan: Date.now(),
      lastModified: Date.now(),
      fileCount,
      contentHash,
    });

    console.log(`[RAG] SSOT created for ${resolved} (${fileCount} files)`);
  }

  /**
   * Check if SSOT exists for a directory (without creating).
   */
  ssotExists(directory: string): boolean {
    const resolved = path.resolve(directory);
    return this.rag.ssotExists();
  }

  /**
   * Manually set the state flag (for persistence restore).
   */
  setState(directory: string, state: SSOTState): void {
    this.stateMap.set(path.resolve(directory), state);
  }

  /**
   * Get current state for a directory.
   */
  getState(directory: string): SSOTState {
    const resolved = path.resolve(directory);
    return this.stateMap.get(resolved) || {
      directory: resolved,
      flag: 0,
      lastScan: 0,
      lastModified: 0,
      fileCount: 0,
      contentHash: '',
    };
  }

  /**
   * Get all tracked directories and their states.
   */
  getAllStates(): SSOTState[] {
    return Array.from(this.stateMap.values());
  }

  // ─── Internal Helpers ──────────────────────────────────────

  /**
   * Count files in directory (excluding hidden dirs and node_modules).
   */
  private countFiles(directory: string): number {
    let count = 0;
    try {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
          count += this.countFiles(path.join(directory, entry.name));
        } else {
          count++;
        }
      }
    } catch { /* ignore permission errors */ }
    return count;
  }
}
