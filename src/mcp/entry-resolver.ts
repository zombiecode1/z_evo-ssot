import fs from 'fs';
import path from 'path';

export type McpServerLaunch = {
  command: string;
  args: string[];
  entryPath: string;
  mode: 'compiled' | 'typescript';
};

export function resolveMcpServerLaunch(): McpServerLaunch {
  const compiledEntry = path.join(__dirname, 'server-entry.js');
  if (fs.existsSync(compiledEntry)) {
    return {
      command: process.execPath,
      args: [compiledEntry],
      entryPath: compiledEntry,
      mode: 'compiled',
    };
  }

  const sourceEntry = path.join(__dirname, 'server-entry.ts');
  return {
    command: process.execPath,
    args: ['-r', 'ts-node/register', sourceEntry],
    entryPath: sourceEntry,
    mode: 'typescript',
  };
}
