/**
 * Agent Tools — LangChain.js + Zod format
 * 
 * These tools allow the agent to ACTUALLY do things instead of lying.
 * When a user asks "how many models?", the agent calls count_models tool.
 * When a user asks "what's in package.json?", the agent calls read_file tool.
 * 
 * Reference: https://js.langchain.com/docs/concepts/tools/
 * Reference: https://zod.dev/
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getStateDb } from '../services/stateDb';

// ── Tool: Read File ──────────────────────────────────────────
export const readFileTool = {
  name: 'read_file',
  description: 'Read the contents of any file. Use this when the user asks about code, configuration, or any file content.',
  schema: z.object({
    file_path: z.string().describe('Absolute path to the file to read'),
    max_lines: z.number().optional().default(100).describe('Maximum lines to read'),
  }),
  execute: async (input: { file_path: string; max_lines?: number }) => {
    try {
      const content = fs.readFileSync(input.file_path, 'utf-8');
      const lines = content.split('\n');
      const truncated = lines.slice(0, input.max_lines || 100).join('\n');
      return {
        success: true,
        file: input.file_path,
        total_lines: lines.length,
        content: truncated,
        truncated: lines.length > (input.max_lines || 100),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ── Tool: List Files ──────────────────────────────────────────
export const listFilesTool = {
  name: 'list_files',
  description: 'List files and directories in a given path. Use this to understand project structure.',
  schema: z.object({
    directory: z.string().describe('Directory path to list'),
    pattern: z.string().optional().describe('Glob pattern to filter (e.g. "*.ts")'),
    recursive: z.boolean().optional().default(false).describe('List recursively'),
  }),
  execute: async (input: { directory: string; pattern?: string; recursive?: boolean }) => {
    try {
      const dir = input.directory;
      if (!fs.existsSync(dir)) {
        return { success: false, error: `Directory not found: ${dir}` };
      }
      const items = fs.readdirSync(dir, { withFileTypes: true });
      let files = items.map(i => ({
        name: i.name,
        type: i.isDirectory() ? 'directory' : 'file',
        path: path.join(dir, i.name),
      }));
      if (input.pattern) {
        const regex = new RegExp('^' + input.pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        files = files.filter(f => regex.test(f.name));
      }
      return {
        success: true,
        directory: dir,
        count: files.length,
        items: files.slice(0, 50),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ── Tool: Search Code ──────────────────────────────────────────
export const searchCodeTool = {
  name: 'search_code',
  description: 'Search for a pattern in file contents (grep). Use this to find specific code, functions, or variables.',
  schema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    directory: z.string().optional().describe('Directory to search in'),
    file_pattern: z.string().optional().describe('File pattern to filter (e.g. "*.ts")'),
  }),
  execute: async (input: { pattern: string; directory?: string; file_pattern?: string }) => {
    try {
      const dir = input.directory || process.cwd();
      const fileArg = input.file_pattern ? `--include="${input.file_pattern}"` : '';
      const cmd = `grep -rn ${fileArg} "${input.pattern}" "${dir}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null | head -30`;
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
      const lines = result.trim().split('\n').filter(Boolean);
      return {
        success: true,
        pattern: input.pattern,
        matches: lines.length,
        results: lines.map(line => {
          const [file, lineNum, ...rest] = line.split(':');
          return { file, line: lineNum, content: rest.join(':').trim() };
        }),
      };
    } catch (err: any) {
      return { success: true, pattern: input.pattern, matches: 0, results: [] };
    }
  },
};

// ── Tool: Count Models ──────────────────────────────────────────
export const countModelsTool = {
  name: 'count_models',
  description: 'Count how many AI models are registered in the system. Use when user asks about models.',
  schema: z.object({}),
  execute: async () => {
    try {
      const db = getStateDb();
      if (!db) return { success: false, error: 'Database not available' };
      
      const total = (db.prepare('SELECT COUNT(*) as cnt FROM models').get() as any)?.cnt || 0;
      const byProvider = db.prepare(`
        SELECT provider, COUNT(*) as cnt 
        FROM models 
        GROUP BY provider 
        ORDER BY cnt DESC
      `).all() as any[];
      
      const free = (db.prepare("SELECT COUNT(*) as cnt FROM models WHERE provider = 'OpenCode'").get() as any)?.cnt || 0;
      
      return {
        success: true,
        total_models: total,
        free_models: free,
        paid_models: total - free,
        by_provider: byProvider.map(r => ({ provider: r.provider, count: r.cnt })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ── Tool: Count Providers ──────────────────────────────────────
export const countProvidersTool = {
  name: 'count_providers',
  description: 'Count how many LLM providers are configured. Use when user asks about providers.',
  schema: z.object({}),
  execute: async () => {
    try {
      const db = getStateDb();
      if (!db) return { success: false, error: 'Database not available' };
      
      const providers = db.prepare('SELECT id, name, type, is_active FROM providers').all() as any[];
      return {
        success: true,
        total: providers.length,
        active: providers.filter(p => p.is_active).length,
        providers: providers.map(p => ({
          id: p.id,
          name: p.name,
          type: p.type,
          active: !!p.is_active,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ── Tool: Run Command ──────────────────────────────────────────
export const runCommandTool = {
  name: 'run_command',
  description: 'Execute a shell command and return output. Use for testing, building, or checking status.',
  schema: z.object({
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().optional().default(15000).describe('Timeout in ms'),
  }),
  execute: async (input: { command: string; timeout?: number }) => {
    try {
      const result = execSync(input.command, {
        encoding: 'utf-8',
        timeout: input.timeout || 15000,
        cwd: process.cwd(),
      });
      return {
        success: true,
        command: input.command,
        output: result.trim().substring(0, 2000),
      };
    } catch (err: any) {
      return {
        success: false,
        command: input.command,
        error: err.message?.substring(0, 500),
      };
    }
  },
};

// ── Tool: Web Search ──────────────────────────────────────────
export const webSearchTool = {
  name: 'web_search',
  description: 'Search the web for information. Use when user asks about documentation, tutorials, or current events.',
  schema: z.object({
    query: z.string().describe('Search query'),
  }),
  execute: async (input: { query: string }) => {
    // This will be called via the websearch tool from MCP
    return {
      success: true,
      note: `Web search requested: "${input.query}". Use the MCP websearch tool for actual results.`,
    };
  },
};

// ── Tool: Get Project Info ──────────────────────────────────────
export const getProjectInfoTool = {
  name: 'get_project_info',
  description: 'Get basic info about the current project (name, version, dependencies). Use when user asks about the project.',
  schema: z.object({
    directory: z.string().optional().describe('Project directory'),
  }),
  execute: async (input: { directory?: string }) => {
    try {
      const dir = input.directory || process.cwd();
      const pkgPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        return { success: false, error: 'No package.json found' };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return {
        success: true,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description || '',
        dependencies: Object.keys(pkg.dependencies || {}).length,
        devDependencies: Object.keys(pkg.devDependencies || {}).length,
        scripts: Object.keys(pkg.scripts || {}),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ── Tool: DB Query ──────────────────────────────────────────────
export const dbQueryTool = {
  name: 'db_query',
  description: 'Query the state database for information. Use when user asks about conversations, usage, or system state.',
  schema: z.object({
    query: z.string().describe('SQL query (SELECT only)'),
  }),
  execute: async (input: { query: string }) => {
    try {
      const db = getStateDb();
      if (!db) return { success: false, error: 'Database not available' };
      
      // Safety: only allow SELECT
      if (!input.query.trim().toUpperCase().startsWith('SELECT')) {
        return { success: false, error: 'Only SELECT queries allowed' };
      }
      
      const results = db.prepare(input.query).all();
      return {
        success: true,
        rows: results.length,
        data: results.slice(0, 20),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ── All Tools Export ──────────────────────────────────────────
export const AGENT_TOOLS = [
  readFileTool,
  listFilesTool,
  searchCodeTool,
  countModelsTool,
  countProvidersTool,
  runCommandTool,
  getProjectInfoTool,
  dbQueryTool,
  webSearchTool,
];

/**
 * Execute a tool by name with given input.
 */
export async function executeTool(name: string, input: Record<string, any>): Promise<any> {
  const tool = AGENT_TOOLS.find(t => t.name === name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }
  return await (tool.execute as any)(input);
}

/**
 * Get tool definitions in OpenAI function-calling format.
 */
export function getToolDefinitions(): any[] {
  return AGENT_TOOLS.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToOpenAIParams(tool.schema),
    },
  }));
}

/**
 * Convert Zod schema to OpenAI parameters format.
 */
function zodToOpenAIParams(schema: z.ZodObject<any>): any {
  const shape = schema.shape;
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as any;
    const def = zodType._def;
    
    if (def.typeName === 'ZodString') {
      properties[key] = { type: 'string', description: def.description || '' };
    } else if (def.typeName === 'ZodNumber') {
      properties[key] = { type: 'number', description: def.description || '' };
    } else if (def.typeName === 'ZodBoolean') {
      properties[key] = { type: 'boolean', description: def.description || '' };
    } else {
      properties[key] = { type: 'string', description: def.description || '' };
    }

    // Check if required (no default value)
    if (!def.defaultValue) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}
