import { Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import {
  getAgentService,
  getMawlanaRouter,
  getRagService,
  getStateDb,
  getVectorIndexService,
} from './agentController';
import { DiskRAGService } from '../services/ragService';
import { ensureConversation } from '../services/stateDb';
import { readRuntimeEvents, recordRuntimeEvent } from '../services/runtimeEventLog';
import { registerClient, touchClient, disconnectClient } from '../services/clientTracker';
import { broadcastAgentEvent } from '../services/eventBroadcaster';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

type McpSessionRecord = {
  sessionId: string;
  protocolVersion: string;
  clientInfo?: { name?: string; version?: string };
  capabilities?: any;
  logLevel?: string;
  initialized: boolean;
  createdAt: string;
  updatedAt: string;
  lastMethod?: string;
  sseResponse?: Response | null;
  lastEventId?: string;
};

const MCP_PROTOCOL_VERSION = '2025-03-26';
const mcpSessions = new Map<string, McpSessionRecord>();

// Per-session RAG isolation: each MCP session gets its own DiskRAGService instance
// so that 500+ folders each have independent workspace context without clobbering.
const mcpRagInstances = new Map<string, DiskRAGService>();

// Per-session conversation tracking: maps sessionId → Set of conversation_ids
// Ensures conversation isolation across 500+ editor instances.
const mcpSessionConversations = new Map<string, Set<string>>();

const SESSION_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of mcpSessions) {
    if (now - new Date(session.updatedAt).getTime() > SESSION_TTL_MS) {
      mcpSessions.delete(id);
      mcpRagInstances.delete(id); // cleanup per-session RAG
      mcpSessionConversations.delete(id); // cleanup per-session conversations
    }
  }
}, 60_000);

function rpcResult(id: JsonRpcRequest['id'], result: any) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: any) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

function createSessionId() {
  return crypto.randomUUID();
}

function saveSession(session: McpSessionRecord) {
  mcpSessions.set(session.sessionId, session);
  return session;
}

function touchSession(sessionId: string, method?: string) {
  const session = mcpSessions.get(sessionId);
  if (!session) return;
  session.updatedAt = new Date().toISOString();
  if (method) session.lastMethod = method;
  mcpSessions.set(sessionId, session);
  // Also touch the client tracker
  touchClient(sessionId);
}

function sessionClientName(session?: McpSessionRecord) {
  return session?.clientInfo?.name || 'unknown';
}

/**
 * Get the per-session RAG instance for the given sessionId.
 * Falls back to the global singleton if no per-session instance exists.
 * This ensures 500+ independent folders never clobber each other's workspace.
 */
function getSessionRag(sessionId?: string): DiskRAGService {
  if (sessionId && mcpRagInstances.has(sessionId)) {
    return mcpRagInstances.get(sessionId)!;
  }
  // Fallback: global singleton (legacy / non-session contexts)
  return getRagService();
}

async function getSessionSummary() {
  const sessions = Array.from(mcpSessions.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    activeSessions: sessions.length,
    initializedSessions: sessions.filter((s) => s.initialized).length,
    clientNames: sessions.map((s) => s.clientInfo?.name).filter(Boolean),
    sessions: sessions.slice(0, 10).map((s) => ({
      sessionId: s.sessionId,
      protocolVersion: s.protocolVersion,
      clientInfo: s.clientInfo,
      logLevel: s.logLevel,
      initialized: s.initialized,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastMethod: s.lastMethod,
    })),
    recentEvents: await readRuntimeEvents(25),
  };
}

function sendSseEvent(res: Response, eventName: string, data: any, eventId?: string) {
  if (eventId) {
    res.write(`id: ${eventId}\n`);
  }
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendSseData(res: Response, data: any, eventId?: string) {
  if (eventId) {
    res.write(`id: ${eventId}\n`);
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildTools() {
  return [
    {
      name: 'workspace_index',
      description: 'Index a workspace into the local vector store.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
          workspace_id: { type: 'string' },
        },
        required: ['directory'],
      },
    },
    {
      name: 'workspace_search',
      description: 'Search indexed workspace chunks.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          workspace_id: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
    {
      name: 'conversation_create',
      description: 'Create a new conversation id and persist its metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string' },
          user_id: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
    {
      name: 'conversation_history',
      description: 'Fetch a conversation with its message history.',
      inputSchema: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
        },
        required: ['conversation_id'],
      },
    },
    {
      name: 'conversation_list',
      description: 'List conversations for the current workspace or globally.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'ssot_read',
      description: 'Read the current SSOT file.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'project_status',
      description: 'Read current agent, RAG, and index status.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'agent_routes',
      description: 'List available routing decisions for the active agent.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    // ── File Tools ──────────────────────────────────────────
    {
      name: 'read_file',
      description: 'Read the contents of any file. Use when user asks about code, config, or file content.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to file' },
          max_lines: { type: 'number', description: 'Max lines to read (default 100)' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'list_files',
      description: 'List files and directories in a given path. Use to understand project structure.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Directory path to list' },
          pattern: { type: 'string', description: 'Glob pattern to filter' },
        },
        required: ['directory'],
      },
    },
    {
      name: 'search_code',
      description: 'Search for a pattern in file contents (grep). Find specific code, functions, or variables.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search' },
          directory: { type: 'string', description: 'Directory to search in' },
          file_pattern: { type: 'string', description: 'File pattern filter (e.g. *.ts)' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'find_files',
      description: 'Find files by name pattern (glob). Use to locate specific files.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. **/*.ts)' },
          directory: { type: 'string', description: 'Root directory to search from' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'get_file_info',
      description: 'Get metadata about a file or directory (size, dates, type).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to file or directory' },
        },
        required: ['path'],
      },
    },
    {
      name: 'run_command',
      description: 'Execute a shell command. Use for git, npm, build, test, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo. No API key required.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num_results: { type: 'number', description: 'Number of results (default 5)' },
        },
        required: ['query'],
      },
    },
  ];
}

function buildResources() {
  return [
    { uri: 'zombiecoder://status', name: 'Agent status', mimeType: 'application/json' },
    { uri: 'zombiecoder://ssot', name: 'SSOT', mimeType: 'text/markdown' },
    { uri: 'zombiecoder://index', name: 'Vector index stats', mimeType: 'application/json' },
    { uri: 'zombiecoder://conversations', name: 'Conversation list', mimeType: 'application/json' },
  ];
}

async function currentStatus() {
  const rag = getRagService();
  const index = getVectorIndexService();
  return {
    persona: getAgentService()?.getPersonaName() || 'ZombieCoder',
    workingDir: rag?.currentDir || null,
    hasWorkingDir: rag?.hasWorkingDir || false,
    ssotExists: rag?.ssotExists() || false,
    zombieDirExists: rag?.zombieDirExists() || false,
    index: index?.getStats() || { documents: 0, chunks: 0, workspaces: 0 },
    indexError: index?.getLastIndexError() || null,
    mcp: await getSessionSummary(),
  };
}

export const handleMcpInfo = async (_req: Request, res: Response) => {
  return res.json({
    protocol: 'jsonrpc-2.0',
    name: 'proxi-mcp',
    version: '1.0.0',
    tools: buildTools().length,
    resources: buildResources().length,
    status: await currentStatus(),
  });
};

async function handleJsonRpcMethod(body: JsonRpcRequest, sessionIdHeader: string): Promise<any> {
  const id = body?.id ?? null;
  const method = String(body?.method || '');
  const response: any = {};

  if (sessionIdHeader) {
    touchSession(sessionIdHeader, method);
  }

  if (method === 'initialize') {
    const sessionId = createSessionId();
    const clientInfo = body.params?.clientInfo && typeof body.params.clientInfo === 'object'
      ? {
          name: String(body.params.clientInfo.name || ''),
          version: String(body.params.clientInfo.version || ''),
        }
      : undefined;
    saveSession({
      sessionId,
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientInfo,
      capabilities: body.params?.capabilities || {},
      logLevel: 'info',
      initialized: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMethod: 'initialize',
    });

    // ─── Register connected client with directory tracking ──────────────
    const rawRootDir = body.params?.rootDirectory
      || body.params?.workspaceFolder
      || body.params?.directory
      || process.env.WORKSPACE_ROOT
      || process.cwd();

    // ── Path normalization: handle Windows paths, unresolved variables ──
    let rootDir = String(rawRootDir);

    // Check for unresolved variables like ${WORKSPACE_ROOT} or $(pwd)
    if (rootDir.includes('${') || rootDir.includes('$(')) {
      console.warn(`⚠️ MCP: Unresolved variable in rootDirectory: "${rootDir}" — falling back to process.cwd()`);
      rootDir = process.cwd();
    }

    // Check for Windows paths (drive letter like C:\ or C:/)
    const windowsPathMatch = rootDir.match(/^([a-zA-Z]):[/\\]/);
    if (windowsPathMatch) {
      const winDrive = windowsPathMatch[1].toLowerCase();
      // Convert C:\Users\sahon\s3 → /mnt/c/Users/sahon/s3 (WSL convention)
      // substring(2) skips "C:" → "\Users\sahon\s3" then replace backslashes
      const winPart = rootDir.substring(2).replace(/\\/g, '/');
      const wslPath = `/mnt/${winDrive}${winPart}`;
      console.warn(`⚠️ MCP: Windows path detected: "${rootDir}" → converted to WSL path: "${wslPath}"`);
      rootDir = wslPath;
    }

    // Check for backslashes (indicates Windows-style path)
    if (rootDir.includes('\\') && !rootDir.includes('${')) {
      rootDir = rootDir.replace(/\\/g, '/');
      console.warn(`⚠️ MCP: Backslash path normalized: "${rootDir}"`);
    }

    // Validate the path exists, fall back to cwd if not
    if (!fs.existsSync(rootDir)) {
      console.warn(`⚠️ MCP: rootDirectory does not exist: "${rootDir}" — falling back to process.cwd()`);
      rootDir = process.cwd();
    }

    const registeredClient = registerClient({
      clientId: sessionId,
      rootDirectory: String(rootDir),
      clientName: clientInfo?.name,
      userAgent: undefined,
      source: 'mcp-initialize',
      capabilities: body.params?.capabilities
        ? Object.keys(body.params.capabilities)
        : undefined,
    });
    console.log(`🔌 MCP client registered: ${clientInfo?.name || 'unknown'} → ${registeredClient.rootDirectory}`);

    // ── Per-Session RAG + SSOT Auto-Init ────────────────────────────
    // Each MCP session gets its OWN DiskRAGService instance so that
    // 500+ folders with separate editor instances never clobber each other.
    const sessionRag = new DiskRAGService();
    try {
      const initResult = await sessionRag.setWorkingDirectory(rootDir, { autoInit: true });
      if (!initResult.needsPermission) {
        if (!sessionRag.ssotExists()) {
          const scan = await sessionRag.scanProject();
          const template = sessionRag.generateSSOTTemplate(scan);
          sessionRag.saveSSOT(template);
          console.log(`📄 SSOT auto-created for MCP session ${sessionId} → ${rootDir}`);
        }
        console.log(`🧟 Per-session RAG ready: session=${sessionId} dir=${sessionRag.currentDir}`);
      } else {
        console.warn(`⚠️ MCP session ${sessionId}: RAG needs permission for ${rootDir}`);
      }
    } catch (e: any) {
      console.warn(`⚠️ MCP session ${sessionId}: RAG auto-init failed — ${e?.message || e}`);
    }
    mcpRagInstances.set(sessionId, sessionRag);

    // Broadcast session created event to all SSE subscribers
    broadcastAgentEvent({
      type: 'session_created',
      timestamp: new Date().toISOString(),
      payload: {
        sessionId,
        clientName: clientInfo?.name,
        rootDirectory: rootDir,
      },
    });

    recordRuntimeEvent({
      timestamp: new Date().toISOString(),
      category: 'mcp',
      event: 'initialize',
      sessionId,
      clientName: clientInfo?.name,
      clientVersion: clientInfo?.version,
      method,
      status: 'ok',
      details: { protocolVersion: MCP_PROTOCOL_VERSION, rootDirectory: registeredClient.rootDirectory },
    });
    response._sessionId = sessionId;
    response._protocolVersion = MCP_PROTOCOL_VERSION;
    response.body = rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'proxi-mcp', version: '1.0.0' },
      capabilities: {
        logging: {},
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true },
      },
      instructions: 'Call tools/list or resources/list after notifications/initialized.',
    });
    return response;
  }

  if (method === 'notifications/initialized' || (method.startsWith('notifications/') && id == null)) {
    if (sessionIdHeader && mcpSessions.has(sessionIdHeader)) {
      const session = mcpSessions.get(sessionIdHeader)!;
      session.initialized = true;
      session.updatedAt = new Date().toISOString();
      session.lastMethod = method;
      mcpSessions.set(sessionIdHeader, session);
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'initialized_notification',
        sessionId: sessionIdHeader,
        clientName: sessionClientName(session),
        clientVersion: session.clientInfo?.version,
        method,
        status: 'ok',
      });
    }
    response._noBody = true;
    return response;
  }

  if (method === 'logging/setLevel') {
    const level = String(body.params?.level || body.params?.logLevel || 'info').toLowerCase();
    if (sessionIdHeader && mcpSessions.has(sessionIdHeader)) {
      const session = mcpSessions.get(sessionIdHeader)!;
      session.logLevel = level;
      session.updatedAt = new Date().toISOString();
      session.lastMethod = method;
      mcpSessions.set(sessionIdHeader, session);
    }
    recordRuntimeEvent({
      timestamp: new Date().toISOString(),
      category: 'mcp',
      event: 'logging_set_level',
      sessionId: sessionIdHeader || undefined,
      method,
      status: 'ok',
      details: { level },
    });
    response.body = rpcResult(id, { level });
    return response;
  }

  if (method === 'tools/list') {
    recordRuntimeEvent({
      timestamp: new Date().toISOString(),
      category: 'mcp',
      event: 'tools_list',
      sessionId: sessionIdHeader || undefined,
      method,
      status: 'ok',
    });
    response.body = rpcResult(id, { tools: buildTools() });
    return response;
  }

  if (method === 'resources/list') {
    recordRuntimeEvent({
      timestamp: new Date().toISOString(),
      category: 'mcp',
      event: 'resources_list',
      sessionId: sessionIdHeader || undefined,
      method,
      status: 'ok',
    });
    response.body = rpcResult(id, { resources: buildResources() });
    return response;
  }

  if (method === 'prompts/list') {
    recordRuntimeEvent({
      timestamp: new Date().toISOString(),
      category: 'mcp',
      event: 'prompts_list',
      sessionId: sessionIdHeader || undefined,
      method,
      status: 'ok',
    });
    response.body = rpcResult(id, { prompts: [] });
    return response;
  }

  if (method === 'resources/read') {
    const uri = String(body.params?.uri || '');
    const rag = getSessionRag(sessionIdHeader);
    const index = getVectorIndexService();
    const stateDb = getStateDb();

    if (uri === 'zombiecoder://status') {
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'resources_read_status',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
      });
      response.body = rpcResult(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await currentStatus(), null, 2) }] });
      return response;
    }
    if (uri === 'zombiecoder://ssot') {
      const text = rag?.readSSOT() || '';
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'resources_read_ssot',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
      });
      response.body = rpcResult(id, { contents: [{ uri, mimeType: 'text/markdown', text }] });
      return response;
    }
    if (uri === 'zombiecoder://index') {
      const text = JSON.stringify(index?.getStats() || { documents: 0, chunks: 0, workspaces: 0 }, null, 2);
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'resources_read_index',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
      });
      response.body = rpcResult(id, { contents: [{ uri, mimeType: 'application/json', text }] });
      return response;
    }
    if (uri === 'zombiecoder://conversations') {
      const conversations = stateDb
        ? stateDb.prepare(`
            SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
            FROM conversations
            ORDER BY updated_at DESC
            LIMIT 100
          `).all()
        : [];
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'resources_read_conversations',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
      });
      response.body = rpcResult(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(conversations, null, 2) }] });
      return response;
    }

    response.statusCode = 404;
    response.body = rpcError(id, -32602, 'Unknown resource', { uri });
    return response;
  }

  if (method === 'tools/call') {
    const name = String(body.params?.name || '');
    const args = body.params?.arguments || {};
    // Use per-session RAG so 500+ independent folders never collide
    const rag = getSessionRag(sessionIdHeader);
    const index = getVectorIndexService();
    const stateDb = getStateDb();

    // ── DEBUG: Log every tools/call entry ──────────────────────
    console.log(`🔧 MCP tools/call: name="${name}" args=${JSON.stringify(args).substring(0, 300)} session=${sessionIdHeader || '-'}`);
    recordRuntimeEvent({
      timestamp: new Date().toISOString(),
      category: 'mcp',
      event: 'tools_call_received',
      sessionId: sessionIdHeader || undefined,
      method,
      status: 'received',
      details: { toolName: name, argKeys: Object.keys(args) },
    });
    // ─────────────────────────────────────────────────────────

    if (name === 'workspace_index') {
      const directory = String(args.directory || '');
      if (!directory) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'directory is required');
        return response;
      }
      const resolvedDir = path.resolve(directory);
      if (rag) {
        const needsInit = !rag.hasWorkingDir || rag.currentDir !== resolvedDir;
        const result2 = await rag.setWorkingDirectory(resolvedDir, { autoInit: needsInit ? true : undefined });
        if (result2.needsPermission) {
          response.statusCode = 403;
          response.body = rpcError(id, -32001, 'Permission required', { message: rag.requestPermissionMessage('scan') });
          return response;
        }
        // ── SSOT Existence Check: ensure SSOT.md exists before indexing ──
        // If SSOT is missing, auto-create it so the agent never works blind.
        if (!rag.ssotExists()) {
          try {
            const scan = await rag.scanProject();
            const template = rag.generateSSOTTemplate(scan);
            rag.saveSSOT(template);
            console.log(`📄 workspace_index: SSOT auto-created for ${resolvedDir}`);
          } catch (e: any) {
            console.warn(`⚠️ workspace_index: SSOT auto-create failed — ${e?.message || e}`);
          }
        }
      }
      const result = await index?.indexDirectory(resolvedDir, {
        workspaceId: args.workspace_id ? String(args.workspace_id) : undefined,
      });
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'workspace_index',
        sessionId: sessionIdHeader || undefined,
        method,
        workspaceId: args.workspace_id ? String(args.workspace_id) : undefined,
        directory: resolvedDir,
        status: 'ok',
        details: result as any,
      });
      response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      return response;
    }

    if (name === 'workspace_search') {
      const query = String(args.query || '');
      if (!query) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'query is required');
        return response;
      }
      const result = await index?.search(query, {
        workspaceId: args.workspace_id ? String(args.workspace_id) : undefined,
        limit: Number(args.limit) || 5,
      });
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'workspace_search',
        sessionId: sessionIdHeader || undefined,
        method,
        workspaceId: args.workspace_id ? String(args.workspace_id) : undefined,
        status: 'ok',
        details: { query, matches: result?.matches?.length || 0 },
      });
      response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      return response;
    }

    if (name === 'conversation_create') {
      if (!stateDb) {
        response.statusCode = 500;
        response.body = rpcError(id, -32000, 'state db not initialized');
        return response;
      }
      const conversationId = crypto.randomUUID();

      // Track conversation per session for isolation
      if (sessionIdHeader) {
        if (!mcpSessionConversations.has(sessionIdHeader)) {
          mcpSessionConversations.set(sessionIdHeader, new Set());
        }
        mcpSessionConversations.get(sessionIdHeader)!.add(conversationId);
      }

      ensureConversation(stateDb, {
        conversation_id: conversationId,
        workspace_id: args.workspace_id ? String(args.workspace_id) : undefined,
        user_id: args.user_id ? String(args.user_id) : undefined,
        title: args.title ? String(args.title) : undefined,
      });
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'conversation_create',
        sessionId: sessionIdHeader || undefined,
        method,
        workspaceId: args.workspace_id ? String(args.workspace_id) : undefined,
        status: 'ok',
        details: { conversationId },
      });
      response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ conversation_id: conversationId }, null, 2) }] });
      return response;
    }

    if (name === 'conversation_history') {
      if (!stateDb) {
        response.statusCode = 500;
        response.body = rpcError(id, -32000, 'state db not initialized');
        return response;
      }
      const conversationId = String(args.conversation_id || '');
      if (!conversationId) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'conversation_id is required');
        return response;
      }
      const conversation = stateDb.prepare(`
        SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
        FROM conversations
        WHERE conversation_id = ?
        LIMIT 1
      `).get(conversationId);
      const messages = stateDb.prepare(`
        SELECT id, conversation_id, role, content, created_at
        FROM conversation_messages
        WHERE conversation_id = ?
        ORDER BY id ASC
      `).all(conversationId);
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'conversation_history',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
        details: { conversationId, messageCount: Array.isArray(messages) ? messages.length : 0 },
      });
      response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ conversation, messages }, null, 2) }] });
      return response;
    }

    if (name === 'conversation_list') {
      if (!stateDb) {
        response.statusCode = 500;
        response.body = rpcError(id, -32000, 'state db not initialized');
        return response;
      }
      const limit = Math.max(1, Number(args.limit) || 50);
      const rows = args.workspace_id
        ? stateDb.prepare(`
            SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
            FROM conversations
            WHERE workspace_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `).all(String(args.workspace_id), limit)
        : stateDb.prepare(`
            SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
            FROM conversations
            ORDER BY updated_at DESC
            LIMIT ?
          `).all(limit);
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'conversation_list',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
        details: { count: Array.isArray(rows) ? rows.length : 0 },
      });
      response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] });
      return response;
    }

    if (name === 'ssot_read') {
      let text = rag?.readSSOT() || '';
      if (!text && rag?.hasWorkingDir) {
        const scanResult = await rag.scanProject();
        const template = rag.generateSSOTTemplate(scanResult);
        rag.saveSSOT(template);
        text = rag.readSSOT();
      }
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'ssot_read',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
      });
      response.body = rpcResult(id, { content: [{ type: 'text', text }] });
      return response;
    }

    if (name === 'project_status') {
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'project_status',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
      });
      response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(await currentStatus(), null, 2) }] });
      return response;
    }

    if (name === 'agent_routes') {
      const routes = getMawlanaRouter()?.getAllRoutes() || {};
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'mcp',
        event: 'agent_routes',
        sessionId: sessionIdHeader || undefined,
        method,
        status: 'ok',
      });
      response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(routes, null, 2) }] });
      return response;
    }

    // ── File Tools ──────────────────────────────────────────
    if (name === 'read_file') {
      const filePath = String(args.file_path || '');
      const maxLines = Number(args.max_lines) || 100;
      if (!filePath) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'file_path is required');
        return response;
      }
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const truncated = lines.slice(0, maxLines).join('\n');
        response.body = rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({
            success: true, file: filePath, total_lines: lines.length,
            content: truncated, truncated: lines.length > maxLines,
          }, null, 2) }],
        });
        return response;
      } catch (err: any) {
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] });
        return response;
      }
    }

    if (name === 'list_files') {
      const dir = String(args.directory || '');
      const pattern = args.pattern ? String(args.pattern) : undefined;
      if (!dir) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'directory is required');
        return response;
      }
      try {
        if (!fs.existsSync(dir)) {
          response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Directory not found: ${dir}` }) }] });
          return response;
        }
        const items = fs.readdirSync(dir, { withFileTypes: true });
        let files = items.map((i: any) => ({ name: i.name, type: i.isDirectory() ? 'dir' : 'file' }));
        if (pattern) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          files = files.filter((f: any) => regex.test(f.name));
        }
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: true, directory: dir, count: files.length, items: files.slice(0, 50) }, null, 2) }] });
        return response;
      } catch (err: any) {
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] });
        return response;
      }
    }

    if (name === 'search_code') {
      const searchPattern = String(args.pattern || '');
      const searchDir = args.directory ? String(args.directory) : process.cwd();
      const searchFilePattern = args.file_pattern ? String(args.file_pattern) : '';
      if (!searchPattern) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'pattern is required');
        return response;
      }
      try {
        const regex = new RegExp(searchPattern, 'i');
        const fileRegex = searchFilePattern ? new RegExp('^' + searchFilePattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
        const excludeDirs = ['node_modules', '.git', 'dist', 'logs', '.zombiecoder', 'build'];
        const results: string[] = [];
        const walk = (dir: string) => {
          if (results.length >= 30) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (results.length >= 30) return;
              if (excludeDirs.includes(entry.name)) continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(fullPath);
              } else if (entry.isFile()) {
                if (fileRegex && !fileRegex.test(entry.name)) continue;
                try {
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  const lines = content.split('\n');
                  for (let i = 0; i < lines.length && results.length < 30; i++) {
                    if (regex.test(lines[i])) {
                      results.push(`${fullPath}:${i + 1}:${lines[i].trim()}`);
                    }
                  }
                } catch { /* skip unreadable files */ }
              }
            }
          } catch { /* skip inaccessible dirs */ }
        };
        walk(searchDir);
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: true, pattern: searchPattern, directory: searchDir, results }, null, 2) }] });
        return response;
      } catch (err: any) {
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message || 'No matches found' }) }] });
        return response;
      }
    }

    if (name === 'find_files') {
      const findPattern = String(args.pattern || '');
      const findDir = args.directory ? String(args.directory) : process.cwd();
      if (!findPattern) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'pattern is required');
        return response;
      }
      try {
        // Convert glob pattern to regex
        const regexStr = '^' + findPattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$';
        const regex = new RegExp(regexStr, 'i');
        const excludeDirs = ['node_modules', '.git', 'dist', 'logs', '.zombiecoder', 'build'];
        const files: string[] = [];
        const walk = (dir: string) => {
          if (files.length >= 50) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (files.length >= 50) return;
              if (excludeDirs.includes(entry.name)) continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(fullPath);
              } else if (entry.isFile()) {
                const relativePath = path.relative(findDir, fullPath).replace(/\\/g, '/');
                if (regex.test(relativePath) || regex.test(entry.name)) {
                  files.push(fullPath);
                }
              }
            }
          } catch { /* skip */ }
        };
        walk(findDir);
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: true, pattern: findPattern, directory: findDir, count: files.length, files }, null, 2) }] });
        return response;
      } catch (err: any) {
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message || 'No files found' }) }] });
        return response;
      }
    }

    if (name === 'get_file_info') {
      const filePath = String(args.path || '');
      if (!filePath) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'path is required');
        return response;
      }
      try {
        const stat = fs.statSync(filePath);
        response.body = rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            path: filePath,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
            accessed: stat.atime.toISOString(),
          }, null, 2) }],
        });
        return response;
      } catch (err: any) {
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] });
        return response;
      }
    }

    if (name === 'run_command') {
      const command = String(args.command || '');
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const timeout = Number(args.timeout) || 30000;
      if (!command) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'command is required');
        return response;
      }
      try {
        const result = execSync(command, { encoding: 'utf-8', timeout, cwd });
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: true, command, output: result.trim() }, null, 2) }] });
        return response;
      } catch (err: any) {
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: false, command, error: err.message, output: err.stdout || '' }) }] });
        return response;
      }
    }

    if (name === 'web_search') {
      const https = require('https');
      const query = String(args.query || '');
      const numResults = Number(args.num_results) || 5;
      if (!query) {
        response.statusCode = 400;
        response.body = rpcError(id, -32602, 'query is required');
        return response;
      }
      try {
        const postData = `q=${encodeURIComponent(query)}&kl=wt-wt`;
        const result = await new Promise<string>((resolve, reject) => {
          const req = https.request({
            hostname: 'lite.duckduckgo.com',
            path: '/lite',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
          }, (res: any) => {
            let data = '';
            res.on('data', (chunk: any) => data += chunk);
            res.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.write(postData);
          req.end();
        });
        // Parse simple results from DuckDuckGo lite HTML
        const titleMatches = result.match(/<a[^>]*class="result-link"[^>]*>([^<]+)<\/a>/g) || [];
        const titles = titleMatches.map((m: string) => m.replace(/<[^>]+>/g, '').trim()).slice(0, numResults);
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: true, query, results: titles }, null, 2) }] });
        return response;
      } catch (err: any) {
        response.body = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] });
        return response;
      }
    }

    response.statusCode = 404;
    response.body = rpcError(id, -32601, 'Unknown tool', { name });
    console.warn(`⚠️ MCP Unknown tool: "${name}" session=${sessionIdHeader || '-'} — known tools: workspace_index, workspace_search, conversation_create, conversation_history, conversation_list, ssot_read, project_status, agent_routes, read_file, list_files, search_code, find_files, get_file_info, run_command, web_search`);
    recordRuntimeEvent({
      timestamp: new Date().toISOString(),
      category: 'mcp',
      event: 'unknown_tool',
      sessionId: sessionIdHeader || undefined,
      method,
      status: 'error',
      details: { toolName: name },
    });
    return response;
  }

  if (method.startsWith('notifications/')) {
    // ── DEBUG: Log notifications ──────────────────────────────
    console.log(`📢 MCP notification: ${method} session=${sessionIdHeader || '-'}`);
    // ─────────────────────────────────────────────────────────
    response._noBody = true;
    return response;
  }

  // ── DEBUG: Unknown method ──────────────────────────────────
  console.warn(`⚠️ MCP Unknown method: "${method}" session=${sessionIdHeader || '-'}`);
  recordRuntimeEvent({
    timestamp: new Date().toISOString(),
    category: 'mcp',
    event: 'unknown_method',
    sessionId: sessionIdHeader || undefined,
    method,
    status: 'error',
    details: { method },
  });
  // ─────────────────────────────────────────────────────────

  response.statusCode = 404;
  response.body = rpcError(id, -32601, 'Method not found', { method });
  return response;
}

export const handleMcpJsonRpc = async (req: Request, res: Response) => {
  const body = req.body as JsonRpcRequest;

  // ── DEBUG: Log every incoming MCP request ──────────────────────
  const reqMethod = body?.method || 'unknown';
  const reqId = body?.id ?? '-';
  const reqSession = req.get('Mcp-Session-Id') || req.get('mcp-session-id') || '-';
  const reqAccept = req.get('Accept') || '-';
  const reqContentType = req.get('Content-Type') || '-';
  console.log(`📥 MCP INCOMING: method=${reqMethod} id=${reqId} session=${reqSession} accept=${reqAccept} content-type=${reqContentType}`);
  if (reqMethod !== 'initialize' && reqMethod !== 'notifications/initialized' && !reqMethod.startsWith('notifications/')) {
    console.log(`📥 MCP BODY: ${JSON.stringify(body).substring(0, 500)}`);
  }
  // ─────────────────────────────────────────────────────────────

  try {
    if (!body || typeof body !== 'object') {
      console.warn('⚠️ MCP: Invalid request body');
      return res.status(400).json(rpcError(null, -32600, 'Invalid Request'));
    }

    const sessionIdHeader = String(req.get('Mcp-Session-Id') || req.get('mcp-session-id') || '').trim();
    const acceptSse = (req.get('Accept') || '').includes('text/event-stream');
    const lastEventId = String(req.get('Last-Event-ID') || req.get('last-event-id') || '').trim() || undefined;

      // If client wants SSE and session supports it, stream the response
    if (acceptSse || lastEventId) {
      const result = await handleJsonRpcMethod(body, sessionIdHeader);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      if (result._sessionId) {
        res.setHeader('Mcp-Session-Id', result._sessionId);
        res.setHeader('MCP-Protocol-Version', result._protocolVersion);

        // Attach SSE response to session for server→client push
        const session = mcpSessions.get(result._sessionId);
        if (session) {
          session.sseResponse = res;
          session.lastEventId = lastEventId || '0';
          mcpSessions.set(result._sessionId, session);
        }
      }

      if (result._noBody) {
        sendSseEvent(res, 'done', {});
        res.end();
        return;
      }

      if (result.statusCode) {
        res.status(result.statusCode);
      }

      // ── DEBUG: Log SSE response ────────────────────────────
      const sseStatusCode = result.statusCode || 200;
      console.log(`📤 MCP SSE RESPONSE: method=${reqMethod} status=${sseStatusCode} session=${reqSession}`);
      // ─────────────────────────────────────────────────────
      sendSseEvent(res, 'message', result.body);
      sendSseEvent(res, 'done', {});
      res.end();
      return;
    }

    // Normal JSON response
    const result = await handleJsonRpcMethod(body, sessionIdHeader);

    if (result._sessionId) {
      res.setHeader('Mcp-Session-Id', result._sessionId);
      res.setHeader('MCP-Protocol-Version', result._protocolVersion);
    }

    if (result._noBody) {
      // ── DEBUG: Log 204 response ───────────────────────────
      console.log(`📤 MCP JSON RESPONSE: method=${reqMethod} status=204 session=${reqSession}`);
      // ─────────────────────────────────────────────────────
      return res.status(204).end();
    }

    if (result.statusCode) {
      // ── DEBUG: Log error response ──────────────────────────
      console.log(`📤 MCP JSON RESPONSE: method=${reqMethod} status=${result.statusCode} session=${reqSession} body=${JSON.stringify(result.body).substring(0, 300)}`);
      // ─────────────────────────────────────────────────────
      return res.status(result.statusCode).json(result.body);
    }

    // ── DEBUG: Log success response ──────────────────────────
    console.log(`📤 MCP JSON RESPONSE: method=${reqMethod} status=200 session=${reqSession}`);
    // ─────────────────────────────────────────────────────
    return res.json(result.body);
  } catch (err: any) {
    console.error(`❌ MCP ERROR: method=${reqMethod} session=${reqSession} error=${err?.message}`);
    return res.status(500).json(rpcError(null, -32000, err?.message || 'Internal error'));
  }
};

export const handleMcpSseStream = async (req: Request, res: Response) => {
  const accept = req.get('Accept') || '*/*';
  const acceptJson = accept.includes('application/json') || accept === '*/*';
  const acceptSse = accept.includes('text/event-stream') || req.get('Upgrade') === 'text/event-stream';

  // Default to JSON (backward compat) unless SSE is explicitly requested
  if (acceptJson && !acceptSse) {
    return handleMcpInfo(req, res);
  }

  const sessionIdHeader = String(req.get('Mcp-Session-Id') || req.get('mcp-session-id') || '').trim();
  const lastEventId = String(req.get('Last-Event-ID') || req.get('last-event-id') || '0').trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial endpoint info — use full URL for client compatibility
  const host = req.get('host') || 'localhost:9999';
  const baseUrl = `http://${host}`;
  sendSseEvent(res, 'endpoint', { url: `${baseUrl}/mcp`, protocol: MCP_PROTOCOL_VERSION, capabilities: ['streaming'] });

  if (sessionIdHeader && mcpSessions.has(sessionIdHeader)) {
    const session = mcpSessions.get(sessionIdHeader)!;
    session.sseResponse = res;
    session.lastEventId = lastEventId;
    mcpSessions.set(sessionIdHeader, session);

    sendSseEvent(res, 'resumed', { sessionId: sessionIdHeader, lastEventId });
  }

  // Keep connection alive with periodic heartbeats
  const heartbeat = setInterval(() => {
    sendSseEvent(res, 'heartbeat', { timestamp: new Date().toISOString() });
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (sessionIdHeader && mcpSessions.has(sessionIdHeader)) {
      const session = mcpSessions.get(sessionIdHeader)!;
      session.sseResponse = null;
      mcpSessions.set(sessionIdHeader, session);
    }
  });
};

export const handleMcpDeleteSession = async (req: Request, res: Response) => {
  const sessionId = String(req.params?.sessionId || req.get('Mcp-Session-Id') || req.get('mcp-session-id') || '').trim();

  if (!sessionId || !mcpSessions.has(sessionId)) {
    return res.status(404).json(rpcError(null, -32602, 'Session not found', { sessionId }));
  }

  const session = mcpSessions.get(sessionId)!;

  // Close SSE connection if open
  if (session.sseResponse) {
    try {
      sendSseEvent(session.sseResponse, 'session/terminated', { sessionId, reason: 'client requested' });
      session.sseResponse.end();
    } catch { /* ignore */ }
  }

  mcpSessions.delete(sessionId);
  mcpRagInstances.delete(sessionId); // cleanup per-session RAG
  mcpSessionConversations.delete(sessionId); // cleanup per-session conversations

  // Broadcast session terminated event
  broadcastAgentEvent({
    type: 'session_terminated',
    timestamp: new Date().toISOString(),
    payload: { sessionId, clientName: sessionClientName(session) },
  });

  // Also disconnect from client tracker
  disconnectClient(sessionId);

  recordRuntimeEvent({
    timestamp: new Date().toISOString(),
    category: 'mcp',
    event: 'session_terminated',
    sessionId,
    clientName: sessionClientName(session),
    status: 'ok',
  });

  return res.json(rpcResult(null, { terminated: true, sessionId }));
};
