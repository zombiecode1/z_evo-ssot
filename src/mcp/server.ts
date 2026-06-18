/**
 * MCP Server — ZombieCoder Agent Tools
 * 
 * This is a proper MCP server that exposes tools via stdio transport.
 * The agent chat connects to this server as an MCP client.
 * 
 * Reference: https://modelcontextprotocol.io/docs/concepts/architecture
 * Reference: https://modelcontextprotocol.io/docs/sdk
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import BetterSqlite3 from 'better-sqlite3';

function resolveDbPath(): string {
  const explicit = String(process.env.ZOMBIECODER_DB || '').trim();
  if (explicit && explicit !== 'auto') {
    return path.resolve(explicit);
  }

  const argvEntry = String(process.argv[1] || '').trim();
  const argvWorkspace = argvEntry
    ? path.resolve(path.dirname(argvEntry), '..', '..')
    : '';

  const workspaceDir = String(process.env.WORKSPACE_DIR || '').trim();
  const candidates = [
    workspaceDir ? path.join(workspaceDir, '.zombiecoder', 'state.db') : '',
    argvWorkspace ? path.join(argvWorkspace, '.zombiecoder', 'state.db') : '',
    path.join(process.cwd(), '.zombiecoder', 'state.db'),
    path.join(process.cwd(), 'mcp', '.zombiecoder', 'state.db'),
    path.join(path.dirname(process.cwd()), '.zombiecoder', 'state.db'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'mcp', '.zombiecoder', 'state.db'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || path.join(process.cwd(), '.zombiecoder', 'state.db');
}

// MCP server runs as a separate process, so it needs its own DB connection
const DB_PATH = resolveDbPath();

let mcpDb: any = null;
function getMcpDb(): any {
  if (mcpDb) return mcpDb;
  try {
    if (!fs.existsSync(DB_PATH)) {
      console.error('❌ MCP DB not found:', DB_PATH);
      return null;
    }
    mcpDb = new (BetterSqlite3 as any)(DB_PATH, { readonly: true });
    console.log('✅ MCP DB connected (read-only)');
    return mcpDb;
  } catch (err: any) {
    console.error('❌ MCP DB connection failed:', err.message);
    return null;
  }
}

// Create MCP Server
const mcpServer = new McpServer({
  name: 'zombiedev-tools',
  version: '1.0.0',
});

// ── Tool: Read File ──────────────────────────────────────────
mcpServer.tool(
  'read_file',
  'Read the contents of any file. Use when user asks about code, config, or file content.',
  { file_path: z.string().describe('Absolute path to file'), max_lines: z.number().optional().default(100) },
  {},
  async ({ file_path, max_lines }) => {
    try {
      const content = fs.readFileSync(file_path, 'utf-8');
      const lines = content.split('\n');
      const truncated = lines.slice(0, max_lines || 100).join('\n');
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true, file: file_path, total_lines: lines.length,
          content: truncated, truncated: lines.length > (max_lines || 100),
        }, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── Tool: List Files ──────────────────────────────────────────
mcpServer.tool(
  'list_files',
  'List files and directories in a given path. Use to understand project structure.',
  { directory: z.string().describe('Directory path to list'), pattern: z.string().optional().describe('Glob pattern to filter') },
  {},
  async ({ directory, pattern }) => {
    try {
      if (!fs.existsSync(directory)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Directory not found: ${directory}` }) }] };
      }
      const items = fs.readdirSync(directory, { withFileTypes: true });
      let files = items.map(i => ({ name: i.name, type: i.isDirectory() ? 'dir' : 'file' }));
      if (pattern) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        files = files.filter(f => regex.test(f.name));
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, directory, count: files.length, items: files.slice(0, 50) }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── Tool: Search Code (grep) ──────────────────────────────────
mcpServer.tool(
  'search_code',
  'Search for a pattern in file contents (grep). Find specific code, functions, or variables.',
  { pattern: z.string().describe('Regex pattern to search'), directory: z.string().optional().describe('Directory to search in'), file_pattern: z.string().optional().describe('File pattern filter') },
  {},
  async ({ pattern, directory, file_pattern }) => {
    try {
      const dir = directory || process.cwd();
      const fileArg = file_pattern ? `--include="${file_pattern}"` : '';
      const cmd = `grep -rn ${fileArg} "${pattern}" "${dir}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null | head -30`;
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
      const lines = result.trim().split('\n').filter(Boolean);
      const results = lines.map(line => {
        const [file, lineNum, ...rest] = line.split(':');
        return { file, line: lineNum, content: rest.join(':').trim() };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, pattern, matches: lines.length, results }, null, 2) }] };
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, pattern, matches: 0, results: [] }) }] };
    }
  }
);

// ── Tool: Count Models ──────────────────────────────────────
mcpServer.tool(
  'count_models',
  'Count AI models in the system database. Use when user asks about models.',
  {},
  {},
  async () => {
    try {
      const db = getMcpDb();
      if (!db) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Database not available' }) }] };
      const total = (db.prepare('SELECT COUNT(*) as cnt FROM models').get() as any)?.cnt || 0;
      const byProvider = db.prepare('SELECT provider, COUNT(*) as cnt FROM models GROUP BY provider ORDER BY cnt DESC').all() as any[];
      const free = (db.prepare("SELECT COUNT(*) as cnt FROM models WHERE provider = 'OpenCode'").get() as any)?.cnt || 0;
      return { content: [{ type: 'text', text: JSON.stringify({
        success: true, total_models: total, free_models: free, paid_models: total - free,
        by_provider: byProvider.map(r => ({ provider: r.provider, count: r.cnt })),
      }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── Tool: Count Providers ──────────────────────────────────────
mcpServer.tool(
  'count_providers',
  'Count LLM providers configured in the system.',
  {},
  {},
  async () => {
    try {
      const db = getMcpDb();
      if (!db) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Database not available' }) }] };
      const providers = db.prepare('SELECT id, name, type, is_active FROM providers').all() as any[];
      return { content: [{ type: 'text', text: JSON.stringify({
        success: true, total: providers.length, active: providers.filter(p => p.is_active).length,
        providers: providers.map(p => ({ id: p.id, name: p.name, type: p.type, active: !!p.is_active })),
      }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── Tool: Run Command ──────────────────────────────────────
mcpServer.tool(
  'run_command',
  'Execute a shell command and return output.',
  { command: z.string().describe('Shell command to execute'), timeout: z.number().optional().default(15000) },
  {},
  async ({ command, timeout }) => {
    try {
      const result = execSync(command, { encoding: 'utf-8', timeout: timeout || 15000, cwd: process.cwd() });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, command, output: result.trim().substring(0, 2000) }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, command, error: err.message?.substring(0, 500) }) }] };
    }
  }
);

// ── Tool: Get Project Info ──────────────────────────────────
mcpServer.tool(
  'get_project_info',
  'Get basic info about the project (name, version, dependencies).',
  { directory: z.string().optional().describe('Project directory') },
  {},
  async ({ directory }) => {
    try {
      const dir = directory || process.cwd();
      const pkgPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No package.json found' }) }] };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return { content: [{ type: 'text', text: JSON.stringify({
        success: true, name: pkg.name, version: pkg.version, description: pkg.description || '',
        dependencies: Object.keys(pkg.dependencies || {}).length,
        devDependencies: Object.keys(pkg.devDependencies || {}).length,
        scripts: Object.keys(pkg.scripts || {}),
      }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── Tool: DB Query ──────────────────────────────────────────
mcpServer.tool(
  'db_query',
  'Query the state database (SELECT only). Use for conversations, usage, system state.',
  { query: z.string().describe('SQL SELECT query') },
  {},
  async ({ query }) => {
    try {
      const db = getMcpDb();
      if (!db) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Database not available' }) }] };
      if (!query.trim().toUpperCase().startsWith('SELECT')) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Only SELECT queries allowed' }) }] };
      }
      const results = db.prepare(query).all();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, rows: results.length, data: results.slice(0, 20) }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── Cleanup ──────────────────────────────────────────
process.on('exit', () => {
  if (mcpDb) {
    mcpDb.close();
    console.log('🔌 MCP DB closed');
  }
});

// ── Start Server ──────────────────────────────────────────
export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.log('🔧 MCP Server started (stdio transport)');
  return mcpServer;
}

// Export for programmatic use
export { mcpServer };
