import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  StateDb,
  deleteRagChunksForDocument,
  getRagIndexStats,
  listRagChunks,
  upsertRagChunk,
  upsertRagDocument,
} from './stateDb';

type EmbeddingProvider = {
  queryEmbed(query: string): Promise<number[]>;
  passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
};

export interface IndexedChunk {
  chunk_id: string;
  source_path: string;
  chunk_index: number;
  chunk_text: string;
  score: number;
  token_count: number;
  metadata: Record<string, unknown>;
}

export interface IndexResult {
  workspaceId?: string;
  directory: string;
  filesScanned: number;
  documentsIndexed: number;
  chunksIndexed: number;
  skippedFiles: number;
}

export interface SearchResult {
  query: string;
  matches: IndexedChunk[];
}

const DEFAULT_ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.txt', '.html', '.css', '.scss',
  '.yml', '.yaml', '.py', '.go', '.java', '.rs',
]);

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function wordCount(text: string): number {
  const tokens = text.match(/[A-Za-z0-9_]+/g);
  return tokens ? tokens.length : 0;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function chunkText(text: string, maxChars = 1400, overlapChars = 180): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let buffer = '';

  const flushBuffer = () => {
    const clean = buffer.trim();
    if (!clean) return;
    if (clean.length <= maxChars) {
      chunks.push(clean);
      buffer = '';
      return;
    }

    for (let i = 0; i < clean.length; i += maxChars - overlapChars) {
      const slice = clean.slice(i, i + maxChars).trim();
      if (slice) chunks.push(slice);
    }
    buffer = '';
  };

  for (const paragraph of paragraphs) {
    const piece = paragraph.trim();
    if (!piece) continue;
    if ((buffer + '\n\n' + piece).trim().length > maxChars) {
      flushBuffer();
    }
    if (piece.length > maxChars) {
      for (let i = 0; i < piece.length; i += maxChars - overlapChars) {
        const slice = piece.slice(i, i + maxChars).trim();
        if (slice) chunks.push(slice);
      }
    } else {
      buffer = buffer ? `${buffer}\n\n${piece}` : piece;
    }
  }

  flushBuffer();
  return chunks;
}

async function collectEmbeddings(provider: EmbeddingProvider, texts: string[]): Promise<number[][]> {
  const output: number[][] = [];
  for await (const batch of provider.passageEmbed(texts, 16)) {
    output.push(...batch);
  }
  return output;
}

function isLikelyTextFile(filePath: string): boolean {
  return DEFAULT_ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || path.basename(filePath) === 'README';
}

export class VectorIndexService {
  private embedder: EmbeddingProvider | null = null;
  private embedderReady: Promise<EmbeddingProvider | null> | null = null;
  private lastIndexError: string | null = null;
  private indexingLock: Promise<IndexResult> | null = null;

  constructor(private db: StateDb) {}

  async ensureEmbedder(): Promise<EmbeddingProvider | null> {
    if (this.embedder) return this.embedder;
    if (this.embedderReady) return this.embedderReady;

    this.embedderReady = this.initEmbedder();
    this.embedder = await this.embedderReady;
    return this.embedder;
  }

  getLastIndexError(): string | null {
    return this.lastIndexError;
  }

  getStats() {
    return getRagIndexStats(this.db);
  }

  async indexDirectory(directory: string, opts?: { workspaceId?: string; maxFiles?: number }): Promise<IndexResult> {
    // Prevent concurrent indexing of the same directory
    if (this.indexingLock) {
      return this.indexingLock;
    }
    this.indexingLock = this._doIndexDirectory(directory, opts);
    try {
      return await this.indexingLock;
    } finally {
      this.indexingLock = null;
    }
  }

  private async _doIndexDirectory(directory: string, opts?: { workspaceId?: string; maxFiles?: number }): Promise<IndexResult> {
    const root = path.resolve(directory);
    const files = this.collectFiles(root, opts?.maxFiles ?? 500);
    const embedder = await this.ensureEmbedder();
    let documentsIndexed = 0;
    let chunksIndexed = 0;
    let skippedFiles = 0;

    for (const filePath of files) {
      const raw = this.readTextFile(filePath);
      if (!raw) {
        skippedFiles++;
        continue;
      }

      const normalized = normalizeText(raw);
      const contentHash = sha256(normalized);
      const documentId = sha256(`${opts?.workspaceId || ''}:${path.relative(root, filePath)}`);
      const chunks = chunkText(normalized);
      if (chunks.length === 0) {
        skippedFiles++;
        continue;
      }

      upsertRagDocument(this.db, {
        document_id: documentId,
        workspace_id: opts?.workspaceId || null,
        source_path: path.relative(root, filePath),
        content_hash: contentHash,
        chunk_count: chunks.length,
      });
      deleteRagChunksForDocument(this.db, documentId);

      const embeddings = embedder
        ? await collectEmbeddings(embedder, chunks.map(chunk => `passage: ${chunk}`))
        : chunks.map(chunk => fallbackEmbedding(chunk));

      for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddings[i] || fallbackEmbedding(chunks[i]);
        const chunkId = sha256(`${documentId}:${i}:${contentHash}`);
        upsertRagChunk(this.db, {
          chunk_id: chunkId,
          document_id: documentId,
          workspace_id: opts?.workspaceId || null,
          source_path: path.relative(root, filePath),
          chunk_index: i,
          chunk_text: chunks[i],
          content_hash: contentHash,
          embedding_json: JSON.stringify(embedding),
          embedding_dim: embedding.length,
          token_count: wordCount(chunks[i]),
          metadata_json: JSON.stringify({
            file_size: raw.length,
            indexed_from: root,
          }),
        });
        chunksIndexed++;
      }

      documentsIndexed++;
    }

    return {
      workspaceId: opts?.workspaceId,
      directory: root,
      filesScanned: files.length,
      documentsIndexed,
      chunksIndexed,
      skippedFiles,
    };
  }

  async search(query: string, opts?: { workspaceId?: string; limit?: number }): Promise<SearchResult> {
    const limit = Math.max(1, opts?.limit ?? 5);
    const embedder = await this.ensureEmbedder();
    const rows = listRagChunks(this.db, opts?.workspaceId || null, 1000);
    if (!rows.length) {
      return { query, matches: [] };
    }

    const queryEmbedding = embedder
      ? await embedder.queryEmbed(`query: ${query}`)
      : fallbackEmbedding(query);

    const scored = rows.map((row: any) => {
      const embedding = JSON.parse(row.embedding_json || '[]') as number[];
      const score = cosineSimilarity(queryEmbedding, embedding);
      return {
        chunk_id: row.chunk_id,
        source_path: row.source_path,
        chunk_index: row.chunk_index,
        chunk_text: row.chunk_text,
        score,
        token_count: row.token_count || 0,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      } as IndexedChunk;
    });

    scored.sort((a: IndexedChunk, b: IndexedChunk) => b.score - a.score || a.source_path.localeCompare(b.source_path) || a.chunk_index - b.chunk_index);

    return {
      query,
      matches: scored.slice(0, limit),
    };
  }

  async buildAndSearch(directory: string, query: string, opts?: { workspaceId?: string; limit?: number }): Promise<SearchResult> {
    await this.indexDirectory(directory, { workspaceId: opts?.workspaceId });
    return this.search(query, { workspaceId: opts?.workspaceId, limit: opts?.limit });
  }

  private async initEmbedder(): Promise<EmbeddingProvider | null> {
    const mode = (process.env.EMBEDDING_BACKEND || 'fastembed').toLowerCase();
    if (mode === 'fallback') {
      this.lastIndexError = 'Embedding backend forced to fallback.';
      return null;
    }

    // Load the native `fastembed` package at runtime to avoid crashing
    // when the package exposes no runtime entry point (missing index.js).
    let fastembed: any;
    try {
      // Require dynamically to prevent a hard dependency at module load time.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fastembed = require('fastembed');
    } catch (err: any) {
      this.lastIndexError = `Failed to load fastembed: ${err?.message || String(err)}`;
      return null;
    }

    try {
      const modelName = process.env.FASTEMBED_MODEL || fastembed?.EmbeddingModel?.BGESmallENV15;
      const cacheDir = process.env.FASTEMBED_CACHE_DIR || path.join(process.cwd(), '.zombiecoder', 'embedding-cache');
      const customDir = process.env.FASTEMBED_CUSTOM_MODEL_DIR;

      if (customDir) {
        const embedder = await fastembed.FlagEmbedding.init({
          model: fastembed?.EmbeddingModel?.CUSTOM ?? 'CUSTOM',
          modelAbsoluteDirPath: customDir,
          modelName: process.env.FASTEMBED_CUSTOM_MODEL_NAME || 'custom-embedding-model',
          cacheDir,
          showDownloadProgress: false,
        } as any);
        return embedder as unknown as EmbeddingProvider;
      }

      const embedder = await fastembed.FlagEmbedding.init({
        model: modelName as any,
        cacheDir,
        showDownloadProgress: false,
      } as any);
      return embedder as unknown as EmbeddingProvider;
    } catch (err: any) {
      this.lastIndexError = err?.message || String(err);
      return null;
    }
  }

  private collectFiles(root: string, maxFiles: number): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (out.length >= maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= maxFiles) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'logs') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!isLikelyTextFile(full)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 1024 * 1024) continue;
        } catch {
          continue;
        }
        out.push(full);
      }
    };
    walk(root);
    return out;
  }

  private readTextFile(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }
}

function fallbackEmbedding(text: string, dim = 384): number[] {
  const vector = new Array(dim).fill(0);
  const tokens = (text.toLowerCase().match(/[a-z0-9_]+/g) || []).slice(0, 512);
  for (const token of tokens) {
    const digest = crypto.createHash('sha256').update(token).digest();
    for (let i = 0; i < 4; i++) {
      const index = digest[i] % dim;
      vector[index] += ((digest[4 + i] || 1) / 255);
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + (n * n), 0));
  return norm ? vector.map(n => n / norm) : vector;
}
