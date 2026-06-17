/**
 * WebSocket Server — Real-time Streaming for Admin Panel
 * 
 * Provides:
 * - SSE endpoint for browser clients
 * - WebSocket for bidirectional communication
 * - Health check polling for all services
 * - Event broadcasting to all connected clients
 * 
 * Port: 3333
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3333;
const SERVICES_FILE = path.join(__dirname, '..', '..', 'transport', 'services.json');

// ── Service Health Checker ──────────────────────────────────

interface ServiceStatus {
  name: string;
  port: number;
  domain: string;
  status: 'running' | 'stopped' | 'error';
  latency: number;
  lastCheck: string;
}

const serviceStatuses = new Map<string, ServiceStatus>();

async function checkServiceHealth(service: any): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const res = await fetch(service.health, { signal: AbortSignal.timeout(3000) });
    const latency = Date.now() - start;
    return {
      name: service.name,
      port: service.port,
      domain: service.domain,
      status: res.ok ? 'running' : 'error',
      latency,
      lastCheck: new Date().toISOString(),
    };
  } catch {
    return {
      name: service.name,
      port: service.port,
      domain: service.domain,
      status: 'stopped',
      latency: -1,
      lastCheck: new Date().toISOString(),
    };
  }
}

async function checkAllServices(): Promise<ServiceStatus[]> {
  let services: any[] = [];
  try {
    const data = fs.readFileSync(SERVICES_FILE, 'utf-8');
    services = JSON.parse(data).services || [];
  } catch {
    return [];
  }

  const results = await Promise.all(services.map(checkServiceHealth));
  for (const r of results) {
    serviceStatuses.set(r.name, r);
  }
  return results;
}

// ── SSE Clients ─────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcastSSE(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  Array.from(sseClients).forEach(client => {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  });
}

// ── HTTP Server ─────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Health check endpoint
  if (url.pathname === '/health') {
    const statuses = await checkAllServices();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', services: statuses, timestamp: new Date().toISOString() }));
    return;
  }

  // SSE stream
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'WebSocket server connected' })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Service list
  if (url.pathname === '/services') {
    try {
      const data = fs.readFileSync(SERVICES_FILE, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'services.json not found' }));
    }
    return;
  }

  // Status dashboard HTML
  if (url.pathname === '/' || url.pathname === '/status') {
    // status.html is in transport/ folder, not dist/transport/
    const htmlPath = path.join(__dirname, '..', '..', 'transport', 'status.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('status.html not found at: ' + htmlPath);
    }
    return;
  }

  // Tunnel config
  if (url.pathname === '/tunnel') {
    try {
      const data = fs.readFileSync(SERVICES_FILE, 'utf-8');
      const config = JSON.parse(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config.tunnel));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tunnel config not found' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Periodic Health Check ───────────────────────────────────

setInterval(async () => {
  const statuses = await checkAllServices();
  broadcastSSE('health', statuses);
}, 10000); // Every 10 seconds

// ── Start ───────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🌐 WebSocket Server running on http://localhost:${PORT}`);
  console.log(`   SSE: http://localhost:${PORT}/events`);
  console.log(`   Status: http://localhost:${PORT}/status`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  
  // Initial health check
  checkAllServices().then(statuses => {
    console.log(`   Services: ${statuses.length} checked`);
    for (const s of statuses) {
      console.log(`   - ${s.name}: ${s.status} (${s.latency}ms)`);
    }
  });
});

export { server };
