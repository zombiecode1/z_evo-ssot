/**
 * Cross-Platform Shell Execution Tools
 * 
 * Executes shell commands safely on Windows, Linux, and macOS.
 * Uses appropriate shell for each platform:
 *   - Windows: PowerShell (pwsh) or cmd.exe
 *   - Linux/macOS: bash or sh
 * 
 * Based on Node.js child_process module.
 * Reference: https://nodejs.org/api/child_process.html
 */

import { execSync, spawn } from "child_process";
import * as os from "os";

// ═══════════════════════════════════════════════════════════════════════════════
// Platform Detection & Shell Selection
// ═══════════════════════════════════════════════════════════════════════════════

export type Platform = string;

export function getPlatform(): Platform {
  return os.platform();
}

/**
 * Get the appropriate shell for the current platform
 */
export function getShell(): { command: string; args: string[] } {
  const platform = os.platform();

  if (platform === "win32") {
    // Prefer PowerShell Core (pwsh) if available, fallback to PowerShell
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command"],
    };
  } else {
    // Linux/macOS: prefer bash, fallback to sh
    return {
      command: "/bin/bash",
      args: ["-c"],
    };
  }
}

/**
 * Get platform-specific command prefix
 */
export function getPlatformCommand(command: string): string {
  const platform = os.platform();

  if (platform === "win32") {
    // Convert Unix-style commands to PowerShell equivalents
    return convertToPowerShell(command);
  } else {
    return command;
  }
}

/**
 * Convert common Unix commands to PowerShell equivalents
 */
function convertToPowerShell(command: string): string {
  const conversions: Record<string, string> = {
    // File listing
    "ls -la": "Get-ChildItem -Force",
    "ls -la ": "Get-ChildItem -Force -Path ",
    "ls -l": "Get-ChildItem",
    "ls": "Get-ChildItem",
    "dir": "Get-ChildItem",

    // File reading
    "cat": "Get-Content",
    "head": "Get-Content -Head",
    "tail": "Get-Content -Tail",

    // File operations
    "cp": "Copy-Item",
    "mv": "Move-Item",
    "rm": "Remove-Item",
    "mkdir": "New-Item -ItemType Directory",
    "touch": "New-Item -ItemType File",

    // Text processing
    "grep": "Select-String",
    "find": "Get-ChildItem -Recurse",
    "wc": "(Get-Content | Measure-Object -Line).Lines",

    // System
    "pwd": "Get-Location",
    "echo": "Write-Output",
    "env": "Get-ChildItem Env:",
  };

  // Check for exact matches first
  const trimmed = command.trim();
  if (conversions[trimmed]) {
    return conversions[trimmed];
  }

  // Check for pattern matches (e.g., "ls -la /path")
  for (const [pattern, replacement] of Object.entries(conversions)) {
    if (trimmed.startsWith(pattern + " ")) {
      const arg = trimmed.substring(pattern.length + 1);
      return `${replacement} "${arg}"`;
    }
  }

  // Return as-is if no conversion found
  return command;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Command Execution
// ═══════════════════════════════════════════════════════════════════════════════

export interface CommandResult {
  command: string;
  platform: Platform;
  shell: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration_ms: number;
  success: boolean;
}

export interface ExecuteOptions {
  command: string;
  cwd?: string;
  timeout?: number;       // ms (default: 30000)
  maxBuffer?: number;     // bytes (default: 1MB)
  env?: Record<string, string>;
}

/**
 * Execute a shell command synchronously
 */
export function executeCommandSync(options: ExecuteOptions): CommandResult {
  const {
    command,
    cwd = process.cwd(),
    timeout = 30000,
    maxBuffer = 1024 * 1024,
    env = {},
  } = options;

  const platform = os.platform();
  const shell = getShell();
  const startTime = Date.now();

  // Convert command for the current platform
  const platformCommand = getPlatformCommand(command);

  // Build full command with shell
  let fullCommand: string;
  if (platform === "win32") {
    fullCommand = `${shell.command} ${shell.args.join(" ")} "${platformCommand}"`;
  } else {
    fullCommand = `${shell.command} ${shell.args.join(" ")} '${platformCommand}'`;
  }

  try {
    const output = execSync(fullCommand, {
      cwd,
      timeout,
      maxBuffer,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      command,
      platform,
      shell: shell.command,
      stdout: output || "",
      stderr: "",
      exitCode: 0,
      duration_ms: Date.now() - startTime,
      success: true,
    };
  } catch (error: any) {
    return {
      command,
      platform,
      shell: shell.command,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      exitCode: error.status || 1,
      duration_ms: Date.now() - startTime,
      success: false,
    };
  }
}

/**
 * Execute a shell command asynchronously with streaming output
 */
export async function executeCommandAsync(
  options: ExecuteOptions
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const {
      command,
      cwd = process.cwd(),
      timeout = 30000,
      env = {},
    } = options;

    const platform = os.platform();
    const shell = getShell();
    const startTime = Date.now();

    const platformCommand = getPlatformCommand(command);

    let fullArgs: string[];
    if (platform === "win32") {
      fullArgs = [...shell.args, platformCommand];
    } else {
      fullArgs = [...shell.args, platformCommand];
    }

    const child = spawn(shell.command, fullArgs, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        command,
        platform,
        shell: shell.command,
        stdout,
        stderr: stderr + "\n[TIMEOUT] Command timed out after " + timeout + "ms",
        exitCode: -1,
        duration_ms: Date.now() - startTime,
        success: false,
      });
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        platform,
        shell: shell.command,
        stdout,
        stderr,
        exitCode: code ?? 1,
        duration_ms: Date.now() - startTime,
        success: code === 0,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        command,
        platform,
        shell: shell.command,
        stdout,
        stderr: err.message,
        exitCode: -1,
        duration_ms: Date.now() - startTime,
        success: false,
      });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Definitions for LLM Function Calling
// ═══════════════════════════════════════════════════════════════════════════════

export const shellToolDefinitions = [
  {
    name: "run_command",
    description:
      "Execute a shell command. Auto-detects platform (Windows/Linux/macOS) and uses appropriate shell. " +
      "Windows: PowerShell, Linux/macOS: bash. Timeout: 30s default.",
    parameters: {
      type: "object" as const,
      properties: {
        command: {
          type: "string" as const,
          description:
            "Shell command to execute. Unix commands are auto-converted on Windows.",
        },
        cwd: {
          type: "string" as const,
          description: "Working directory (optional, defaults to current)",
        },
        timeout: {
          type: "number" as const,
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "get_platform_info",
    description: "Get information about the current platform (OS, architecture, shell).",
    parameters: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Executors
// ═══════════════════════════════════════════════════════════════════════════════

export async function executeShellTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (toolName) {
      case "run_command": {
        const command = String(args.command || "");
        if (!command) {
          return JSON.stringify({ error: "command is required" });
        }

        // Safety: block dangerous commands
        const dangerous = [
          "rm -rf /",
          "rm -rf /*",
          "format",
          "mkfs",
          "dd if=",
          ":(){:|:&};:",
        ];
        const lowerCmd = command.toLowerCase();
        if (dangerous.some((d) => lowerCmd.includes(d))) {
          return JSON.stringify({
            error: "Command blocked for safety",
            command,
          });
        }

        const result = executeCommandSync({
          command,
          cwd: args.cwd ? String(args.cwd) : undefined,
          timeout: Number(args.timeout) || 30000,
        });

        return JSON.stringify(result, null, 2);
      }

      case "get_platform_info": {
        return JSON.stringify(
          {
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            hostname: os.hostname(),
            shell: getShell(),
            homeDir: os.homedir(),
            tmpDir: os.tmpdir(),
            cpus: os.cpus().length,
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
          },
          null,
          2
        );
      }

      default:
        return JSON.stringify({ error: `Unknown shell tool: ${toolName}` });
    }
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : "Tool execution failed",
      tool: toolName,
    });
  }
}
