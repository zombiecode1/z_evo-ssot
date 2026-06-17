/**
 * Tools Module — Export all tools
 */

export {
  ToolRegistry,
  ToolDefinition,
  ToolResult,
  ToolRegistryStatus,
} from "./ToolRegistry";

export {
  searchDuckDuckGo,
  duckDuckGoToolDefinition,
  executeDuckDuckGoSearch,
  SearchResult,
  SearchOptions,
} from "./DuckDuckGoSearch";

export {
  readFile,
  listFiles,
  findFiles,
  searchInFiles,
  writeFile,
  getFileInfo,
  fileToolDefinitions,
  executeFileTool,
  normalizePath,
  convertPath,
  getPlatform as getFilePlatform,
  isWindows,
  isLinux,
  isMac,
  FileInfo,
  FileContent,
} from "./FileTools";

export {
  executeCommandSync,
  executeCommandAsync,
  shellToolDefinitions,
  executeShellTool,
  getPlatform as getShellPlatform,
  getShell,
  getPlatformCommand,
  CommandResult,
  ExecuteOptions,
} from "./ShellTools";
