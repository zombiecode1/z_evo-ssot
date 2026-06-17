import * as fs from 'fs';
import * as path from 'path';
import { LogEntry } from '../types';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const fsp = fs.promises;

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `runtime-${date}.log`);
}

/** Non-blocking log write — fire-and-forget in the background. */
export function writeLog(entry: LogEntry): void {
  try {
    ensureLogDir();
    const line = JSON.stringify(entry) + '\n';
    fsp.appendFile(getLogFilePath(), line, 'utf-8').catch(err => {
      console.error('Failed to write log file:', err);
    });
  } catch (err) {
    console.error('Failed to write log file:', err);
  }
}

export async function getRecentLogs(limit: number = 200): Promise<LogEntry[]> {
  try {
    ensureLogDir();
    const allFiles = await fsp.readdir(LOG_DIR);
    const files = allFiles
      .filter(f => f.startsWith('runtime-') && f.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 2);
    const entries: LogEntry[] = [];
    for (const file of files) {
      const content = await fsp.readFile(path.join(LOG_DIR, file), 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch { /* skip malformed */ }
      }
    }
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export function getPersistentLogCount(): number {
  try {
    ensureLogDir();
    let count = 0;
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('runtime-') && f.endsWith('.log'));
    for (const file of files) {
      const stat = fs.statSync(path.join(LOG_DIR, file));
      if (Date.now() - stat.mtimeMs > MAX_LOG_AGE_MS) {
        try { fs.unlinkSync(path.join(LOG_DIR, file)); } catch { /* ignore */ }
        continue;
      }
      const content = fs.readFileSync(path.join(LOG_DIR, file), 'utf-8');
      count += content.trim().split('\n').filter(Boolean).length;
    }
    return count;
  } catch {
    return 0;
  }
}

export function cleanupOldLogs(): void {
  try {
    ensureLogDir();
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('runtime-') && f.endsWith('.log'));
    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs > MAX_LOG_AGE_MS) {
        fs.unlinkSync(filePath);
      }
    }
  } catch { /* ignore */ }
}
