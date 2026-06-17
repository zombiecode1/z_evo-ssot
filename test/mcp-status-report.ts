import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

type Json = Record<string, any>;

const BASE_URL = process.env.BASE_URL || 'http://localhost:9999';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = path.resolve(PROJECT_ROOT, 'test', 'mcp-status-report.json');
const DB_PATH = path.resolve(PROJECT_ROOT, '.zombiecoder', 'state.db');
const DOC_DIR = path.resolve(PROJECT_ROOT, 'documentation', 'agent-proof');
const DOC_PATH = path.join(DOC_DIR, 'report-bn.md');
const DOC_JSON_PATH = path.join(DOC_DIR, 'report.json');

async function requestJson(url: string, init?: any) {
  const headers = {
    'content-type': 'application/json',
    ...(init?.headers || {}),
  };
  const { headers: _ignoredHeaders, ...rest } = init || {};
  const res = await fetch(`${BASE_URL}${url}`, {
    ...rest,
    headers,
  } as any);
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), data };
}

async function requestText(url: string, init?: any) {
  const res = await fetch(`${BASE_URL}${url}`, init as any);
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: await res.text() };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRepoProofReindex(timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await requestJson('/api/events');
    const list = events.data?.events || [];
    const hit = list.find((item: any) =>
      item?.category === 'workspace' &&
      item?.workspaceId === 'repo-proof' &&
      item?.event === 'watcher_reindex_completed'
    );
    if (hit) {
      return { found: true, event: hit, count: list.length };
    }
    await sleep(1000);
  }
  return { found: false, event: null, count: 0 };
}

async function initializeClient(name: string, version: string) {
  const init = await requestJson('/mcp', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-init`,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name, version },
      },
    }),
  });
  const sessionId = init.headers['mcp-session-id'] || init.headers['Mcp-Session-Id'];
  const initialized = await requestJson('/mcp', {
    method: 'POST',
    headers: sessionId ? { 'mcp-session-id': sessionId } : {},
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });
  const logLevel = await requestJson('/mcp', {
    method: 'POST',
    headers: sessionId ? { 'mcp-session-id': sessionId } : {},
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-log-level`,
      method: 'logging/setLevel',
      params: { level: 'info' },
    }),
  });

  return {
    name,
    version,
    sessionId,
    init,
    initialized,
    logLevel,
  };
}

async function streamChatProof() {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Reply with ok only.' }],
      stream: true,
      max_tokens: 16,
    }),
  } as any);

  const reader = (res as any).body?.getReader?.();
  const decoder = new TextDecoder();
  let buf = '';
  let firstChunk = '';
  let doneSeen = false;

  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n');
      while (idx !== -1) {
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          if (!firstChunk && payload !== '[DONE]') firstChunk = payload;
          if (payload === '[DONE]') doneSeen = true;
        }
        idx = buf.indexOf('\n');
      }
      if (doneSeen) break;
    }
  } else {
    const text = await res.text();
    doneSeen = text.includes('data: [DONE]');
    firstChunk = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) || '';
  }

  return {
    status: res.status,
    doneSeen,
    firstChunk: firstChunk ? firstChunk.slice(0, 180) : '',
  };
}

async function generateAgentDocumentation(reportSeed: Json) {
  const prompt = [
    'You are helping create project documentation in Bengali.',
    'Summarize the current server capabilities, MCP client session flow, auto indexing, conversation persistence, SSOT update, and event logging.',
    'Return a concise but useful Bengali explanation for a documentation file.',
    'Do not include code blocks.',
  ].join(' ');

  const agentResponse = await requestJson('/v1/agent/chat', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: 'documentation-proof',
      user_id: 'doc-writer',
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const content = agentResponse.data?.choices?.[0]?.message?.content
    || agentResponse.data?.content
    || agentResponse.data?.choices?.[0]?.text
    || '';

  const now = new Date().toISOString();
  const signature = crypto.createHash('sha256').update([
    now,
    String(agentResponse.data?.conversation_id || ''),
    String(content),
    JSON.stringify(reportSeed?.summary || {}),
  ].join('\n')).digest('hex');
  await fs.promises.mkdir(DOC_DIR, { recursive: true });
  const doc = [
    '# Agent Activity Report',
    '',
    `- Generated at: ${now}`,
    `- Signature: ${signature}`,
    `- Source report: ${REPORT_PATH}`,
    `- Conversation ID: ${agentResponse.data?.conversation_id || 'n/a'}`,
    `- Runtime status: ${agentResponse.status}`,
    '',
    '## Agent Output',
    '',
    content ? content : 'Agent returned no text content.',
    '',
    '## Collected Proof',
    '',
    `- Active MCP clients: ${reportSeed?.summary?.clientCount ?? 0}`,
    `- Initialized MCP clients: ${reportSeed?.summary?.initializedClientCount ?? 0}`,
    `- Indexed documents: ${reportSeed?.summary?.indexedDocuments ?? 0}`,
    `- Indexed chunks: ${reportSeed?.summary?.indexedChunks ?? 0}`,
    `- Recent events: ${reportSeed?.summary?.recentEvents ?? 0}`,
    '',
  ].join('\n');

  const json = {
    generatedAt: now,
    signature,
    agentResponseStatus: agentResponse.status,
    conversationId: agentResponse.data?.conversation_id || null,
    response: content,
    sourceReport: REPORT_PATH,
  };

  await fs.promises.writeFile(DOC_PATH, doc, 'utf8');
  await fs.promises.writeFile(DOC_JSON_PATH, JSON.stringify(json, null, 2), 'utf8');

  return {
    status: agentResponse.status,
    conversationId: agentResponse.data?.conversation_id || null,
    response: content,
    docPath: DOC_PATH,
    jsonPath: DOC_JSON_PATH,
    responseLength: String(content).length,
  };
}

function readDbCounts() {
  if (!fs.existsSync(DB_PATH)) {
    return { exists: false };
  }

  const db = new Database(DB_PATH, { readonly: true });
  const queries = {
    conversations: db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count,
    conversation_messages: db.prepare('SELECT COUNT(*) AS count FROM conversation_messages').get().count,
    rag_documents: db.prepare('SELECT COUNT(*) AS count FROM rag_documents').get().count,
    rag_chunks: db.prepare('SELECT COUNT(*) AS count FROM rag_chunks').get().count,
  };
  db.close();
  return { exists: true, ...queries };
}

async function main() {
  const report: Json = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    os: {
      platform: os.platform(),
      release: os.release(),
      hostname: os.hostname(),
    },
  };

  const initialMcp = await requestJson('/mcp');
  report.initialMcp = initialMcp.data;

  const clients = [
    await initializeClient('VS Code', '1.0.0'),
    await initializeClient('JetBrains', '1.0.0'),
  ];
  report.clients = clients;

  const mcpStatusAfterClients = await requestJson('/mcp');
  report.mcpStatusAfterClients = mcpStatusAfterClients.data;

  const toolsList = await requestJson('/mcp', {
    method: 'POST',
    headers: clients[0].sessionId ? { 'mcp-session-id': clients[0].sessionId } : {},
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'tools-list',
      method: 'tools/list',
    }),
  });
  report.toolsList = {
    status: toolsList.status,
    count: toolsList.data?.result?.tools?.length || 0,
    names: (toolsList.data?.result?.tools || []).map((tool: any) => tool.name),
  };

  const resourcesList = await requestJson('/mcp', {
    method: 'POST',
    headers: clients[0].sessionId ? { 'mcp-session-id': clients[0].sessionId } : {},
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'resources-list',
      method: 'resources/list',
    }),
  });
  report.resourcesList = {
    status: resourcesList.status,
    count: resourcesList.data?.result?.resources?.length || 0,
    names: (resourcesList.data?.result?.resources || []).map((resource: any) => resource.name),
  };

  const workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'proxi-mcp-report-'));
  const workspaceFile = path.join(workspaceDir, 'notes.md');
  await fs.promises.writeFile(workspaceFile, 'Initial content about memory and retrieval.');

  const workspaceId = `ws-report-${Date.now()}`;
  const userId = 'report-user';

  const permission = await requestJson('/v1/agent/permission', {
    method: 'POST',
    body: JSON.stringify({
      grant: true,
      scope: 'scan',
      user_id: userId,
      workspace_id: workspaceId,
      directory: workspaceDir,
    }),
  });
  const setDirectory = await requestJson('/v1/agent/directory', {
    method: 'POST',
    body: JSON.stringify({
      directory: workspaceDir,
      user_id: userId,
      workspace_id: workspaceId,
    }),
  });

  await sleep(2000);
  await fs.promises.writeFile(workspaceFile, 'Updated content about vector index, status events, and MCP sessions.');
  await sleep(5000);

  const indexSearch = await requestJson('/v1/agent/search', {
    method: 'POST',
    body: JSON.stringify({
      query: 'vector index status events MCP sessions',
      workspace_id: workspaceId,
      limit: 5,
    }),
  });

  const manualIndex = await requestJson('/v1/agent/index', {
    method: 'POST',
    body: JSON.stringify({
      directory: workspaceDir,
      workspace_id: workspaceId,
    }),
  });

  const conversationCreate = await requestJson('/v1/agent/conversations', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      user_id: userId,
      title: 'status-report',
    }),
  });

  const conversationId = conversationCreate.data?.conversation_id;
  const chat = await requestJson('/v1/agent/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: conversationId,
      workspace_id: workspaceId,
      user_id: userId,
      model: 'auto',
      messages: [{ role: 'user', content: 'Reply with exactly: acknowledged' }],
    }),
  });
  const conversationHistory = conversationId
    ? await requestJson(`/v1/agent/conversations/${conversationId}`)
    : { status: 0, data: null };

  const stream = await streamChatProof();

  const mcpStatusAfterWork = await requestJson('/mcp');
  const events = await requestJson('/api/events');
  const dashboard = await requestText('/dashboard');
  const dbCounts = readDbCounts();

  report.workspace = {
    workspaceId,
    directory: workspaceDir,
    permission: permission.data,
    setDirectory: setDirectory.data,
    manualIndex: manualIndex.data,
    search: indexSearch.data,
  };
  report.conversation = {
    create: conversationCreate.data,
    chatStatus: chat.status,
    chatConversationId: chat.data?.conversation_id,
    historyStatus: conversationHistory.status,
    historyCount: conversationHistory.data?.messages?.length || 0,
  };
  report.stream = stream;
  report.dbCounts = dbCounts;
  report.dashboard = {
    status: dashboard.status,
    hasResponseModelIndicator: dashboard.text.includes('model'),
    size: dashboard.text.length,
  };
  report.events = {
    status: events.status,
    count: events.data?.events?.length || 0,
    recent: (events.data?.events || []).slice(-10),
  };
  report.mcpStatusAfterWork = mcpStatusAfterWork.data;
  report.summary = {
    clientCount: mcpStatusAfterWork.data?.status?.mcp?.activeSessions || 0,
    initializedClientCount: mcpStatusAfterWork.data?.status?.mcp?.initializedSessions || 0,
    indexedDocuments: mcpStatusAfterWork.data?.status?.index?.documents || 0,
    indexedChunks: mcpStatusAfterWork.data?.status?.index?.chunks || 0,
    recentEvents: mcpStatusAfterWork.data?.status?.mcp?.recentEvents?.length || 0,
  };

  const documentation = await generateAgentDocumentation(report);
  const repoPermission = await requestJson('/v1/agent/permission', {
    method: 'POST',
    body: JSON.stringify({
      grant: true,
      scope: 'scan',
      user_id: 'doc-writer',
      workspace_id: 'repo-proof',
      directory: process.cwd(),
    }),
  });
  const repoDirectory = await requestJson('/v1/agent/directory', {
    method: 'POST',
    body: JSON.stringify({
      directory: process.cwd(),
      user_id: 'doc-writer',
      workspace_id: 'repo-proof',
    }),
  });
  const repoReindex = await waitForRepoProofReindex();
  const ssotText = await fs.promises.readFile(path.resolve(process.cwd(), '.zombiecoder', 'SSOT.md'), 'utf8');

  report.documentation = documentation;
  report.repoPermission = repoPermission.data;
  report.repoDirectory = repoDirectory.data;
  report.repoReindex = repoReindex;
  report.ssot = {
    status: 200,
    containsAgentProof: ssotText.includes('documentation/agent-proof/report-bn.md') || ssotText.includes('agent-proof'),
    containsLatestDoc: ssotText.includes('Agent Activity Report'),
    size: ssotText.length,
  };
  report.summary.documentationWritten = true;
  report.summary.ssotUpdated = report.ssot.containsAgentProof || report.ssot.containsLatestDoc;

  report.events = {
    status: events.status,
    count: events.data?.events?.length || 0,
    recent: (events.data?.events || []).slice(-10),
  };
  await fs.promises.writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
