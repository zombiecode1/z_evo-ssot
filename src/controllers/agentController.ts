import { Request, Response } from 'express';
import { AgentService } from '../services/agentService';
import { DiskRAGService } from '../services/ragService';
import { MawlanaRouter } from '../services/mawlanaRouter';


import { getService } from './openaiController';
import { runLangChainAgent, clearSessionMemory, getMemoryStats, shutdownAgent } from '../services/langchainAgent';

import { getIdentity } from '../services/identityService';
import { runPipeline, runStreamingPipeline, initPipeline, routeModel } from '../services/unifiedPipeline';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { initStateDb, setStateDb, upsertModels, upsertModelRateLimits, upsertPersona, isWorkspaceTrusted, ensureConversation, addConversationMessage, listConversationMessages, upsertWorkspaceTrust } from '../services/stateDb';
import { initAdminTables } from '../admin/db';
import { addEditorConnection } from '../admin/db';
import { startWorkspaceWatcher, WorkspaceWatcher } from '../services/workspaceWatcher';
import { VectorIndexService } from '../services/vectorIndexService';
import { callMcpTool, getMcpTools, isMcpConnected } from '../mcp/client';

function stripThinkBlocks(text: string): string {
  if (!text) return text;
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
}

let agentService: AgentService;
let ragService: DiskRAGService;
let mawlanaRouter: MawlanaRouter;
let vectorIndexService: VectorIndexService;
let stateDb: any;
const workspaceWatchers: Map<string, WorkspaceWatcher> = new Map();

export const initializeAgentSystem = async (workingDir?: string) => {
  const groq = getService();
  if (!groq) throw new Error('GroqService not initialized');

  ragService = new DiskRAGService();
  mawlanaRouter = new MawlanaRouter(groq);
  agentService = new AgentService(groq, ragService);

  if (workingDir) {
    try {
      await ragService.setWorkingDirectory(workingDir, { autoInit: true });
    } catch (e: any) {
      console.warn('rag setWorkingDirectory autoInit failed:', e?.message || e);
    }
    // Start watcher for the default workspace to keep SSOT up-to-date
    try {
      const key = `default:${workingDir}`;
      if (!workspaceWatchers.has(key)) {
        workspaceWatchers.set(key, startWorkspaceWatcher({
          directory: workingDir,
          rag: ragService,
          index: vectorIndexService,
          workspaceId: 'default',
        }));
        console.log(`👁️ Workspace watcher started for default workspace: ${workingDir}`);
      }
    } catch (e: any) {
      console.warn('Failed to start default workspace watcher:', e?.message || e);
    }
  }

  // Initialize local SQLite state DB under the working directory.
  try {
    const baseDir = path.resolve(workingDir || process.cwd());
    const zdir = path.join(baseDir, '.zombiecoder');
    if (!fs.existsSync(zdir)) fs.mkdirSync(zdir, { recursive: true });
    const dbPath = path.join(zdir, 'state.db');
    stateDb = initStateDb(dbPath);
    setStateDb(stateDb);
    initAdminTables();
    vectorIndexService = new VectorIndexService(stateDb);

    const identity = getIdentity();
    if (identity?.system_identity) {
      upsertPersona(stateDb, {
        persona_id: 'default',
        name: identity.system_identity.name || 'ZombieCoder',
        system_prompt: identity.system_identity.system_prompt || '',
      });
    }

    upsertModels(stateDb, groq.getModels());
    upsertModelRateLimits(stateDb, groq.getConfiguredRateLimits());
    // Auto-trust loader: read .zombiecoder/auto_trust.json and auto-init trusted workspaces
    try {
      const autoTrustPath = path.join(baseDir, '.zombiecoder', 'auto_trust.json');
      if (fs.existsSync(autoTrustPath)) {
        const raw = fs.readFileSync(autoTrustPath, 'utf-8');
        const list = JSON.parse(raw || '[]');
        if (Array.isArray(list)) {
          for (const entry of list) {
            try {
              const dirCandidate = String(entry || '').trim();
              if (!dirCandidate) continue;
              const resolved = path.isAbsolute(dirCandidate) ? dirCandidate : path.resolve(baseDir, dirCandidate);
              if (!fs.existsSync(resolved)) {
                console.warn('auto_trust: directory does not exist, skipping:', resolved);
                continue;
              }
              const workspaceId = 'auto:' + crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
              try {
                upsertWorkspaceTrust(stateDb, {
                  workspace_id: workspaceId,
                  user_id: 'auto',
                  directory: resolved,
                  trusted: true,
                });
              } catch (e: any) {
                console.warn('auto_trust: upsertWorkspaceTrust failed:', e?.message || e);
              }

              // Use a dedicated DiskRAGService instance per watched directory so multiple directories
              // can be scanned/watched independently without clobbering a shared workingDir.
              const localRag = new DiskRAGService();
              try {
                // autoInit will create .zombiecoder/SSOT.md if missing
                // eslint-disable-next-line no-await-in-loop
                await localRag.setWorkingDirectory(resolved, { autoInit: true });
              } catch (e: any) {
                console.warn('auto_trust: setWorkingDirectory failed for', resolved, e?.message || e);
              }

              // Start a watcher for this directory to keep SSOT up-to-date
              try {
                const key = `${workspaceId}:${resolved}`;
                if (!workspaceWatchers.has(key)) {
                  workspaceWatchers.set(key, startWorkspaceWatcher({
                    directory: resolved,
                    rag: localRag,
                    index: vectorIndexService,
                    workspaceId,
                  }));
                }
              } catch (e: any) {
                console.warn('auto_trust: failed to start watcher for', resolved, e?.message || e);
              }
            } catch (e: any) {
              console.warn('auto_trust: entry processing failed:', e?.message || e);
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('auto_trust load failed:', e?.message || e);
    }
  } catch (e: any) {
    console.warn('state db init failed:', e?.message || e);
  }

  return { agentService, ragService, mawlanaRouter };
};

// ── Initialize Unified Pipeline (architecture: single pipeline) ──
// Called after the main agent system is initialized.
// This sets up the Vercel AI SDK provider registry + unified pipeline.
export const initializeUnifiedPipeline = async () => {
  try {
    initPipeline({
      rag: ragService,
      vectorIndex: vectorIndexService,
      mawlana: mawlanaRouter,
      groq: getService(),
    });
    console.log('✅ Unified Pipeline initialized (architecture: Vercel AI SDK + LangChain)');
  } catch (e: any) {
    console.warn('⚠️ Unified Pipeline init failed (falling back to legacy):', e?.message || e);
  }
};

export const getAgentService = () => agentService;
export const getRagService = () => ragService;
export const getMawlanaRouter = () => mawlanaRouter;
export const getVectorIndexService = () => vectorIndexService;
export const getStateDb = () => stateDb;

export const handleCreateEditorSession = async (req: Request, res: Response) => {
  try {
    const { directory, client_name } = req.body || {};
    if (!directory) return res.status(400).json({ error: { message: 'directory is required', type: 'invalid_request_error' } });

    const resolved = path.resolve(String(directory));
    if (!fs.existsSync(resolved)) return res.status(400).json({ error: { message: 'directory does not exist', type: 'invalid_request_error' } });

    if (!stateDb) return res.status(500).json({ error: { message: 'state db not initialized', type: 'server_error' } });

    // Auto-trust any directory (global agent mode)
    const wsId = 'editor:' + crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
    try {
      const existing = stateDb.prepare('SELECT trusted FROM workspaces WHERE directory = ? LIMIT 1').get(resolved) as any;
      if (!existing || !existing.trusted) {
        upsertWorkspaceTrust(stateDb, {
          workspace_id: wsId,
          user_id: client_name || 'editor',
          directory: resolved,
          trusted: true,
        });
        console.log(`[Agent] Auto-trusted editor directory: ${resolved}`);
      }
    } catch (e: any) {
      console.warn('auto-trust editor failed:', e?.message || e);
    }

    // Locate mcp folder (search upwards) and parse .env for MCP_PUBLIC_URL / MCP_SERVER_PORT / MCP_SERVER_HOST / MCP_OAUTH_SECRET
    let cur = resolved;
    let mcpRoot: string | null = null;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(cur, 'mcp');
      if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'mcp.json'))) { mcpRoot = candidate; break; }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (!mcpRoot) {
      const fallback = path.join(process.cwd(), 'mcp');
      if (fs.existsSync(fallback) && fs.existsSync(path.join(fallback, 'mcp.json'))) mcpRoot = fallback;
    }

    if (!mcpRoot) return res.status(404).json({ error: { message: 'mcp config not found', type: 'not_found' } });

    const envPath = path.join(mcpRoot, '.env');
    let baseUrl = 'http://localhost:3000';
    let oauthSecret = '';
    if (fs.existsSync(envPath)) {
      const text = fs.readFileSync(envPath, 'utf8');
      const lines = text.split(/\r?\n/);
      const env: Record<string, string> = {};
      for (const l of lines) {
        const m = l.match(/^\s*([A-Za-z0-9_]+)=(.*)$/);
        if (!m) continue;
        const k = m[1];
        let v = m[2] || '';
        v = v.replace(/^\"|\"$/g, '').replace(/^\'|\'$/g, '');
        env[k] = v;
      }
      if (env.MCP_PUBLIC_URL && env.MCP_PUBLIC_URL.trim()) baseUrl = env.MCP_PUBLIC_URL.trim();
      else {
        const host = env.MCP_SERVER_HOST || env.MCP_SERVER || 'localhost';
        const port = env.MCP_SERVER_PORT || env.MCP_SERVER_PORT || '3000';
        baseUrl = `http://${host}:${port}`;
      }
      oauthSecret = env.MCP_OAUTH_SECRET || env.MCP_OAUTH || env.MCP_OAUTH_SECRET || '';
    }

    // Call mcp /auth/register and /auth/token to obtain a client token
    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: client_name || 'proxi-auto-client', redirect_uris: [] })
    }).catch(e => ({ ok: false, status: 0, text: () => String(e) } as any));

    if (!regRes || !regRes.ok) {
      const txt = await (regRes.text ? regRes.text() : String(regRes));
      return res.status(502).json({ error: { message: 'registration failed: ' + txt, type: 'upstream_error' } });
    }
    const regJson = await regRes.json();
    const clientId = regJson.client_id || 'mcp-agent-server';

    const tokenRes = await fetch(`${baseUrl}/auth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: oauthSecret })
    }).catch(e => ({ ok: false, status: 0, text: () => String(e) } as any));

    if (!tokenRes || !tokenRes.ok) {
      const txt = await (tokenRes.text ? tokenRes.text() : String(tokenRes));
      return res.status(502).json({ error: { message: 'token request failed: ' + txt, type: 'upstream_error' } });
    }
    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) return res.status(502).json({ error: { message: 'no access_token in token response', type: 'upstream_error' } });

    // Save token to workspace .zombiecoder directory
    const zdir = path.join(resolved, '.zombiecoder');
    if (!fs.existsSync(zdir)) fs.mkdirSync(zdir, { recursive: true });
    const outPath = path.join(zdir, 'mcp_session.json');
    const content = { access_token: accessToken, expires_at: Date.now() + ((tokenJson.expires_in || 3600) * 1000), created_at: new Date().toISOString(), base_url: baseUrl };
    fs.writeFileSync(outPath, JSON.stringify(content, null, 2) + '\n', 'utf8');

    try {
      if (stateDb) {
        addEditorConnection(stateDb, {
          connection_id: crypto.createHash('sha256').update(`${resolved}:${client_name || 'editor'}:${outPath}`).digest('hex').slice(0, 32),
          editor_name: String(client_name || 'editor'),
          client_name: String(client_name || 'editor'),
          workspace_id: wsId,
          directory: resolved,
          session_path: outPath,
          active: true,
        });
      }
    } catch (e: any) {
      console.warn('editor connection record failed:', e?.message || e);
    }

    return res.json({ ok: true, savedTo: outPath, baseUrl });
  } catch (err: any) {
    return res.status(500).json({ error: { message: err.message || 'failed to create session', type: 'server_error' } });
  }
};

function resolveConversationId(conversation_id?: string): string {
  return conversation_id && String(conversation_id).trim() ? String(conversation_id).trim() : crypto.randomUUID();
}

/**
 * Detect and execute tools based on user question via MCP.
 * Returns tool results that should be injected into context.
 * This prevents the agent from lying when tools can answer.
 */
async function executeToolsForQuestion(userMessage: string): Promise<string[]> {
  const lower = userMessage.toLowerCase();
  const toolResults: string[] = [];

  // If MCP is not connected, skip tool execution
  if (!isMcpConnected()) {
    console.warn('⚠️ MCP not connected, skipping tool execution');
    return toolResults;
  }

  // Pattern matching for common questions
  const toolMappings: Array<{ patterns: RegExp[]; tool: string; getInput: (m: string) => Record<string, any> }> = [
    {
      patterns: [/কত.*model|কত.*মডেল|how many.*model|number.*model/i],
      tool: 'count_models',
      getInput: () => ({}),
    },
    {
      patterns: [/কত.*provider|কত.*প্রোভাইডার|how many.*provider|number.*provider/i],
      tool: 'count_providers',
      getInput: () => ({}),
    },
    {
      patterns: [/package\.json|প্রোজেক্ট.*কী|প্রোজেক্ট.*নাম|project.*name|what.*project/i],
      tool: 'get_project_info',
      getInput: () => ({ directory: process.cwd() }),
    },
    {
      patterns: [/কোন.*ফাইল|কী.*ফাইল|list.*file|what.*file|folder.*structure|directory.*structure/i],
      tool: 'list_files',
      getInput: () => ({ directory: process.cwd() }),
    },
    {
      patterns: [/কোন.*কোড|কী.*কোড|search.*code|find.*function|grep/i],
      tool: 'search_code',
      getInput: (m) => ({ pattern: m.replace(/.*(?:search|find|grep|খুঁজুন|find)\s*/i, ''), directory: process.cwd() }),
    },
  ];

  for (const mapping of toolMappings) {
    if (mapping.patterns.some(p => p.test(lower))) {
      console.log(`🔧 Tool match: "${mapping.tool}" for message: "${userMessage.substring(0, 50)}..."`);
      try {
        const result = await callMcpTool(mapping.tool, mapping.getInput(lower));
        console.log(`🔧 Tool result: success=${result.success}, hasData=${!!result.data}`);
        if (result.success) {
          toolResults.push(`[Tool: ${mapping.tool}] ${JSON.stringify(result, null, 2)}`);
        }
      } catch (e: any) {
        console.warn(`Tool ${mapping.tool} failed:`, e.message);
      }
    }
  }

  return toolResults;
}

/**
 * Generate a session title from the first user message.
 */
function generateSessionTitle(message: string): string {
  // Clean and truncate
  let title = message
    .replace(/['"``]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Take first 50 chars
  if (title.length > 50) {
    title = title.substring(0, 47) + '...';
  }
  
  return title || 'New Conversation';
}

export const handleAgentChat = async (req: Request, res: Response) => {
  try {
    const { messages, model, directory, category, legacy, user_id, workspace_id, conversation_id } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
    }

    if (directory) {
      // Auto-trust any directory in global agent mode
      if (stateDb && fs.existsSync(path.resolve(String(directory)))) {
        const wsId = workspace_id || 'global:' + crypto.createHash('sha256').update(path.resolve(String(directory))).digest('hex').slice(0, 16);
        const uid = user_id || 'auto';
        try {
          const existing = stateDb.prepare('SELECT trusted FROM workspaces WHERE workspace_id = ? AND user_id = ? AND directory = ?').get(wsId, uid, path.resolve(String(directory))) as any;
          if (!existing || !existing.trusted) {
            upsertWorkspaceTrust(stateDb, {
              workspace_id: wsId,
              user_id: uid,
              directory: path.resolve(String(directory)),
              trusted: true,
            });
          }
        } catch { /* ignore */ }
      }

      const result = await ragService.setWorkingDirectory(directory, { autoInit: true });
      if (result.needsPermission) {
        return res.json({
          requiresPermission: true,
          message: ragService.requestPermissionMessage('scan'),
          directory,
        });
      }

      // ── Self-Healing: ensure SSOT exists for this directory ──
      // If SSOT is missing, create it automatically.
      // If files changed, rescan automatically.
      // The agent never works blind.
      if (!ragService.ssotExists()) {
        console.log(`[RAG] SSOT missing for ${directory}. Auto-creating...`);
        try {
          const scanResult = await ragService.scanProject();
          const template = ragService.generateSSOTTemplate(scanResult);
          ragService.saveSSOT(template);
          console.log(`[RAG] SSOT created for ${directory} (${scanResult.files.length} files)`);
        } catch (e: any) {
          console.warn(`[RAG] Auto-create SSOT failed:`, e?.message || e);
        }
      }

      if (vectorIndexService) {
        try {
          await vectorIndexService.indexDirectory(path.resolve(String(directory)), {
            workspaceId: workspace_id ? String(workspace_id) : undefined,
          });
        } catch (e: any) {
          console.warn('workspace index failed:', e?.message || e);
        }
      }
    }

    // ── TOOL EXECUTION: Prevent lying by using actual tools ──
    const lastUserMsg = String(messages[messages.length - 1]?.content || '');
    const toolResults = await executeToolsForQuestion(lastUserMsg);

    // Legacy agent JSON wrapper mode (kept for backward compatibility).
    if (legacy === true) {
      let selectedModel = model || undefined;
      if (mawlanaRouter && !model) {
        const route = await mawlanaRouter.route(messages, category);
        selectedModel = route.model;
      }
      const result = await agentService.processMessage(messages, selectedModel);
      return res.json(result);
    }

    // ── Non-legacy path: Unified Pipeline (Architecture: single pipeline) ──
    // Replaces: ResponseNormalizer + GroqService + manual RAG + manual Identity
    // Pipeline handles: Identity → RAG → Model Routing → AI SDK generateText/streamText
    const body: any = req.body || {};
    const resolvedConvoId = conversation_id && String(conversation_id).trim() ? String(conversation_id).trim() : null;

    // Persist conversation to DB (best-effort)
    if (stateDb && resolvedConvoId) {
      try {
        const firstUserMsg = messages.find((m: any) => m.role === 'user');
        const autoTitle = firstUserMsg?.content
          ? String(firstUserMsg.content).replace(/['"`]/g, '').replace(/\s+/g, ' ').trim().substring(0, 50)
          : undefined;
        ensureConversation(stateDb, {
          conversation_id: resolvedConvoId,
          workspace_id: workspace_id ? String(workspace_id) : undefined,
          user_id: user_id ? String(user_id) : undefined,
          title: autoTitle && autoTitle.length < 50 ? autoTitle : autoTitle ? autoTitle + '...' : undefined,
        });
        const lastUser = messages[messages.length - 1];
        if (lastUser?.role && typeof lastUser?.content === 'string') {
          addConversationMessage(stateDb, { conversation_id: resolvedConvoId, role: String(lastUser.role), content: String(lastUser.content) });
        }
      } catch (e: any) {
        console.warn('Conversation persist failed:', e?.message || e);
      }
    }

    // Streaming path — AI SDK streamText (no double model call)
    if (body.stream === true) {
      const streamResult = await runStreamingPipeline({
        messages,
        model: body.model,
        directory,
        workspaceId: workspace_id ? String(workspace_id) : undefined,
        conversationId: resolvedConvoId || undefined,
        category,
        temperature: body.temperature,
        maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
        enableRag: true,
      });

      res.setHeader('X-Conversation-Id', resolvedConvoId || '');
      res.setHeader('X-Model', streamResult.model);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let aborted = false;
      req.on('close', () => { aborted = true; });

      try {
        for await (const chunk of streamResult.stream) {
          if (aborted) break;
          // AI SDK textStream yields plain text chunks — wrap in SSE format
          const sseData = {
            id: streamResult.id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: streamResult.model,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(sseData)}\n\n`);
        }
      } catch (streamErr: any) {
        console.warn('Stream error:', streamErr?.message || streamErr);
      }

      if (!aborted) {
        // Final chunk with finish_reason
        const finalChunk = {
          id: streamResult.id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: streamResult.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
          }],
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return;
    }

    // Non-streaming path — AI SDK generateText (Provider Truth)
    const pipelineResult = await runPipeline({
      messages,
      model: body.model,
      directory,
      workspaceId: workspace_id ? String(workspace_id) : undefined,
      conversationId: resolvedConvoId || undefined,
      category,
      temperature: body.temperature,
      maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
      enableRag: true,
    });

    // Persist assistant response to conversation history
    if (stateDb && resolvedConvoId) {
      const assistant = pipelineResult.choices?.[0]?.message?.content;
      if (typeof assistant === 'string' && assistant.trim()) {
        addConversationMessage(stateDb, { conversation_id: resolvedConvoId, role: 'assistant', content: assistant });
      }
    }

    return res.json({
      ...pipelineResult,
      conversation_id: resolvedConvoId,
    });
  } catch (err: any) {
    console.error('❌ Agent error:', err.stack || err.message);
    res.status(err.status || 500).json({
      error: { message: err.message || 'Agent processing failed', type: 'server_error' },
    });
  }
};

export const handleCreateConversation = async (req: Request, res: Response) => {
  try {
    const { workspace_id, user_id, title, conversation_id } = req.body || {};
    if (!stateDb) {
      return res.status(500).json({ error: { message: 'state db not initialized', type: 'server_error' } });
    }

    const convoId = resolveConversationId(conversation_id);
    ensureConversation(stateDb, {
      conversation_id: convoId,
      workspace_id: workspace_id ? String(workspace_id) : undefined,
      user_id: user_id ? String(user_id) : undefined,
      title: title ? String(title) : undefined,
    });

    return res.status(201).json({ conversation_id: convoId });
  } catch (err: any) {
    return res.status(500).json({ error: { message: err.message || 'failed to create conversation', type: 'server_error' } });
  }
};

export const handleGetConversationHistory = async (req: Request, res: Response) => {
  try {
    const { conversation_id } = req.params;
    if (!stateDb || !conversation_id) {
      return res.status(400).json({ error: { message: 'conversation_id is required', type: 'invalid_request_error' } });
    }

    const convo = stateDb.prepare(`
      SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
      FROM conversations
      WHERE conversation_id = ?
      LIMIT 1
    `).get(String(conversation_id));

    if (!convo) {
      return res.status(404).json({ error: { message: 'conversation not found', type: 'not_found' } });
    }

    const messages = stateDb.prepare(`
      SELECT id, conversation_id, role, content, created_at
      FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY id ASC
    `).all(String(conversation_id));

    return res.json({ conversation: convo, messages });
  } catch (err: any) {
    return res.status(500).json({ error: { message: err.message || 'failed to fetch conversation', type: 'server_error' } });
  }
};

export const handleListConversations = async (req: Request, res: Response) => {
  try {
    if (!stateDb) {
      return res.status(500).json({ error: { message: 'state db not initialized', type: 'server_error' } });
    }
    const { workspace_id, limit } = req.query;
    const rows = workspace_id
      ? stateDb.prepare(`
          SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
          FROM conversations
          WHERE workspace_id = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(String(workspace_id), Math.max(1, Number(limit) || 50))
      : stateDb.prepare(`
          SELECT conversation_id, workspace_id, user_id, title, created_at, updated_at
          FROM conversations
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(Math.max(1, Number(limit) || 50));

    return res.json({ conversations: rows });
  } catch (err: any) {
    return res.status(500).json({ error: { message: err.message || 'failed to list conversations', type: 'server_error' } });
  }
};

export const handleIndexWorkspace = async (req: Request, res: Response) => {
  try {
    const { directory, workspace_id } = req.body || {};
    if (!directory) {
      return res.status(400).json({ error: { message: 'directory is required', type: 'invalid_request_error' } });
    }
    if (!vectorIndexService) {
      return res.status(500).json({ error: { message: 'vector index not initialized', type: 'server_error' } });
    }

    const result = await vectorIndexService.indexDirectory(path.resolve(String(directory)), {
      workspaceId: workspace_id ? String(workspace_id) : undefined,
    });

    return res.json({ ok: true, result, stats: vectorIndexService.getStats() });
  } catch (err: any) {
    return res.status(500).json({ error: { message: err.message || 'failed to index workspace', type: 'server_error' } });
  }
};

export const handleSearchWorkspace = async (req: Request, res: Response) => {
  try {
    const { query, workspace_id, limit } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: { message: 'query is required', type: 'invalid_request_error' } });
    }
    if (!vectorIndexService) {
      return res.status(500).json({ error: { message: 'vector index not initialized', type: 'server_error' } });
    }

    const result = await vectorIndexService.search(String(query), {
      workspaceId: workspace_id ? String(workspace_id) : undefined,
      limit: Number(limit) || 5,
    });

    return res.json({ ok: true, result, stats: vectorIndexService.getStats() });
  } catch (err: any) {
    return res.status(500).json({ error: { message: err.message || 'failed to search workspace', type: 'server_error' } });
  }
};

export const handleSetDirectory = async (req: Request, res: Response) => {
  try {
    const { directory, user_id, workspace_id } = req.body;
    if (!directory) {
      return res.status(400).json({ error: { message: 'directory is required', type: 'invalid_request_error' } });
    }
    const resolvedDir = path.resolve(String(directory));

    // Auto-trust any directory (global agent mode)
    if (stateDb && fs.existsSync(resolvedDir)) {
      const wsId = workspace_id || 'global:' + crypto.createHash('sha256').update(resolvedDir).digest('hex').slice(0, 16);
      const uid = user_id || 'auto';
      try {
        const existing = stateDb.prepare('SELECT trusted FROM workspaces WHERE workspace_id = ? AND user_id = ? AND directory = ?').get(wsId, uid, resolvedDir) as any;
        if (!existing || !existing.trusted) {
          upsertWorkspaceTrust(stateDb, {
            workspace_id: wsId,
            user_id: uid,
            directory: resolvedDir,
            trusted: true,
          });
          console.log(`[Agent] Auto-trusted directory: ${resolvedDir}`);
        }
      } catch (e: any) {
        console.warn('auto-trust failed:', e?.message || e);
      }
    }

    const trusted = true; // Always trust in global mode
    const result = await ragService.setWorkingDirectory(directory, { autoInit: trusted });

    if (result.needsPermission) {
      return res.json({
        requiresPermission: true,
        message: ragService.requestPermissionMessage('scan'),
        directory: resolvedDir,
        zombieDirExists: ragService.zombieDirExists(),
      });
    }

    // Auto-generate SSOT if it doesn't exist
    if (!ragService.ssotExists()) {
      try {
        const scan = await ragService.scanProject();
        const template = ragService.generateSSOTTemplate(scan);
        ragService.saveSSOT(template);
        console.log(`[Agent] Auto-generated SSOT for: ${resolvedDir}`);
      } catch (e: any) {
        console.warn('auto SSOT generation failed:', e?.message || e);
      }
    }

    // Start (or reuse) a watcher for auto SSOT refresh
    try {
      const wsId = workspace_id || 'global:' + crypto.createHash('sha256').update(resolvedDir).digest('hex').slice(0, 16);
      const key = `${wsId}:${resolvedDir}`;
      if (!workspaceWatchers.has(key)) {
        workspaceWatchers.set(key, startWorkspaceWatcher({
          directory: resolvedDir,
          rag: ragService,
          index: vectorIndexService,
          workspaceId: wsId,
        }));
      }
    } catch (e: any) {
      console.warn('watcher start failed:', e?.message || e);
    }

    return res.json({
      ok: true,
      directory: resolvedDir,
      ssotExists: ragService.ssotExists(),
      message: 'Directory ready. Agent can work.',
    });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
};

export const handleGrantPermission = async (req: Request, res: Response) => {
  try {
    const { grant, scope, user_id, workspace_id, directory } = req.body;
    if (!grant) {
      return res.json({ ok: false, message: 'Permission not granted.' });
    }
    ragService.grantPermission(scope || 'scan');

    // If the caller provides user/workspace context, mark the workspace as trusted for this directory.
    try {
      if (stateDb && user_id && workspace_id && directory) {
        upsertWorkspaceTrust(stateDb, {
          workspace_id: String(workspace_id),
          user_id: String(user_id),
          directory: path.resolve(String(directory)),
          trusted: true,
        });
      }
    } catch (e: any) {
      console.warn('workspace trust update failed:', e?.message || e);
    }

    if (scope === 'scan' && !ragService.ssotExists()) {
      const scanResult = await ragService.scanProject();
      const template = ragService.generateSSOTTemplate(scanResult);
      ragService.saveSSOT(template);

      return res.json({
        ok: true,
        message: 'Permission granted. Project scanned. SSOT.md created.',
        ssotPath: path.join(ragService.currentDir, '.zombiecoder', 'SSOT.md'),
        fileCount: scanResult.files.length,
      });
    }

    res.json({ ok: true, message: `Permission granted for: ${scope}` });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
};

export const handleProjectStatus = async (req: Request, res: Response) => {
  try {
    res.json({
      hasWorkingDir: ragService.hasWorkingDir,
      workingDir: ragService.currentDir || null,
      zombieDirExists: ragService.zombieDirExists(),
      ssotExists: ragService.ssotExists(),
      hasScanPermission: ragService.hasPermission('scan'),
      hasWritePermission: ragService.hasPermission('write'),
      persona: agentService?.getPersonaName() || 'none',
    });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
};

export const handleRescan = async (req: Request, res: Response) => {
  try {
    if (!ragService.hasPermission('scan')) {
      return res.status(403).json({ error: { message: 'No scan permission. Grant permission first.', type: 'permission_error' } });
    }
    const scanResult = await ragService.scanProject();
    const template = ragService.generateSSOTTemplate(scanResult);
    ragService.saveSSOT(template);
    if (vectorIndexService) {
      try {
        const workspaceRow = stateDb && ragService.currentDir
          ? stateDb.prepare(`
              SELECT workspace_id
              FROM workspaces
              WHERE directory = ?
              ORDER BY updated_at DESC
              LIMIT 1
            `).get(path.resolve(ragService.currentDir))
          : null;
        await vectorIndexService.indexDirectory(ragService.currentDir || process.cwd(), {
          workspaceId: workspaceRow?.workspace_id ? String(workspaceRow.workspace_id) : undefined,
        });
      } catch (e: any) {
        console.warn('rescan index failed:', e?.message || e);
      }
    }
    res.json({ ok: true, message: 'Project rescanned and SSOT.md updated.', fileCount: scanResult.files.length });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
};

export const handleReadSSOT = async (req: Request, res: Response) => {
  try {
    const content = ragService.readSSOT();
    if (!content) {
      return res.status(404).json({ error: { message: 'SSOT.md not found. Scan project first.', type: 'not_found' } });
    }
    res.set('Content-Type', 'text/markdown');
    res.send(content);
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
};

export const handleAgentRoutes = async (req: Request, res: Response) => {
  const routes = mawlanaRouter?.getAllRoutes() || {};
  res.json({ routes, persona: agentService?.getPersonaName() || 'ZombieCoder' });
};

// ── LangChain Agent Endpoint ──────────────────────────────────
export const handleLangChainAgent = async (req: Request, res: Response) => {
  try {
    const { messages, session_id, model, system_prompt, stream } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
    }

    const sessionId = session_id || crypto.randomUUID();

    // Get identity system prompt
    let systemPrompt = system_prompt;
    if (!systemPrompt) {
      try {
        const identity = getIdentity();
        systemPrompt = identity?.system_identity?.system_prompt || 'You are ZombieCoder, a local-first AI assistant.';
      } catch {
        systemPrompt = 'You are ZombieCoder, a local-first AI assistant.';
      }
    }

    console.log(`🤖 LangChain agent: session=${sessionId}, messages=${messages.length}, model=${model || 'auto'}, tools=MCP`);

    const result = await runLangChainAgent({
      messages,
      sessionId,
      systemPrompt,
      modelName: model,
    });

    console.log(`✅ LangChain agent: tools=[${result.toolCalls.join(', ')}], model=${result.model}`);

    // Return OpenAI-compatible response
    // Architecture: reasoning content is PRESERVED in metadata (NEVER dropped)
    const response: any = {
      id: crypto.randomUUID(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.response },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      conversation_id: result.conversationId,
      tool_calls: result.toolCalls,
    };

    // Preserve reasoning content (architecture requirement)
    if (result.reasoning) {
      response.reasoning = result.reasoning;
    }

    res.json(response);
  } catch (err: any) {
    console.error('LangChain agent error:', err);
    res.status(500).json({ error: { message: err.message || 'Agent failed', type: 'server_error' } });
  }
};

// ── Memory Management ─────────────────────────────────────────
export const handleClearMemory = async (req: Request, res: Response) => {
  const { session_id } = req.body || {};
  if (session_id) {
    clearSessionMemory(session_id);
    res.json({ success: true, message: `Memory cleared for session ${session_id}` });
  } else {
    res.status(400).json({ error: { message: 'session_id required', type: 'invalid_request_error' } });
  }
};

export const handleMemoryStats = async (req: Request, res: Response) => {
  res.json(getMemoryStats());
};

// ── Client Registration (editors register their root directory) ──────────
import {
  registerClient,
  disconnectClient,
  getAllClients,
  getActiveClients,
  getClientStats,
  findRootDirectory,
} from '../services/clientTracker';

export const handleRegisterEditor = async (req: Request, res: Response) => {
  const { directory, clientName, source, capabilities } = req.body || {};
  if (!directory) {
    return res.status(400).json({ error: { message: 'directory is required', type: 'invalid_request_error' } });
  }

  const clientId = req.get('X-Client-Id') || req.get('mcp-session-id') || crypto.randomUUID();

  const client = registerClient({
    clientId,
    rootDirectory: directory,
    clientName: clientName || req.get('User-Agent') || 'unknown',
    userAgent: req.get('User-Agent'),
    source: source || 'http-register',
    capabilities,
  });

  // Also set the RAG working directory to this editor's directory
  try {
    if (ragService) {
      const resolvedDir = path.resolve(directory);
      if (ragService.currentDir !== resolvedDir) {
        await ragService.setWorkingDirectory(resolvedDir, { autoInit: true });
        console.log(`📁 RAG working directory set to: ${resolvedDir}`);
      }
    }
  } catch (e: any) {
    console.warn('Failed to set RAG directory from editor registration:', e?.message);
  }

  res.json({
    ok: true,
    clientId: client.clientId,
    rootDirectory: client.rootDirectory,
    editorType: client.editorType,
    message: `Editor registered: ${client.editorType} @ ${client.rootDirectory}`,
  });
};

export const handleClientStats = async (req: Request, res: Response) => {
  const stats = getClientStats();
  const clients = getAllClients();
  res.json({
    ok: true,
    ...stats,
    clients: clients.map(c => ({
      clientId: c.clientId,
      editorType: c.editorType,
      rootDirectory: c.rootDirectory,
      status: c.status,
      connectedAt: new Date(c.connectedAt).toISOString(),
      lastActiveAt: new Date(c.lastActiveAt).toISOString(),
      ssotGenerated: c.ssotGenerated,
      flag: c.flag,
    })),
    rootDirectory: findRootDirectory(),
  });
};

export const handleDisconnectEditor = async (req: Request, res: Response) => {
  const clientId = req.params.clientId || req.get('X-Client-Id') || '';
  if (!clientId) {
    return res.status(400).json({ error: { message: 'clientId is required', type: 'invalid_request_error' } });
  }
  disconnectClient(clientId);
  res.json({ ok: true, message: `Client ${clientId} disconnected` });
};
