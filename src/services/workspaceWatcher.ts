import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';
import { DiskRAGService } from './ragService';
import { VectorIndexService } from './vectorIndexService';
import { recordRuntimeEvent } from './runtimeEventLog';

export interface WorkspaceWatcher {
  directory: string;
  watcher: FSWatcher;
  close: () => Promise<void>;
}

function defaultIgnored(p: string): boolean {
  const parts = p.split(path.sep);
  return parts.includes('node_modules') ||
    parts.includes('.git') ||
    parts.includes('.zombiecoder') ||
    parts.includes('dist') ||
    parts.includes('logs') ||
    parts.includes('build') ||
    parts.includes('__pycache__') ||
    parts.includes('.cache') ||
    parts.includes('AppData') ||
    parts.includes('Application Data') ||
    parts.includes('My Documents') ||
    parts.includes('Start Menu') ||
    parts.includes('Templates') ||
    parts.includes('SendTo') ||
    parts.includes('Recent') ||
    parts.includes('PrintHood') ||
    parts.includes('NetHood') ||
    parts.includes('Cookies') ||
    p.includes('\\.') && parts.length > 4; // skip deeply nested hidden dirs
}

export function startWorkspaceWatcher(opts: {
  directory: string;
  rag: DiskRAGService;
  index?: VectorIndexService;
  workspaceId?: string;
  debounceMs?: number;
}): WorkspaceWatcher {
  const directory = path.resolve(opts.directory);
  const debounceMs = opts.debounceMs ?? 5000;

  let timer: NodeJS.Timeout | null = null;
  const triggerRescan = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      recordRuntimeEvent({
        timestamp: new Date().toISOString(),
        category: 'workspace',
        event: 'watcher_reindex_started',
        workspaceId: opts.workspaceId,
        directory,
      });
      try {
        // Rebuild SSOT on change. This is conservative but reliable.
        const scan = await opts.rag.scanProject();
        const next = opts.rag.generateSSOTTemplate(scan);
        opts.rag.saveSSOT(next);
        if (opts.index) {
          await opts.index.indexDirectory(directory, { workspaceId: opts.workspaceId });
        }
        recordRuntimeEvent({
          timestamp: new Date().toISOString(),
          category: 'workspace',
          event: 'watcher_reindex_completed',
          workspaceId: opts.workspaceId,
          directory,
          status: 'ok',
          details: {
            fileCount: scan.files.length,
          },
        });
      } catch (e: any) {
        recordRuntimeEvent({
          timestamp: new Date().toISOString(),
          category: 'workspace',
          event: 'watcher_reindex_failed',
          workspaceId: opts.workspaceId,
          directory,
          status: 'error',
          message: e?.message || String(e),
        });
        console.warn('workspace watcher rescan failed:', e?.message || e);
      }
    }, debounceMs);
  };

  const watcher = chokidar.watch(directory, {
    ignoreInitial: true,
    ignored: defaultIgnored,
    depth: 5,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });

  recordRuntimeEvent({
    timestamp: new Date().toISOString(),
    category: 'workspace',
    event: 'watcher_started',
    workspaceId: opts.workspaceId,
    directory,
    details: {
      debounceMs,
    },
  });

  watcher.on('add', triggerRescan);
  watcher.on('change', triggerRescan);
  watcher.on('unlink', triggerRescan);
  watcher.on('addDir', triggerRescan);
  watcher.on('unlinkDir', triggerRescan);
  watcher.on('error', (err) => console.warn('workspace watcher error:', (err as any)?.message || err));

  return {
    directory,
    watcher,
    close: async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      try { await watcher.close(); } catch { /* ignore */ }
    },
  };
}
