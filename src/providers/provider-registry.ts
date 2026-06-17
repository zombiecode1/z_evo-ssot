// ─── Provider Registry ───────────────────────────────────
// Singleton factory + cache for provider instances.
// Avoids recreating providers; uses TTL-based cache.
// Batch health checks via Promise.allSettled.

import { ILLMProvider, ProviderConfig, ProviderFactoryFn, ProviderHealth, ProviderRegistryEntry } from './types';
import { getStateDb } from '../services/stateDb';

// ─── Registry Singleton ──────────────────────────────────

let _instance: ProviderRegistry | null = null;

export class ProviderRegistry {
  private cache: Map<string, ProviderRegistryEntry> = new Map();
  private factories: Map<string, ProviderFactoryFn> = new Map();
  private ttlMs: number;
  private defaultFactory?: ProviderFactoryFn;

  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** Get or create the singleton instance */
  static getInstance(ttlMs?: number): ProviderRegistry {
    if (!_instance) {
      _instance = new ProviderRegistry(ttlMs);
    }
    return _instance;
  }

  /** Reset singleton (for testing) */
  static reset(): void {
    if (_instance) {
      _instance.dispose();
      _instance = null;
    }
  }

  // ─── Factory Registration ─────────────────────────────

  /** Register a factory function for a provider type */
  registerFactory(providerType: string, factory: ProviderFactoryFn): void {
    this.factories.set(providerType, factory);
  }

  /** Set the default factory (used when no specific factory is registered) */
  setDefaultFactory(factory: ProviderFactoryFn): void {
    this.defaultFactory = factory;
  }

  // ─── Provider Creation ────────────────────────────────

  /** Create a new provider instance (internal, not cached) */
  private createProvider(config: ProviderConfig): ILLMProvider {
    const factory = this.factories.get(config.type) || this.defaultFactory;
    if (!factory) {
      throw new Error(`No factory registered for provider type: ${config.type}`);
    }
    return factory(config);
  }

  /** Get a provider by config (creates if not cached, validates TTL) */
  get(config: ProviderConfig): ILLMProvider {
    const cached = this.cache.get(config.id);

    if (cached) {
      // Check if TTL expired
      if (cached.lastUsed && Date.now() - cached.lastUsed.getTime() > this.ttlMs) {
        // TTL expired — recreate
        cached.provider.dispose();
        this.cache.delete(config.id);
      } else {
        // Still valid — update stats and return
        cached.lastUsed = new Date();
        cached.useCount++;
        return cached.provider;
      }
    }

    // Create new instance
    const provider = this.createProvider(config);
    this.cache.set(config.id, {
      provider,
      config,
      lastUsed: new Date(),
      useCount: 1,
    });

    return provider;
  }

  /** Get a provider by ID (loads config from DB if available) */
  getById(providerId: string): ILLMProvider | null {
    const config = this.loadConfigFromDb(providerId);
    if (!config) return null;
    return this.get(config);
  }

  /** Remove a provider from cache */
  remove(providerId: string): boolean {
    const entry = this.cache.get(providerId);
    if (entry) {
      entry.provider.dispose();
      this.cache.delete(providerId);
      return true;
    }
    return false;
  }

  /** Check if a provider is cached */
  has(providerId: string): boolean {
    return this.cache.has(providerId);
  }

  /** Get all cached provider entries */
  entries(): ProviderRegistryEntry[] {
    return Array.from(this.cache.values());
  }

  /** Get all cached provider IDs */
  ids(): string[] {
    return Array.from(this.cache.keys());
  }

  // ─── Batch Operations ─────────────────────────────────

  /** Health check all cached providers (parallel, non-blocking) */
  async healthCheckAll(): Promise<Map<string, ProviderHealth>> {
    const results = new Map<string, ProviderHealth>();
    const entries = this.entries();

    const checks = entries.map(async (entry) => {
      try {
        const health = await entry.provider.testConnection();
        results.set(entry.config.id, health);
      } catch (err: any) {
        results.set(entry.config.id, {
          status: 'error',
          errorMessage: err?.message || String(err),
          lastChecked: new Date(),
        });
      }
    });

    await Promise.allSettled(checks);
    return results;
  }

  /** Dispose all cached providers */
  dispose(): void {
    for (const [id, entry] of this.cache) {
      entry.provider.dispose();
    }
    this.cache.clear();
  }

  /** Clean up expired entries */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of this.cache) {
      if (entry.lastUsed && now - entry.lastUsed.getTime() > this.ttlMs * 2) {
        entry.provider.dispose();
        this.cache.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  // ─── Database Integration ─────────────────────────────

  /** Load provider config from database */
  private loadConfigFromDb(providerId: string): ProviderConfig | null {
    const db = getStateDb();
    if (!db) return null;

    const row = db.prepare(`SELECT * FROM providers WHERE id = ? AND is_active = 1`).get(providerId) as any;
    if (!row) return null;

    return this.rowToConfig(row);
  }

  /** Load all active provider configs from database */
  loadAllConfigsFromDb(): ProviderConfig[] {
    const db = getStateDb();
    if (!db) return [];

    const rows = db.prepare(`SELECT * FROM providers WHERE is_active = 1 ORDER BY priority DESC`).all() as any[];
    return rows.map(row => this.rowToConfig(row));
  }

  /** Convert a database row to ProviderConfig */
  private rowToConfig(row: any): ProviderConfig {
    let capabilities;
    try {
      capabilities = typeof row.capabilities === 'string'
        ? JSON.parse(row.capabilities)
        : row.capabilities || this.defaultCapabilities();
    } catch {
      capabilities = this.defaultCapabilities();
    }

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      baseUrl: row.base_url,
      apiKeyEnv: row.api_key_env || undefined,
      apiKey: row.api_key || undefined,
      priority: row.priority || 0,
      isActive: row.is_active === 1,
      capabilities,
      rateLimitRpm: row.rate_limit_rpm || undefined,
      rateLimitTpm: row.rate_limit_tpm || undefined,
      healthStatus: row.health_status || undefined,
      lastHealthCheck: row.last_health_check ? new Date(row.last_health_check) : undefined,
      errorCount: row.error_count || 0,
    };
  }

  private defaultCapabilities(): any {
    return {
      streaming: true,
      toolCalling: true,
      vision: false,
      audio: false,
      embeddings: false,
      systemMessages: true,
      multiTurn: true,
      responseFormat: true,
      maxContextWindow: 131072,
      maxOutputTokens: 8192,
    };
  }
}

/** Convenience accessor for the singleton */
export function getProviderRegistry(ttlMs?: number): ProviderRegistry {
  return ProviderRegistry.getInstance(ttlMs);
}
