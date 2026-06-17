/**
 * Streaming Adapter Server — ZombieCoder
 * 
 * Provides:
 * - SSE streaming for chat (first chunk immediately)
 * - Session-based conversations (DB persistence)
 * - Browser polling for connection status
 * - Editor content-type headers
 * - Real-time streaming to admin panel
 * 
 * Port: 3333 (same as ws-server, replaces it)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Lazy imports to avoid crash on startup
let callMcpTool: any = null;
let isMcpConnected: any = null;
let runLangChainAgent: any = null;
let runStreamingPipeline: any = null;

async function loadDeps() {
  if (!callMcpTool) {
    try {
      const mcp = await import('../mcp/client');
      callMcpTool = mcp.callMcpTool;
      isMcpConnected = mcp.isMcpConnected;
    } catch { /* MCP not available */ }
  }
  if (!runStreamingPipeline) {
    try {
      const pipeline = await import('../services/unifiedPipeline');
      runStreamingPipeline = pipeline.runStreamingPipeline;
    } catch { /* LangChain not available */ }
  }
  if (!runLangChainAgent) {
    try {
      const lc = await import('../services/langchainAgent');
      runLangChainAgent = lc.runLangChainAgent;
    } catch { /* LangChain not available */ }
  }
}

const PORT = parseInt(process.env.ADAPTER_PORT || '3333');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// ── Session Store (in-memory + DB) ──────────────────────────

interface Session {
  id: string;
  userId: string;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  createdAt: number;
  lastActive: number;
  metadata: Record<string, any>;
}

const sessions = new Map<string, Session>();

function getOrCreateSession(sessionId: string, userId?: string): Session {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      userId: userId || 'anonymous',
      messages: [],
      createdAt: Date.now(),
      lastActive: Date.now(),
      metadata: {},
    });
  }
  const session = sessions.get(sessionId)!;
  session.lastActive = Date.now();
  return session;
}

function saveSessionToStorage(session: Session) {
  // Save to localStorage-compatible format
  const key = `zombiedev_session_${session.id}`;
  const data = JSON.stringify({
    ...session,
    savedAt: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
  });
  
  // Save to file for persistence
  const sessionsDir = path.join(PROJECT_ROOT, '.zombiecoder', 'sessions');
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${session.id}.json`), data);
  } catch (e) {
    console.warn('Failed to save session:', e);
  }
}

// ── SSE Clients ─────────────────────────────────────────────

const sseClients = new Map<string, http.ServerResponse>();

function broadcastSSE(event: string, data: any, clientId?: string) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  
  if (clientId) {
    const client = sseClients.get(clientId);
    if (client) {
      try { client.write(payload); } catch { sseClients.delete(clientId); }
    }
  } else {
    Array.from(sseClients.entries()).forEach(([id, client]) => {
      try { client.write(payload); } catch { sseClients.delete(id); }
    });
  }
}

// ── Service Health Check ────────────────────────────────────

async function checkHealth(): Promise<Record<string, any>> {
  const services = [
    { name: 'proxi-api', port: 9999, url: 'http://localhost:9999/v1/models' },
    { name: 'admin', port: 3001, url: 'http://localhost:3001' },
  ];

  const results: Record<string, any> = {};
  
  for (const svc of services) {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(svc.url, { signal: controller.signal });
      clearTimeout(timeout);
      results[svc.name] = {
        status: res.ok ? 'running' : 'error',
        port: svc.port,
        latency: Date.now() - start,
      };
    } catch {
      results[svc.name] = { status: 'stopped', port: svc.port, latency: -1 };
    }
  }
  
  return results;
}

// ── Chat Streaming Handler ──────────────────────────────────

async function handleChatStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any
) {
  await loadDeps();
  
  const { messages, session_id, model } = body;
  const sessionId = session_id || crypto.randomUUID();
  const session = getOrCreateSession(sessionId);

  // Save user message to session
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    session.messages.push({
      role: lastMsg.role,
      content: lastMsg.content,
      timestamp: Date.now(),
    });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders?.();
  res.socket?.setNoDelay(true);

  // Send first chunk immediately (connection confirmed)
  res.write(`event: connected\ndata: ${JSON.stringify({ session_id: sessionId, status: 'streaming' })}\n\n`);

  try {
    // Use the unified streaming pipeline so chunks appear as they are produced.
    const result = await runStreamingPipeline({
      messages,
      sessionId,
      conversationId: sessionId,
      model,
      directory: PROJECT_ROOT,
      enableTools: true,
      enableRag: true,
    });

    // Send response chunks as they arrive.
    let reply = '';
    for await (const chunk of result.stream) {
      const text = typeof chunk === 'string'
        ? chunk
        : String(chunk?.text || chunk?.delta || chunk?.content || '');
      if (!text) continue;
      reply += text;
      res.write(`event: chunk\ndata: ${JSON.stringify({ content: text })}\n\n`);
    }

    // Save assistant message to session
    session.messages.push({
      role: 'assistant',
      content: reply,
      timestamp: Date.now(),
    });

    // Save session
    saveSessionToStorage(session);

    // Send completion
    res.write(`event: done\ndata: ${JSON.stringify({
      session_id: sessionId,
      model: result.model,
      tool_calls: [],
      message_count: session.messages.length,
    })}\n\n`);

  } catch (err: any) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  }

  res.end();
}

// ── HTTP Server ─────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-ID');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // ── GET Routes ──

  if (req.method === 'GET') {
    // Health check
    if (url.pathname === '/health') {
      const health = await checkHealth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', services: health, timestamp: new Date().toISOString() }));
      return;
    }

    // SSE stream
    if (url.pathname === '/events') {
      const clientId = crypto.randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ client_id: clientId })}\n\n`);
      sseClients.set(clientId, res);
      req.on('close', () => sseClients.delete(clientId));
      return;
    }

    // Session list
    if (url.pathname === '/sessions') {
      const sessionList = Array.from(sessions.values()).map(s => ({
        id: s.id,
        userId: s.userId,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        lastActive: s.lastActive,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: sessionList }));
      return;
    }

    // Session detail
    if (url.pathname.startsWith('/sessions/')) {
      const sessionId = url.pathname.split('/')[2];
      const session = sessions.get(sessionId);
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
      return;
    }

    // Status dashboard
    if (url.pathname === '/' || url.pathname === '/status') {
      const htmlPath = path.join(PROJECT_ROOT, 'transport', 'status.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('status.html not found');
      }
      return;
    }

    // Services config
    if (url.pathname === '/services') {
      const configPath = path.join(PROJECT_ROOT, 'transport', 'services.json');
      try {
        const data = fs.readFileSync(configPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'services.json not found' }));
      }
      return;
    }

    // Tunnel config
    if (url.pathname === '/tunnel') {
      const configPath = path.join(PROJECT_ROOT, 'transport', 'services.json');
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data.tunnel));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tunnel config not found' }));
      }
      return;
    }
  }

  // ── POST Routes ──

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);

        // Chat streaming
        if (url.pathname === '/chat') {
          await handleChatStream(req, res, parsed);
          return;
        }

        // Chat non-streaming
        if (url.pathname === '/chat/sync') {
          await loadDeps();
          const { messages, session_id, model } = parsed;
          const sessionId = session_id || crypto.randomUUID();
          const session = getOrCreateSession(sessionId);

          const result = await runLangChainAgent({
            messages,
            sessionId,
            modelName: model,
          });

          // Save messages
          const lastMsg = messages[messages.length - 1];
          if (lastMsg) {
            session.messages.push({ role: lastMsg.role, content: lastMsg.content, timestamp: Date.now() });
          }
          session.messages.push({ role: 'assistant', content: result.response, timestamp: Date.now() });
          saveSessionToStorage(session);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: crypto.randomUUID(),
            object: 'chat.completion',
            model: result.model,
            choices: [{ index: 0, message: { role: 'assistant', content: result.response }, finish_reason: 'stop' }],
            conversation_id: sessionId,
            tool_calls: result.toolCalls,
          }));
          return;
        }

        // MCP tool call
        if (url.pathname === '/tool') {
          const { tool, args } = parsed;
          const result = await callMcpTool(tool, args || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // Clear session
        if (url.pathname === '/session/clear') {
          const { session_id } = parsed;
          sessions.delete(session_id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Periodic Health Broadcast ───────────────────────────────

setInterval(async () => {
  const health = await checkHealth();
  broadcastSSE('health', { services: health, timestamp: new Date().toISOString() });
}, 10000);

// ── Start ───────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🌐 Adapter Server running on http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/status`);
  console.log(`   Chat API:  http://localhost:${PORT}/chat`);
  console.log(`   SSE:       http://localhost:${PORT}/events`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log(`   Sessions:  http://localhost:${PORT}/sessions`);
});

export { server };
