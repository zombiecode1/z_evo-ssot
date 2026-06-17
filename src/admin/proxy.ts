/**
 * Admin Panel Proxy
 * Starts Next.js admin panel as child process and proxies /admin/* requests to it.
 * This allows single-port operation — all API + admin panel on the same port.
 */
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import net from 'net';

let nextProcess: ChildProcess | null = null;
let adminPort = 0;

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = async () => {
      try {
        const res = await fetch(url);
        if (res.ok || res.status === 404) {
          resolve();
          return;
        }
      } catch {
        // Server not ready yet
      }
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Admin server did not start within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

export async function startAdminPanel(): Promise<{ port: number; proxy: RequestHandler }> {
  const adminDir = path.resolve(__dirname, '../../test/documentation/admin');

  // Find a free port for Next.js
  adminPort = await findAvailablePort();
  console.log(`  Admin panel target port: ${adminPort}`);

  // Start Next.js dev server as child process
  nextProcess = spawn('npx', ['next', 'dev', '--port', String(adminPort), '--hostname', '127.0.0.1'], {
    cwd: adminDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(adminPort),
      NEXT_PUBLIC_ADMIN_API_URL: '',  // Will use relative URLs since proxied from same origin
    },
  });

  // Pipe stdout/stderr with prefix
  nextProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => console.log(`  [admin] ${line}`));
  });

  nextProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => console.error(`  [admin] ${line}`));
  });

  nextProcess.on('exit', (code) => {
    console.log(`  [admin] Next.js exited with code ${code}`);
    nextProcess = null;
  });

  // Wait for Next.js to be ready
  try {
    await waitForServer(`http://127.0.0.1:${adminPort}`);
    console.log(`  ✅ Admin panel ready on port ${adminPort}`);
  } catch (err: any) {
    console.warn(`  ⚠️ Admin panel may not be ready: ${err.message}`);
  }

  // Create proxy middleware
  // No pathFilter — we handle path matching in the wrapper middleware
  const proxyMiddleware = createProxyMiddleware({
    target: `http://127.0.0.1:${adminPort}`,
    changeOrigin: true,
    ws: true,
  });

  // Wrapper: proxy admin pages + Next.js static assets, pass through everything else
  const proxy: any = (req: any, res: any, next: any) => {
    const p = req.path;
    // Forward admin pages AND Next.js internal assets (CSS, JS, fonts, HMR)
    if (
      p.startsWith('/admin') ||
      p.startsWith('/_next') ||
      p.startsWith('/icon') ||
      p.startsWith('/favicon')
    ) {
      return proxyMiddleware(req, res, next);
    }
    next();
  };
  // Copy upgrade handler for WebSocket support
  proxy.upgrade = (proxyMiddleware as any).upgrade;

  return { port: adminPort, proxy };
}

export function stopAdminPanel(): void {
  if (nextProcess) {
    console.log('  [admin] Stopping Next.js admin panel...');
    nextProcess.kill('SIGTERM');
    nextProcess = null;
  }
}

export function getAdminPort(): number {
  return adminPort;
}
