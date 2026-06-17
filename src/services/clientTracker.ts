import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════════════════════════════════════════════
// Client Tracker — tracks connected editors and their working directories
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConnectedClient {
  clientId: string;           // unique id (sessionId or generated)
  editorType: string;         // jetbrains, vscode, cursor, opencode, mcp-client, unknown
  rootDirectory: string;      // the project root this editor is working in
  connectedAt: number;        // timestamp
  lastActiveAt: number;       // last activity timestamp
  status: 'active' | 'idle' | 'disconnected';
  capabilities?: string[];    // what the editor supports
  ssotGenerated: boolean;     // has SSOT been generated for this directory
  flag: number;               // 0=not scanned, 1=scanning, 2=indexed, 3=error
}

interface ClientTrackerDb {
  clients: Record<string, ConnectedClient>;
  lastUpdated: string;
}

const clients = new Map<string, ConnectedClient>();
const DB_PATH = path.join(process.cwd(), '.zombiecoder', 'connected-clients.json');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DISCONNECT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — remove disconnected clients older than this
const MAX_CLIENTS_PER_DIR = 5; // Max clients per directory (prevent accumulation)

// ═══════════════════════════════════════════════════════════════════════════════
// Persistence — save/load connected clients to disk
// ═══════════════════════════════════════════════════════════════════════════════

function saveClients(): void {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj: ClientTrackerDb = {
      clients: {} as Record<string, ConnectedClient>,
      lastUpdated: new Date().toISOString(),
    };
    for (const [key, value] of clients) {
      obj.clients[key] = value;
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (err: any) {
    console.warn('⚠️ Failed to save client tracker:', err?.message);
  }
}

function loadClients(): void {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')) as ClientTrackerDb;
      const now = Date.now();
      let loaded = 0;
      let pruned = 0;
      for (const [key, value] of Object.entries(raw.clients || {})) {
        // On restart, mark all as disconnected
        value.status = 'disconnected';
        // Remove clients older than CLEANUP_AGE_MS
        const age = now - (value.lastActiveAt || 0);
        if (age > CLEANUP_AGE_MS) {
          pruned++;
          continue; // skip old clients
        }
        clients.set(key, value);
        loaded++;
      }
      console.log(`👥 Loaded ${loaded} known clients from tracker (pruned ${pruned} old)`);
    }
  } catch (err: any) {
    console.warn('⚠️ Failed to load client tracker:', err?.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Detect editor type from various hints
// ═══════════════════════════════════════════════════════════════════════════════

function detectEditorType(hints: {
  clientName?: string;
  userAgent?: string;
  source?: string;
}): string {
  const name = (hints.clientName || '').toLowerCase();
  const ua = (hints.userAgent || '').toLowerCase();
  const source = (hints.source || '').toLowerCase();

  // MCP clientInfo.name
  if (name.includes('jetbrains') || name.includes('intellij') || name.includes('webstorm') || name.includes('phpstorm')) return 'jetbrains';
  if (name.includes('vscode') || name.includes('visual studio code')) return 'vscode';
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('opencode')) return 'opencode';
  if (name.includes('windsurf')) return 'windsurf';
  if (name.includes('zed')) return 'zed';

  // User-Agent
  if (ua.includes('jetbrains') || ua.includes('intellij')) return 'jetbrains';
  if (ua.includes('vscode')) return 'vscode';
  if (ua.includes('cursor')) return 'cursor';

  // Source hint (from request headers or body)
  if (source.includes('jetbrains') || source.includes('intellij')) return 'jetbrains';
  if (source.includes('vscode')) return 'vscode';
  if (source.includes('cursor')) return 'cursor';
  if (source.includes('opencode')) return 'opencode';

  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Register / update a connected client
// ═══════════════════════════════════════════════════════════════════════════════

export function registerClient(opts: {
  clientId: string;
  rootDirectory: string;
  clientName?: string;
  userAgent?: string;
  source?: string;
  capabilities?: string[];
}): ConnectedClient {
  const editorType = detectEditorType({
    clientName: opts.clientName,
    userAgent: opts.userAgent,
    source: opts.source,
  });

  const existing = clients.get(opts.clientId);
  const now = Date.now();

  // Limit clients per directory — remove oldest disconnected ones first
  const resolvedDir = path.resolve(opts.rootDirectory);
  const dirClients = Array.from(clients.values())
    .filter(c => c.rootDirectory === resolvedDir && c.clientId !== opts.clientId)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

  if (dirClients.length >= MAX_CLIENTS_PER_DIR) {
    // Remove oldest disconnected clients first
    const disconnected = dirClients.filter(c => c.status === 'disconnected');
    for (let i = 0; i < disconnected.length && dirClients.length >= MAX_CLIENTS_PER_DIR; i++) {
      clients.delete(disconnected[i].clientId);
      dirClients.shift();
    }
    // If still over limit, remove oldest idle
    const idle = dirClients.filter(c => c.status === 'idle');
    for (let i = 0; i < idle.length && dirClients.length >= MAX_CLIENTS_PER_DIR; i++) {
      clients.delete(idle[i].clientId);
      dirClients.shift();
    }
  }

  const client: ConnectedClient = {
    clientId: opts.clientId,
    editorType,
    rootDirectory: resolvedDir,
    connectedAt: existing?.connectedAt || now,
    lastActiveAt: now,
    status: 'active',
    capabilities: opts.capabilities || existing?.capabilities,
    ssotGenerated: existing?.ssotGenerated || false,
    flag: existing?.flag || 0,
  };

  clients.set(opts.clientId, client);
  saveClients();

  console.log(`👤 Client registered: ${editorType} @ ${client.rootDirectory} (id: ${opts.clientId.slice(0, 8)}...)`);
  return client;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Touch — update last active time
// ═══════════════════════════════════════════════════════════════════════════════

export function touchClient(clientId: string): void {
  const client = clients.get(clientId);
  if (client) {
    client.lastActiveAt = Date.now();
    client.status = 'active';
    clients.set(clientId, client);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Disconnect a client
// ═══════════════════════════════════════════════════════════════════════════════

export function disconnectClient(clientId: string): void {
  const client = clients.get(clientId);
  if (client) {
    client.status = 'disconnected';
    clients.set(clientId, client);
    saveClients();
    console.log(`👋 Client disconnected: ${client.editorType} @ ${client.rootDirectory}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Update client's directory index flag
// ═══════════════════════════════════════════════════════════════════════════════

export function updateClientIndex(clientId: string, flag: number, ssotGenerated: boolean): void {
  const client = clients.get(clientId);
  if (client) {
    client.flag = flag;
    client.ssotGenerated = ssotGenerated;
    clients.set(clientId, client);
    saveClients();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Get all clients / active clients / clients by directory
// ═══════════════════════════════════════════════════════════════════════════════

export function getAllClients(): ConnectedClient[] {
  return Array.from(clients.values());
}

export function getActiveClients(): ConnectedClient[] {
  return Array.from(clients.values()).filter(c => c.status === 'active');
}

export function getClientsByDirectory(directory: string): ConnectedClient[] {
  const resolved = path.resolve(directory);
  return Array.from(clients.values()).filter(c => c.rootDirectory === resolved);
}

export function getClient(clientId: string): ConnectedClient | undefined {
  return clients.get(clientId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Find the root directory from any connected client (for agent use)
// ═══════════════════════════════════════════════════════════════════════════════

export function findRootDirectory(): string | null {
  // Priority: active clients first, then most recently active
  const active = getActiveClients()
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  if (active.length > 0) {
    return active[0].rootDirectory;
  }

  // Fallback: any client (including disconnected)
  const all = getAllClients()
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  return all.length > 0 ? all[0].rootDirectory : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stats — summary of connected clients
// ═══════════════════════════════════════════════════════════════════════════════

export function getClientStats(): {
  total: number;
  active: number;
  idle: number;
  disconnected: number;
  directories: string[];
  editors: Record<string, number>;
} {
  const all = getAllClients();
  const editors: Record<string, number> = {};
  const dirSet = new Set<string>();

  for (const c of all) {
    editors[c.editorType] = (editors[c.editorType] || 0) + 1;
    dirSet.add(c.rootDirectory);
  }

  return {
    total: all.length,
    active: all.filter(c => c.status === 'active').length,
    idle: all.filter(c => c.status === 'idle').length,
    disconnected: all.filter(c => c.status === 'disconnected').length,
    directories: Array.from(dirSet),
    editors,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Periodic cleanup — mark idle/disconnected clients
// ═══════════════════════════════════════════════════════════════════════════════

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startClientTracker(): void {
  loadClients();

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let changed = false;

    for (const [id, client] of clients) {
      const idleTime = now - client.lastActiveAt;

      if (client.status === 'active' && idleTime > IDLE_TIMEOUT_MS) {
        client.status = 'idle';
        clients.set(id, client);
        changed = true;
      } else if (client.status === 'idle' && idleTime > DISCONNECT_TIMEOUT_MS) {
        client.status = 'disconnected';
        clients.set(id, client);
        changed = true;
      }

      // Remove disconnected clients older than 24 hours
      if (client.status === 'disconnected' && idleTime > CLEANUP_AGE_MS) {
        clients.delete(id);
        changed = true;
      }
    }

    if (changed) saveClients();
  }, 60_000); // check every minute

  console.log('👥 Client tracker started');
}

export function stopClientTracker(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  saveClients();
  console.log('👥 Client tracker stopped');
}
