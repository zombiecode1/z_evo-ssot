import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ProjectScanResult, Permission } from '../types';

const ZOMBIE_DIR = '.zombiecoder';
const SSOT_FILE = 'SSOT.md';
const PERM_FILE = 'permissions.json';

export class DiskRAGService {
  private workingDir: string = '';
  private ssotPath: string = '';
  private permPath: string = '';
  private sessionBuffer: string[] = [];

  get hasWorkingDir(): boolean { return !!this.workingDir; }
  get currentDir(): string { return this.workingDir; }

  async setWorkingDirectory(dir: string, opts?: { autoInit?: boolean }): Promise<{ needsPermission: boolean }> {
    this.workingDir = path.resolve(dir);
    this.ssotPath = path.join(this.workingDir, ZOMBIE_DIR, SSOT_FILE);
    this.permPath = path.join(this.workingDir, ZOMBIE_DIR, PERM_FILE);

    const zombieDir = path.join(this.workingDir, ZOMBIE_DIR);
    const existsZombieDir = fs.existsSync(zombieDir);
    const existsSsot = fs.existsSync(this.ssotPath);

    if (!existsZombieDir || !existsSsot) {
      if (opts?.autoInit) {
        if (!existsZombieDir) fs.mkdirSync(zombieDir, { recursive: true });
        if (!existsSsot) {
          const scanResult = await this.scanProject();
          const template = this.generateSSOTTemplate(scanResult);
          this.saveSSOT(template);
        }
        return { needsPermission: false };
      }
      return { needsPermission: true };
    }

    return { needsPermission: false };
  }

  requestPermissionMessage(scope: Permission['scope']): string {
    return [
      `Agent requests permission to access your project.`,
      `Directory: ${this.workingDir}`,
      `Scope: ${scope}`,
      `Grant permission to proceed:`,
      `POST /v1/agent/permission { "grant": true, "scope": "${scope}" }`,
    ].join('\n');
  }

  grantPermission(scope: Permission['scope']): void {
    const zombieDir = path.join(this.workingDir, ZOMBIE_DIR);
    if (!fs.existsSync(zombieDir)) {
      fs.mkdirSync(zombieDir, { recursive: true });
    }
    const perms: Permission[] = [];
    if (fs.existsSync(this.permPath)) {
      perms.push(...JSON.parse(fs.readFileSync(this.permPath, 'utf-8')));
    }
    const perm: Permission = {
      directory: this.workingDir,
      grantedAt: Date.now(),
      scope,
      signature: crypto.createHash('sha256').update(`${this.workingDir}:${scope}:${Date.now()}`).digest('hex'),
    };
    perms.push(perm);
    fs.writeFileSync(this.permPath, JSON.stringify(perms, null, 2));
  }

  hasPermission(scope: Permission['scope']): boolean {
    try {
      if (!fs.existsSync(this.permPath)) return false;
      const perms: Permission[] = JSON.parse(fs.readFileSync(this.permPath, 'utf-8'));
      return perms.some(p => p.directory === this.workingDir && p.scope === scope);
    } catch { return false; }
  }

  async scanProject(): Promise<ProjectScanResult> {
    const tree = this.buildTree(this.workingDir, 0);
    const files = this.scanFiles(this.workingDir);
    const deps = this.readDependencies();
    return { tree, files, dependencies: deps };
  }

  private buildTree(dir: string, depth: number): string {
    if (depth > 3) return '';
    let result = '';
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const indent = '  '.repeat(depth);
        result += `${indent}${entry.isDirectory() ? '📁' : '📄'} ${entry.name}\n`;
        if (entry.isDirectory()) {
          result += this.buildTree(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch { }
    return result;
  }

  private scanFiles(dir: string): ProjectScanResult['files'] {
    const files: ProjectScanResult['files'] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.scanFiles(fullPath));
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          let type: ProjectScanResult['files'][0]['type'] = 'source';
          if (['.json', '.yaml', '.yml', '.toml', '.env.example'].includes(ext)) type = 'config';
          if (['.md', '.txt', '.pdf', '.html', '.htm'].includes(ext)) type = 'doc';
          if (entry.name.startsWith('test') || entry.name.startsWith('spec') || entry.name.endsWith('.test.ts')) type = 'test';
          files.push({ path: path.relative(this.workingDir, fullPath), type, summary: '' });
        }
      }
    } catch { }
    return files;
  }

  private readDependencies(): Record<string, string> {
    try {
      const pkgPath = path.join(this.workingDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return { ...pkg.dependencies, ...pkg.devDependencies };
      }
    } catch { }
    return {};
  }

  generateSSOTTemplate(scanResult: ProjectScanResult): string {
    const docFiles = scanResult.files.filter(f => f.type === 'doc');
    const docLines: string[] = [];
    for (const f of docFiles) {
      const rel = f.path;
      let line = `- \`${rel}\``;
      try {
        const full = path.join(this.workingDir, rel);
        if (full.toLowerCase().endsWith('.html') || full.toLowerCase().endsWith('.htm')) {
          const preview = this.extractDocPreview(full);
          if (preview) line += ` — ${preview.replace(/\r?\n/g, ' ').slice(0, 300)}...`;
        }
      } catch { }
      docLines.push(line);
    }

    return [
      `# ${path.basename(this.workingDir)} — Project Documentation`,
      '',
      '> Auto-generated by ZombieCoder Agent',
      `> Last updated: ${new Date().toISOString()}`,
      '',
      '## Project Structure',
      '```',
      scanResult.tree,
      '```',
      '',
      '## Dependencies',
      ...Object.entries(scanResult.dependencies).map(([k, v]) => `- \`${k}@${v}\``),
      '',
      '## Source Files',
      ...scanResult.files.filter(f => f.type === 'source').map(f => `- \`${f.path}\``),
      '',
      '## Configuration Files',
      ...scanResult.files.filter(f => f.type === 'config').map(f => `- \`${f.path}\``),
      '',
      '## Documentation Files',
      ...docLines,
      '',
      '## Agent Notes',
      '',
      '_(This section may be updated by the agent over time.)_',
      '',
    ].join('\n');
  }

  private extractDocPreview(fullPath: string): string {
    try {
      let raw = fs.readFileSync(fullPath, 'utf-8');
      raw = raw.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ');
      raw = raw.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ');
      raw = raw.replace(/<!--([\s\S]*?)-->/g, ' ');
      const bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      if (bodyMatch) raw = bodyMatch[1];
      let txt = raw.replace(/<[^>]+>/g, ' ');
      txt = txt.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      txt = txt.replace(/\s+/g, ' ').trim();
      if (txt.length > 400) return txt.slice(0, 400);
      return txt;
    } catch { return ''; }
  }

  saveSSOT(content: string): void {
    const zombieDir = path.join(this.workingDir, ZOMBIE_DIR);
    if (!fs.existsSync(zombieDir)) {
      fs.mkdirSync(zombieDir, { recursive: true });
    }
    fs.writeFileSync(this.ssotPath, content, 'utf-8');
  }

  readSSOT(): string {
    try {
      return fs.readFileSync(this.ssotPath, 'utf-8');
    } catch { return ''; }
  }

  appendToSSOT(newSection: string): void {
    const existing = this.readSSOT();
    const timestamp = new Date().toISOString();
    const entry = `\n\n---\n\n## Agent Update — ${timestamp}\n\n${newSection}`;
    this.saveSSOT(existing + entry);
  }

  ssotExists(): boolean {
    return fs.existsSync(this.ssotPath);
  }

  zombieDirExists(): boolean {
    return fs.existsSync(path.join(this.workingDir, ZOMBIE_DIR));
  }

  addToSession(message: string): void {
    this.sessionBuffer.push(message);
    if (this.sessionBuffer.length > 20) {
      this.sessionBuffer.shift();
    }
  }

  getSessionContext(): string {
    return this.sessionBuffer.join('\n');
  }

  clearSession(): void {
    this.sessionBuffer = [];
  }

  searchSSOT(query: string): string {
    const content = this.readSSOT();
    if (!content) return '';
    const lines = content.split('\n');
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return '';
    const matchedSections: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      const matchCount = keywords.filter(k => line.includes(k)).length;
      if (matchCount > 0) {
        const section = this.getSection(content, lines[i]);
        if (section && !matchedSections.includes(section)) {
          matchedSections.push(section);
        }
      }
    }
    return matchedSections.slice(0, 5).join('\n\n---\n\n');
  }

  private getSection(content: string, matchingLine: string): string {
    const lines = content.split('\n');
    const matchIdx = lines.findIndex(l => l === matchingLine);
    if (matchIdx === -1) return '';
    let startIdx = matchIdx;
    for (let i = matchIdx; i >= 0; i--) {
      if (lines[i].startsWith('#')) { startIdx = i; break; }
    }
    let endIdx = lines.length;
    for (let i = matchIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('#')) { endIdx = i; break; }
    }
    return lines.slice(startIdx, endIdx).join('\n').trim();
  }
}
