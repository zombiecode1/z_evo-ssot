import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import routes from './routes/index';
import { authenticate } from './middleware/authMiddleware';
import { loggingMiddleware } from './middleware/loggingMiddleware';
import { initializeService, getService } from './controllers/openaiController';
import { cleanupOldLogs } from './services/fileLogger';
import identityMiddleware from './middleware/identityMiddleware';
import { loadIdentity } from './services/identityService';
import { initializeAgentSystem, getAgentService, getRagService } from './controllers/agentController';
import { savePersonaToDb } from './services/identityService';
import { DiskRAGService } from './services/ragService';
import { startWorkspaceWatcher } from './services/workspaceWatcher';
import { bootstrapProviders } from './services/providerBootstrap';
import { connectMcpServer, disconnectMcpServer } from './mcp/client';
import { startClientTracker, stopClientTracker } from './services/clientTracker';

dotenv.config();

// Track the MCP config directory found during startup
let MCP_CONFIG_DIR: string | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// Directory Index Database — tracks which directories have been scanned/indexed
// ═══════════════════════════════════════════════════════════════════════════════
interface DirectoryIndex {
  directory: string;
  flag: number;        // 0 = not scanned, 1 = scanned, 2 = indexed, 3 = error
  fileCount: number;
  ssotGenerated: boolean;
  lastScan: number;    // timestamp
  lastAccess: number;  // timestamp
  editorType: string;  // jetbrains, vscode, cursor, mcp-client, etc.
}

const directoryIndexDb = new Map<string, DirectoryIndex>();

function loadDirectoryIndex(): void {
  try {
    const indexPath = path.join(process.cwd(), '.zombiecoder', 'directory-index.json');
    if (fs.existsSync(indexPath)) {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      for (const [key, value] of Object.entries(raw)) {
        directoryIndexDb.set(key, value as DirectoryIndex);
      }
      console.log(`📂 Loaded ${directoryIndexDb.size} directory entries from index`);
    }
  } catch (err: any) {
    console.warn('Failed to load directory index:', err?.message);
  }
}

function saveDirectoryIndex(): void {
  try {
    const dir = path.join(process.cwd(), '.zombiecoder');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(dir, 'directory-index.json');
    const obj: Record<string, DirectoryIndex> = {};
    for (const [key, value] of directoryIndexDb) {
      obj[key] = value;
    }
    fs.writeFileSync(indexPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (err: any) {
    console.warn('Failed to save directory index:', err?.message);
  }
}

function updateDirectoryFlag(dirPath: string, flag: number, extra?: Partial<DirectoryIndex>): void {
  const existing = directoryIndexDb.get(dirPath);
  const entry: DirectoryIndex = {
    directory: dirPath,
    flag,
    fileCount: existing?.fileCount || 0,
    ssotGenerated: existing?.ssotGenerated || false,
    lastScan: existing?.lastScan || 0,
    lastAccess: Date.now(),
    editorType: existing?.editorType || 'unknown',
    ...extra,
  };
  directoryIndexDb.set(dirPath, entry);
  saveDirectoryIndex();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Auto-index: scan directory, count files, generate/update SSOT
// ═══════════════════════════════════════════════════════════════════════════════
async function autoIndexDirectory(dirPath: string, editorType: string = 'server'): Promise<void> {
  const entry = directoryIndexDb.get(dirPath);
  
  // Skip if already indexed within last 5 minutes
  if (entry && entry.flag === 2 && (Date.now() - entry.lastScan < 300000)) {
    console.log(`⏭️  Skipping ${dirPath} — already indexed ${Math.round((Date.now() - entry.lastScan) / 60000)}m ago`);
    return;
  }

  console.log(`🔍 Auto-indexing: ${dirPath} (editor: ${editorType})`);
  updateDirectoryFlag(dirPath, 1, { editorType });

  try {
    // Count files (skip node_modules, .git, dist)
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.zombiecoder', '__pycache__']);
    let fileCount = 0;
    
    function countFiles(dir: string, depth: number = 0): void {
      if (depth > 8) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!skipDirs.has(entry.name)) {
              countFiles(path.join(dir, entry.name), depth + 1);
            }
          } else {
            fileCount++;
          }
        }
      } catch { /* skip inaccessible dirs */ }
    }
    
    countFiles(dirPath);
    console.log(`  📁 Found ${fileCount} files in ${dirPath}`);

    // Generate SSOT via RAG service
    try {
      const rag = new DiskRAGService();
      await rag.setWorkingDirectory(dirPath, { autoInit: true });
      updateDirectoryFlag(dirPath, 2, { fileCount, ssotGenerated: true, lastScan: Date.now() });
      console.log(`  ✅ SSOT generated for ${dirPath}`);
    } catch (ragErr: any) {
      console.warn(`  ⚠️ SSOT generation failed: ${ragErr?.message}`);
      updateDirectoryFlag(dirPath, 3, { fileCount, lastScan: Date.now() });
    }
  } catch (err: any) {
    console.warn(`  ❌ Index failed for ${dirPath}: ${err?.message}`);
    updateDirectoryFlag(dirPath, 3, { lastScan: Date.now() });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Startup: scan all known directories and re-index stale ones
// ═══════════════════════════════════════════════════════════════════════════════
async function startupDirectoryScan(): Promise<void> {
  console.log('\n📋 Startup directory scan...');
  
  // Re-index all previously known directories
  const entries = Array.from(directoryIndexDb.entries());
  for (const [dirPath, entry] of entries) {
    if (entry.flag >= 1 && entry.lastScan > 0) {
      // Re-scan if older than 1 hour
      if (Date.now() - entry.lastScan > 3600000) {
        console.log(`  🔄 Re-indexing stale: ${dirPath} (last: ${new Date(entry.lastScan).toLocaleString()})`);
        await autoIndexDirectory(dirPath, entry.editorType);
      } else {
        console.log(`  ✅ ${dirPath} — flag=${entry.flag}, files=${entry.fileCount}, age=${Math.round((Date.now() - entry.lastScan) / 60000)}m`);
      }
    }
  }
  
  // Also scan common project directories
  const scanDirs = [
    process.cwd(),
    path.join(process.cwd(), 'src'),
    path.join(process.cwd(), 'src', 'LangChainAgent'),
  ];
  
  for (const dir of scanDirs) {
    if (fs.existsSync(dir) && !directoryIndexDb.has(dir)) {
      await autoIndexDirectory(dir, 'server-startup');
    }
  }
  
  console.log(`📊 Directory index: ${directoryIndexDb.size} entries\n`);
}

function buildRuntimeManifest(workspaceDir: string, serverPort: string | number) {
  return {
    workspaceRoot: workspaceDir,
    server: {
      port: Number(serverPort),
      mcpUrl: `http://localhost:${serverPort}/mcp`,
      sseUrl: `http://localhost:${serverPort}/sse`,
    },
    editorConfigs: {
      vscode: 'mcp/editor-configs/vscode-mcp.json',
      zed: 'mcp/editor-configs/zed-settings.json',
      windsurf: 'mcp/editor-configs/windsurf-mcp_config.json',
      jetbrains: 'mcp/editor-configs/jetbrains-mcp.json',
    },
    updatedAt: new Date().toISOString(),
  };
}

function writeRuntimeManifest(workspaceDir: string, serverPort: string | number) {
  const manifest = buildRuntimeManifest(workspaceDir, serverPort);
  const locations: string[] = [];

  // 1. Workspace root: /home/sahon/mcp/.zombiecoder/runtime.json
  locations.push(path.join(workspaceDir, '.zombiecoder'));

  // 2. MCP config dir (where mcp.json was found): /home/sahon/mcp/proxi_new/mcp/.zombiecoder/runtime.json
  if (MCP_CONFIG_DIR) {
    locations.push(MCP_CONFIG_DIR);
  }

  // 3. Current working dir as fallback: process.cwd()/mcp/.zombiecoder/runtime.json
  const cwdMcpDir = path.join(process.cwd(), 'mcp', '.zombiecoder');
  if (!locations.includes(cwdMcpDir)) {
    locations.push(cwdMcpDir);
  }

  for (const dir of locations) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const runtimePath = path.join(dir, 'runtime.json');
      fs.writeFileSync(runtimePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    } catch (err: any) {
      console.warn(`Failed to write runtime manifest to ${dir}:`, err?.message || err);
    }
  }
}

const app = express();
const PORT = process.env.PORT || 9999;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());

if (!GROQ_API_KEY) {
  console.warn('WARNING: GROQ_API_KEY not set — server will run in degraded mode');
}

// CORS: reflect origin for credentials mode (wildcard + credentials = broken)
const ALLOWED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0',
  'g.zombiecoder.my.id', 'g.zombiecoder.my.id',
  'g.zombiecoder.my.id', 'g.zombiecoder.my.id',
]);
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server)
    if (!origin) return callback(null, true);
    try {
      const url = new URL(origin);
      const hostname = url.hostname;
      // Always allow localhost ports
      if (hostname === 'localhost' || hostname === '127.0.0.1') return callback(null, true);
      // Check allowed hosts
      if (ALLOWED_HOSTS.has(hostname)) return callback(null, true);
      // Check env CORS_ORIGINS
      if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) return callback(null, true);
      callback(null, false);
    } catch {
      callback(null, true);
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(loggingMiddleware);
// Load identity manifest early and attach identity headers to responses
loadIdentity();
app.use(identityMiddleware);

// /health is implemented in routes/index.ts (includes model/service stats)

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(['/v1', '/api', '/dashboard', '/db'], authenticate);

app.use(routes);

async function start() {
  const service = initializeService(GROQ_API_KEY || '');
  // Initialize Agent & RAG system
  // Preference order for workspace dir: editor mcp config -> env WORKSPACE_DIR -> process.cwd()
  function findMcpConfig(): string | null {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'mcp', 'mcp.json');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  function resolveWorkspaceFromConfig(configPath: string): string | null {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const workspaceRoot = path.resolve(path.dirname(configPath), '..');
      let candidate = parsed.workspaceDir || parsed.workspace || '';
      if (!candidate) return null;
      if (typeof candidate !== 'string') return null;
      candidate = candidate.replace('${workspaceFolder}', workspaceRoot).trim();
      return path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
    } catch (e) {
      return null;
    }
  }

  const mcpConfigPath = findMcpConfig();
  let DEFAULT_WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();
  if (mcpConfigPath) {
    // Store the MCP config directory for runtime manifest writing
    MCP_CONFIG_DIR = path.join(path.dirname(mcpConfigPath), '.zombiecoder');
    console.log(`📁 MCP config found: ${mcpConfigPath} → runtime will write to ${MCP_CONFIG_DIR}`);
    const resolved = resolveWorkspaceFromConfig(mcpConfigPath);
    if (resolved) {
      DEFAULT_WORKSPACE = resolved;
    }
    // Watch the mcp config for runtime changes and apply updates
    try {
      fs.watch(mcpConfigPath, { persistent: false }, async (ev) => {
        if (ev === 'change' || ev === 'rename') {
          const newResolved = resolveWorkspaceFromConfig(mcpConfigPath);
          if (newResolved && newResolved !== DEFAULT_WORKSPACE) {
            console.log('Detected update to mcp/mcp.json workspaceDir ->', newResolved);
            DEFAULT_WORKSPACE = newResolved;
            try {
              const rag = getRagService();
              if (rag) {
                await rag.setWorkingDirectory(DEFAULT_WORKSPACE, { autoInit: true });
                // start a watcher for this directory to keep SSOT up-to-date
                try {
                  const localRag = new DiskRAGService();
                  await localRag.setWorkingDirectory(DEFAULT_WORKSPACE, { autoInit: true });
                  startWorkspaceWatcher({ directory: DEFAULT_WORKSPACE, rag: localRag, index: undefined, workspaceId: 'auto' });
                } catch (e: any) {
                  console.warn('Failed to start watcher for updated workspace:', e?.message || e);
                }
              }
            } catch (e: any) {
              console.warn('Applying updated workspace failed:', e?.message || e);
            }
          }
        }
      });
    } catch (e) {
      /* ignore watch errors */
    }
  }

  await initializeAgentSystem(DEFAULT_WORKSPACE);
  savePersonaToDb(); // Save persona config to DB (survives restart)

  // Initialize Unified Pipeline (architecture: Vercel AI SDK + LangChain + MCP)
  try {
    const { initializeUnifiedPipeline } = require('./controllers/agentController');
    await initializeUnifiedPipeline();
  } catch (e: any) {
    console.warn('⚠️ Unified Pipeline init skipped:', e?.message || e);
  }

  // Load directory index and run startup scan
  loadDirectoryIndex();
  await startupDirectoryScan();

  // Start client tracker
  startClientTracker();

  // Start MCP Server and connect client
  try {
    await connectMcpServer();
  } catch (err: any) {
    console.warn('⚠️ MCP server connection failed:', err?.message || err);
  }

  await service.initialize();

  // Bootstrap providers from environment variables
  try {
    const bootstrap = await bootstrapProviders();
    console.log(`✅ Provider bootstrap: ${bootstrap.discovered} providers, ${bootstrap.synced} models, ${bootstrap.toolsRegistered} tools`);
  } catch (err: any) {
    console.warn('⚠️ Provider bootstrap failed:', err?.message || err);
  }

  writeRuntimeManifest(DEFAULT_WORKSPACE, PORT);
  cleanupOldLogs();
  setInterval(cleanupOldLogs, 3600000);
  // Update runtime.json every 5 minutes with current timestamp
  setInterval(() => writeRuntimeManifest(DEFAULT_WORKSPACE, PORT), 5 * 60 * 1000);
  const agentSvc = getAgentService();
  const persona = agentSvc?.getPersonaName() || 'ZombieCoder';

  app.listen(PORT, () => {
    const models = service.getModels();
    const tunnelEnabled = process.env.TUNNEL_ENABLED === 'true';
    const lines = [
      '='.repeat(58),
      '  ZombieCoder Proxi Bridge',
      '='.repeat(58),
      `  Server:      http://localhost:${PORT}`,
      `  Models:      ${models.length} available`,
      `  Auth:        Optional (auto-uses env GROQ_API_KEY)`,
      `  CORS:        ${CORS_ORIGINS.slice(0, 3).join(', ')}...`,
      '',
    ];
    
    if (tunnelEnabled) {
      lines.push(
        '  🌐 Cloudflare Tunnel Routes:',
        `  📡 ${process.env.TUNNEL_OCODE_URL || 'https://o.smartearningplatformbd.net'} → localhost:${PORT} (Bridge)`,
        `  📡 ${process.env.TUNNEL_API_URL || 'https://g.zombiecoder.my.id'} → localhost:5001 (API)`,
        `  📡 ${process.env.TUNNEL_VSCODE_URL || 'https://vs.smartearningplatformbd.net'} → localhost:5050 (VS Code)`,
        '',
      );
    } else {
      lines.push(
        '  🏠 Local-only mode (tunnel disabled)',
        '',
      );
    }
    
    lines.push(
      '  Endpoints:',
      `  POST /v1/chat/completions    - Chat (tools, vision, JSON mode, streaming)`,
      `  POST /v1/completions         - Text completions (legacy)`,
      `  POST /v1/audio/transcriptions  - Speech-to-text`,
      `  POST /v1/audio/translations    - Audio translation`,
      `  POST /v1/embeddings          - Text embeddings`,
      `  GET  /v1/models              - List models`,
      `  GET  /v1/models/:id          - Get model`,
      '',
      `  ${'='.repeat(52)}`,
      `  🌟 ZombieCoder Agent System (${persona})`,
      `  ${'='.repeat(52)}`,
      `  POST /v1/agent/chat          - Agent chat (RAG + Persona + Tool calling)`,
      `  POST /v1/agent/directory     - Set working directory (auto-index)`,
      `  POST /v1/agent/permission    - Grant/deny permission`,
      `  GET  /v1/agent/status        - Agent system status`,
      `  POST /v1/agent/rescan        - Rescan project`,
      `  GET  /v1/agent/ssot          - Read SSOT.md`,
      `  GET  /v1/agent/routes        - Available agent routes`,
      `  GET  /v1/agent/index         - Directory index status`,
      `  POST /v1/agent/register      - Register editor directory`,
      `  GET  /v1/agent/clients       - Connected clients status`,
      '',
      '  Features:',
      '  - Full OpenAI format pass-through (tools, streaming, images)',
      '  - Smart auto model routing based on input',
      '  - Per-model rate limit management',
      '  - Real-time dashboard & logging',
      '  - Disk-based RAG (SSOT.md) - single source of truth',
      '  - ZombieCoder agent persona with identity anchoring',
      '  - Auto directory indexing on editor connect',
      '  - Database flag tracking for scanned/indexed dirs',
      '  - Cloudflare tunnel remote access enabled',
      '  - No vendor lock-in - use any OpenAI-compatible client',
      '='.repeat(58),
    );
    console.log(lines.join('\n'));
  });
}

// Cleanup on shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  stopClientTracker();
  try { const { shutdownAgent } = require('./services/langchainAgent'); await shutdownAgent(); } catch {}
  await disconnectMcpServer();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopClientTracker();
  try { const { shutdownAgent } = require('./services/langchainAgent'); await shutdownAgent(); } catch {}
  await disconnectMcpServer();
  process.exit(0);
});

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
