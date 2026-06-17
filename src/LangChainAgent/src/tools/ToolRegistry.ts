/**
 * Tool Registry — Central hub for all agent tools
 * 
 * Aggregates File System Tools, DuckDuckGo Search, and Shell Execution.
 * Auto-detects platform and registers appropriate tools.
 * 
 * Pipeline Architecture:
 * User Input → Transport Layer → Session Manager → Tool Registry → Tool Execution → LLM Reflection → Response
 */

import {
  fileToolDefinitions,
  executeFileTool,
  FileInfo,
  FileContent,
} from "./FileTools";

import {
  duckDuckGoToolDefinition,
  executeDuckDuckGoSearch,
  SearchResult,
} from "./DuckDuckGoSearch";

import {
  shellToolDefinitions,
  executeShellTool,
  getPlatform,
  Platform,
} from "./ShellTools";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  success: boolean;
  tool: string;
  data?: unknown;
  error?: string;
  duration_ms?: number;
}

export interface ToolRegistryStatus {
  platform: Platform;
  totalTools: number;
  toolsByCategory: Record<string, number>;
  tools: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Registry
// ═══════════════════════════════════════════════════════════════════════════════

export class ToolRegistry {
  private static instance: ToolRegistry;
  private tools: Map<string, ToolDefinition> = new Map();
  private executors: Map<string, (args: Record<string, unknown>) => Promise<string>> = new Map();
  private platform: Platform;

  private constructor() {
    this.platform = getPlatform();
    this.registerBuiltInTools();
  }

  public static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  /**
   * Register all built-in tools based on current platform
   */
  private registerBuiltInTools(): void {
    // ─── File System Tools ───────────────────────────────
    for (const def of fileToolDefinitions) {
      this.tools.set(def.name, def);
      this.executors.set(def.name, (args) => executeFileTool(def.name, args));
    }

    // ─── DuckDuckGo Search Tool ──────────────────────────
    this.tools.set(duckDuckGoToolDefinition.name, duckDuckGoToolDefinition);
    this.executors.set(duckDuckGoToolDefinition.name, (args) =>
      executeDuckDuckGoSearch(args)
    );

    // ─── Shell Execution Tools ───────────────────────────
    for (const def of shellToolDefinitions) {
      this.tools.set(def.name, def);
      this.executors.set(def.name, (args) => executeShellTool(def.name, args));
    }

    console.log(
      `[ToolRegistry] Registered ${this.tools.size} tools for platform: ${this.platform}`
    );
  }

  /**
   * Get all tool definitions (for LLM function calling)
   */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions in OpenAI function calling format
   */
  getOpenAITools(): Array<{
    type: "function";
    function: ToolDefinition;
  }> {
    return this.getToolDefinitions().map((def) => ({
      type: "function" as const,
      function: def,
    }));
  }

  /**
   * Get a specific tool definition
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute a tool by name
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const executor = this.executors.get(name);
    if (!executor) {
      return {
        success: false,
        tool: name,
        error: `Tool not found: ${name}`,
      };
    }

    const startTime = Date.now();
    try {
      const result = await executor(args);
      return {
        success: true,
        tool: name,
        data: JSON.parse(result),
        duration_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        tool: name,
        error: error instanceof Error ? error.message : "Unknown error",
        duration_ms: Date.now() - startTime,
      };
    }
  }

  /**
   * Auto-detect and execute tool from natural language query
   */
  async autoDetectAndExecute(query: string): Promise<ToolResult | null> {
    const lower = query.toLowerCase();

    // ─── Pattern Matching for Tool Detection ─────────────

    // DuckDuckGo Search
    if (
      /search|গুগল|খুঁজুন|find online|web search|duckduckgo/i.test(lower)
    ) {
      const searchQuery = query
        .replace(/search\s*(for|about)?\s*/i, "")
        .replace(/গুগল\s*/i, "")
        .replace(/খুঁজুন\s*/i, "")
        .trim();
      return this.executeTool("web_search", { query: searchQuery });
    }

    // File Read (cross-platform patterns)
    if (
      /read\s+(file|ফাইল)|পড়ো|open\s+file|show\s+(file|content|মেনু)/i.test(
        lower
      )
    ) {
      // Extract path from various patterns
      const pathMatch = query.match(
        /(?:read|open|show|পড়ো|ফাইল)\s+(?:file\s+)?[`"']?([^`"'\n]+)[`"']?/i
      );
      if (pathMatch) {
        return this.executeTool("read_file", { path: pathMatch[1].trim() });
      }
    }

    // List Files
    if (
      /list\s+(files?|ফাইল)|ফাইল\s+লিস্ট|directory\s+structure|folder|ls\b/i.test(
        lower
      )
    ) {
      const dirMatch = query.match(
        /(?:list|ls|dir|ফাইল)\s+(?:files?\s+)?(?:in\s+)?[`"']?([^`"'\n]+)[`"']?/i
      );
      const dir = dirMatch ? dirMatch[1].trim() : ".";
      return this.executeTool("list_files", { directory: dir });
    }

    // Find Files
    if (/find\s+(file|ফাইল)|খুঁজুন\s+ফাইল|search\s+file/i.test(lower)) {
      const termMatch = query.match(
        /(?:find|search|খুঁজুন)\s+(?:file|ফাইল)\s*[`:"]?([^`:"\n]+)[`:"]?/i
      );
      if (termMatch) {
        return this.executeTool("find_files", {
          directory: ".",
          searchTerm: termMatch[1].trim(),
        });
      }
    }

    // Search Code
    if (
      /search\s+code|কোড\s+খুঁজুন|grep|find\s+(function|class|variable)/i.test(
        lower
      )
    ) {
      const queryMatch = query.match(
        /(?:search|grep|খুঁজুন)\s+(?:code\s+)?(?:for\s+)?[`"']?([^`"'\n]+)[`"']?/i
      );
      if (queryMatch) {
        return this.executeTool("search_code", {
          directory: ".",
          query: queryMatch[1].trim(),
        });
      }
    }

    // Run Command
    if (
      /run\s+(command|কমান্ড)|execute|exec|শেল|terminal|bash|powershell/i.test(
        lower
      )
    ) {
      const cmdMatch = query.match(
        /(?:run|execute|exec|শেল)\s+(?:command\s+)?[`"']?([^`"'\n]+)[`"']?/i
      );
      if (cmdMatch) {
        return this.executeTool("run_command", { command: cmdMatch[1].trim() });
      }
    }

    // Platform Info
    if (/platform|প্ল্যাটফর্ম|system\s+info|কম্পিউটার/i.test(lower)) {
      return this.executeTool("get_platform_info", {});
    }

    return null;
  }

  /**
   * Get registry status
   */
  getStatus(): ToolRegistryStatus {
    const toolsByCategory: Record<string, number> = {
      file: 0,
      search: 0,
      shell: 0,
    };

    for (const name of this.tools.keys()) {
      if (
        [
          "read_file",
          "list_files",
          "find_files",
          "search_code",
          "write_file",
          "get_file_info",
        ].includes(name)
      ) {
        toolsByCategory.file++;
      } else if (name === "web_search") {
        toolsByCategory.search++;
      } else if (["run_command", "get_platform_info"].includes(name)) {
        toolsByCategory.shell++;
      }
    }

    return {
      platform: this.platform,
      totalTools: this.tools.size,
      toolsByCategory,
      tools: Array.from(this.tools.keys()),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════════

export {
  // File tools
  readFile,
  listFiles,
  findFiles,
  searchInFiles,
  writeFile,
  getFileInfo,
} from "./FileTools";

export {
  // Search tools
  searchDuckDuckGo,
} from "./DuckDuckGoSearch";

export {
  // Shell tools
  executeCommandSync,
  executeCommandAsync,
} from "./ShellTools";

// Types
export type { SearchResult } from "./DuckDuckGoSearch";
export type { FileInfo, FileContent } from "./FileTools";
export type { CommandResult } from "./ShellTools";
