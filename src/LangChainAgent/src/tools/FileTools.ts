/**
 * Cross-Platform File System Tools
 * 
 * Works on Windows, Linux, and macOS.
 * Auto-detects OS and uses appropriate path patterns.
 * 
 * Based on Node.js fs module (cross-platform by design).
 * Reference: https://nodejs.org/api/fs.html
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ═══════════════════════════════════════════════════════════════════════════════
// Platform Detection
// ═══════════════════════════════════════════════════════════════════════════════

export type Platform = string;

export function getPlatform(): Platform {
  return os.platform();
}

export function isWindows(): boolean {
  return os.platform() === "win32";
}

export function isLinux(): boolean {
  return os.platform() === "linux";
}

export function isMac(): boolean {
  return os.platform() === "darwin";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Path Utilities (Cross-platform)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize a file path for the current platform
 * Converts forward slashes to backslashes on Windows, and vice versa
 */
export function normalizePath(inputPath: string): string {
  // First, resolve any relative paths
  const resolved = path.resolve(inputPath);
  // Then normalize for the current platform
  return path.normalize(resolved);
}

/**
 * Convert Windows path to Unix path and vice versa
 */
export function convertPath(inputPath: string, targetPlatform: Platform): string {
  if (targetPlatform === "win32") {
    // Convert forward slashes to backslashes
    return inputPath.replace(/\//g, "\\");
  } else {
    // Convert backslashes to forward slashes
    return inputPath.replace(/\\/g, "/");
  }
}

/**
 * Get common system directories based on platform
 */
export function getSystemDirs(): string[] {
  const platform = os.platform();
  const home = os.homedir();

  const commonDirs: string[] = [
    home,
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
  ];

  if (platform === "win32") {
    commonDirs.push(
      "C:\\",
      "C:\\Users",
      "C:\\Program Files",
      "C:\\Program Files (x86)"
    );
  } else if (platform === "linux") {
    commonDirs.push(
      "/",
      "/home",
      "/usr",
      "/var",
      "/tmp"
    );
  } else if (platform === "darwin") {
    commonDirs.push(
      "/",
      "/Users",
      "/Applications",
      "/Library"
    );
  }

  return commonDirs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// File System Tools
// ═══════════════════════════════════════════════════════════════════════════════

export interface FileContent {
  path: string;
  content: string;
  size: number;
  modified: string;
  isDirectory: boolean;
}

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  extension: string;
}

/**
 * Read a file's content
 */
export async function readFile(filePath: string): Promise<FileContent> {
  const normalized = normalizePath(filePath);

  if (!fs.existsSync(normalized)) {
    throw new Error(`File not found: ${normalized}`);
  }

  const stat = fs.statSync(normalized);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${normalized}`);
  }

  // Limit file size to 1MB
  if (stat.size > 1024 * 1024) {
    throw new Error(`File too large (${stat.size} bytes). Limit: 1MB`);
  }

  const content = fs.readFileSync(normalized, "utf-8");
  return {
    path: normalized,
    content,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    isDirectory: false,
  };
}

/**
 * List files in a directory
 */
export async function listFiles(
  dirPath: string,
  options: {
    recursive?: boolean;
    maxDepth?: number;
    includeHidden?: boolean;
    pattern?: string;
  } = {}
): Promise<FileInfo[]> {
  const { recursive = false, maxDepth = 3, includeHidden = false, pattern } = options;
  const normalized = normalizePath(dirPath);

  if (!fs.existsSync(normalized)) {
    throw new Error(`Directory not found: ${normalized}`);
  }

  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${normalized}`);
  }

  const results: FileInfo[] = [];
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".zombiecoder",
    "__pycache__",
    ".cache",
    ".vscode",
    ".idea",
  ]);

  function scanDir(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files if not requested
        if (!includeHidden && entry.name.startsWith(".")) continue;

        // Skip known large directories
        if (entry.isDirectory() && skipDirs.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        // Apply pattern filter
        if (pattern && !entry.name.toLowerCase().includes(pattern.toLowerCase())) {
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          }
          continue;
        }

        try {
          const entryStat = fs.statSync(fullPath);
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? 0 : entryStat.size,
            modified: entryStat.mtime.toISOString(),
            extension: entry.isDirectory() ? "" : path.extname(entry.name),
          });

          // Recurse into directories if requested
          if (entry.isDirectory() && recursive) {
            scanDir(fullPath, depth + 1);
          }
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  scanDir(normalized, 0);
  return results;
}

/**
 * Search for files by name pattern
 */
export async function findFiles(
  dirPath: string,
  searchTerm: string,
  options: { maxResults?: number; maxDepth?: number } = {}
): Promise<FileInfo[]> {
  const { maxResults = 50, maxDepth = 8 } = options;
  const allFiles = await listFiles(dirPath, {
    recursive: true,
    maxDepth,
    includeHidden: false,
  });

  const searchLower = searchTerm.toLowerCase();
  return allFiles
    .filter(
      (f) =>
        f.name.toLowerCase().includes(searchLower) ||
        f.path.toLowerCase().includes(searchLower)
    )
    .slice(0, maxResults);
}

/**
 * Search file contents using regex or literal string
 */
export async function searchInFiles(
  dirPath: string,
  query: string,
  options: {
    filePattern?: string;
    maxResults?: number;
    maxDepth?: number;
  } = {}
): Promise<Array<{ file: string; line: number; content: string }>> {
  const { filePattern, maxResults = 100, maxDepth = 6 } = options;
  const normalized = normalizePath(dirPath);

  const results: Array<{ file: string; line: number; content: string }> = [];
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".zombiecoder",
    "__pycache__",
  ]);

  function searchDir(dir: string, depth: number): void {
    if (depth > maxDepth || results.length >= maxResults) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && skipDirs.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          searchDir(fullPath, depth + 1);
          continue;
        }

        // Check file pattern
        if (filePattern && !entry.name.toLowerCase().includes(filePattern.toLowerCase())) {
          continue;
        }

        // Only search text files
        const ext = path.extname(entry.name).toLowerCase();
        const textExts = [
          ".ts", ".js", ".tsx", ".jsx", ".json", ".md", ".txt",
          ".py", ".php", ".rb", ".go", ".rs", ".java", ".c", ".cpp",
          ".html", ".css", ".scss", ".yaml", ".yml", ".toml", ".xml",
          ".env", ".gitignore", ".dockerfile", ".sh", ".bash",
        ];
        if (!textExts.includes(ext) && !entry.name.includes(".")) continue;

        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break;
            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
              results.push({
                file: fullPath,
                line: i + 1,
                content: lines[i].trim().substring(0, 200),
              });
            }
          }
        } catch {
          // Skip binary files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  searchDir(normalized, 0);
  return results;
}

/**
 * Write content to a file (creates parent directories if needed)
 */
export async function writeFile(
  filePath: string,
  content: string
): Promise<{ path: string; bytesWritten: number }> {
  const normalized = normalizePath(filePath);
  const dir = path.dirname(normalized);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(normalized, content, "utf-8");
  const stat = fs.statSync(normalized);

  return {
    path: normalized,
    bytesWritten: stat.size,
  };
}

/**
 * Get file/directory info
 */
export async function getFileInfo(filePath: string): Promise<FileInfo> {
  const normalized = normalizePath(filePath);

  if (!fs.existsSync(normalized)) {
    throw new Error(`Path not found: ${normalized}`);
  }

  const stat = fs.statSync(normalized);
  return {
    name: path.basename(normalized),
    path: normalized,
    isDirectory: stat.isDirectory(),
    size: stat.size,
    modified: stat.mtime.toISOString(),
    extension: stat.isDirectory() ? "" : path.extname(normalized),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Definitions for LLM Function Calling
// ═══════════════════════════════════════════════════════════════════════════════

export const fileToolDefinitions = [
  {
    name: "read_file",
    description: "Read the content of a file. Works on Windows/Linux/macOS. Auto-detects platform.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description: "Absolute or relative path to the file",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory. Supports recursive listing, depth limit, and pattern filtering.",
    parameters: {
      type: "object" as const,
      properties: {
        directory: {
          type: "string" as const,
          description: "Directory path to list",
        },
        recursive: {
          type: "boolean" as const,
          description: "Whether to list recursively (default: false)",
        },
        maxDepth: {
          type: "number" as const,
          description: "Maximum recursion depth (default: 3)",
        },
        pattern: {
          type: "string" as const,
          description: "Filter files by name pattern",
        },
      },
      required: ["directory"],
    },
  },
  {
    name: "find_files",
    description: "Search for files by name pattern in a directory tree.",
    parameters: {
      type: "object" as const,
      properties: {
        directory: {
          type: "string" as const,
          description: "Root directory to search from",
        },
        searchTerm: {
          type: "string" as const,
          description: "Search term to match against file names",
        },
        maxResults: {
          type: "number" as const,
          description: "Maximum number of results (default: 50)",
        },
      },
      required: ["directory", "searchTerm"],
    },
  },
  {
    name: "search_code",
    description: "Search for text/regex patterns inside files. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object" as const,
      properties: {
        directory: {
          type: "string" as const,
          description: "Root directory to search in",
        },
        query: {
          type: "string" as const,
          description: "Text or regex pattern to search for",
        },
        filePattern: {
          type: "string" as const,
          description: "Filter by file name pattern (e.g., '.ts', 'Controller')",
        },
        maxResults: {
          type: "number" as const,
          description: "Maximum results (default: 100)",
        },
      },
      required: ["directory", "query"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed.",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description: "File path to write to",
        },
        content: {
          type: "string" as const,
          description: "Content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file or directory (size, modified date, type).",
    parameters: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description: "Path to check",
        },
      },
      required: ["path"],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Executors
// ═══════════════════════════════════════════════════════════════════════════════

export async function executeFileTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (toolName) {
      case "read_file": {
        const result = await readFile(String(args.path || ""));
        return JSON.stringify(result, null, 2);
      }
      case "list_files": {
        const result = await listFiles(String(args.directory || "."), {
          recursive: Boolean(args.recursive),
          maxDepth: Number(args.maxDepth) || 3,
          pattern: args.pattern ? String(args.pattern) : undefined,
        });
        return JSON.stringify(
          { directory: args.directory, count: result.length, files: result },
          null,
          2
        );
      }
      case "find_files": {
        const result = await findFiles(
          String(args.directory || "."),
          String(args.searchTerm || ""),
          { maxResults: Number(args.maxResults) || 50 }
        );
        return JSON.stringify(
          { searchTerm: args.searchTerm, count: result.length, files: result },
          null,
          2
        );
      }
      case "search_code": {
        const result = await searchInFiles(
          String(args.directory || "."),
          String(args.query || ""),
          {
            filePattern: args.filePattern ? String(args.filePattern) : undefined,
            maxResults: Number(args.maxResults) || 100,
          }
        );
        return JSON.stringify(
          { query: args.query, matches: result.length, results: result },
          null,
          2
        );
      }
      case "write_file": {
        const result = await writeFile(
          String(args.path || ""),
          String(args.content || "")
        );
        return JSON.stringify(result, null, 2);
      }
      case "get_file_info": {
        const result = await getFileInfo(String(args.path || ""));
        return JSON.stringify(result, null, 2);
      }
      default:
        return JSON.stringify({ error: `Unknown file tool: ${toolName}` });
    }
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : "Tool execution failed",
      tool: toolName,
    });
  }
}
