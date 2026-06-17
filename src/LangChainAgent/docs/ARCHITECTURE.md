# ZombieCoder LangChainAgent — Architecture Documentation

> **Version**: 2.0.0  
> **Last Updated**: 2026-06-15  
> **Author**: Sahon Srabon (ZombieCoder)

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Pipeline Architecture](#pipeline-architecture)
3. [Pipeline 1: Resilient Memory Management](#pipeline-1-resilient-memory-management)
4. [Pipeline 2: Dynamic Prompt Ingestion & RAG](#pipeline-2-dynamic-prompt-ingestion--rag)
5. [Pipeline 3: Tool Registry & Execution](#pipeline-3-tool-registry--execution)
6. [Pipeline 4: Dual Transport Architecture](#pipeline-4-dual-transport-architecture)
7. [Cross-Platform Support](#cross-platform-support)
8. [SSOT Flag Auto-Init System](#ssot-flag-auto-init-system)
9. [API Reference](#api-reference)
10. [Deployment](#deployment)

---

## Overview

ZombieCoder LangChainAgent is a modular AI agent system with:

- **5 Specialized Agents**: Solution Architect, Development Engineer, QA, Documentation, Operations
- **SQLite Memory**: Persistent conversation history with RAM fallback
- **DuckDuckGo Search**: Web search without API keys
- **Cross-Platform Tools**: Works on Windows, Linux, macOS
- **Dual Transport**: STDIO (MCP) + HTTP/WebSocket

```
┌─────────────────────────────────────────────────────────────┐
│                    ZombieCoder Agent System                   │
├─────────────────────────────────────────────────────────────┤
│  User Input → Transport → Session → Memory → RAG → LLM → Output  │
└─────────────────────────────────────────────────────────────┘
```

---

## Pipeline Architecture

### Complete Flow

```
User Input
    │
    ▼
Transport Layer (STDIO / WebSocket)
    │
    ▼
Session Manager (Session ID, User Context)
    │
    ├──► Pipeline 1: Memory (SQLite / Fallback)
    │        │
    │        ▼
    │    Fetch History → Inject Context
    │
    ├──► Pipeline 2: RAG (SSOT.md + Vector Index)
    │        │
    │        ▼
    │    Scan Workspace → Build Prompt
    │
    ├──► Pipeline 3: Tool Registry
    │        │
    │        ▼
    │    Auto-detect Tool → Execute → Return Result
    │
    ▼
Final Prompt → LLM / Model
    │
    ▼
Function Calling (if needed) → Tool Execution → LLM Reflection
    │
    ▼
Response via Transport to Client
```

---

## Pipeline 1: Resilient Memory Management

### Architecture

```
┌─────────────────────────────────────────────────┐
│              SessionManager                       │
│  (Receives user input, assigns session ID)       │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              SQLiteMemory (Primary)               │
│  - Persistent chat history in local DB           │
│  - WAL mode for concurrent reads                 │
│  - Automatic session management                  │
└──────────────────────┬──────────────────────────┘
                       │ (on failure)
                       ▼
┌─────────────────────────────────────────────────┐
│           FallbackMemory (Emergency)              │
│  - LangChain ConversationBufferMemory            │
│  - RAM-based temporary context                   │
│  - Auto-activates on SQLite lock/error           │
└─────────────────────────────────────────────────┘
```

### SQLite Schema

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  role TEXT CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  model_used TEXT,
  tokens_used INTEGER DEFAULT 0,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

### Fallback Strategy

| Condition | Action |
|-----------|--------|
| SQLite OK | Use SQLite (persistent) |
| SQLite locked | Activate FallbackMemory (RAM) |
| SQLite I/O error | Activate FallbackMemory (RAM) |
| RAM full | Log warning, continue with truncated context |

---

## Pipeline 2: Dynamic Prompt Ingestion & RAG

### Components

```
┌─────────────────────────────────────────────────┐
│              RagChainManager                      │
│  - Scans current workspace                       │
│  - Detects project type (Laravel, Node, etc.)    │
│  - Generates SSOT.md if missing                  │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              SystemPrompt.ts                      │
│  Aggregates 3 sources into SSOT prompt:          │
│                                                   │
│  1. Global System Identity (immutable)           │
│  2. RAG Context (real-time file scan)            │
│  3. User Query (current request)                 │
└─────────────────────────────────────────────────┘
```

### SSOT.md Template

```markdown
# {ProjectName} — Project Documentation

> Auto-generated by ZombieCoder Agent
> Last updated: {timestamp}

## Project Structure
{directory tree}

## Key Files
{file summaries}

## Configuration
{config files content}

## Dependencies
{package.json / composer.json summary}
```

---

## Pipeline 3: Tool Registry & Execution

### Tool Categories

```
┌─────────────────────────────────────────────────┐
│              ToolRegistry (Singleton)              │
├─────────────────────────────────────────────────┤
│                                                   │
│  📁 File System Tools                             │
│  ├── read_file      (cross-platform)             │
│  ├── list_files     (recursive, filtered)        │
│  ├── find_files     (by name pattern)            │
│  ├── search_code    (content search)             │
│  ├── write_file     (with auto-mkdir)            │
│  └── get_file_info  (metadata)                   │
│                                                   │
│  🔍 Search Tools                                  │
│  └── web_search     (DuckDuckGo, no API key)     │
│                                                   │
│  💻 Shell Tools                                   │
│  ├── run_command    (auto-shell detection)        │
│  └── get_platform_info                            │
│                                                   │
└─────────────────────────────────────────────────┘
```

### DuckDuckGo Search Integration

```typescript
// No API key required!
const results = await searchDuckDuckGo({
  query: "Laravel 10 migration best practices",
  limit: 5,
  region: "wt-wt",  // world-wide
});
```

**How it works:**
1. Primary: DuckDuckGo Instant Answer API (`api.duckduckgo.com`)
2. Fallback: DuckDuckGo Lite HTML (`lite.duckduckgo.com`)
3. No rate limiting for reasonable use
4. Returns: title, URL, snippet

### Cross-Platform File Tools

| Platform | Shell | Path Style | Example |
|----------|-------|------------|---------|
| Windows | PowerShell | `C:\Users\...` | `read_file({ path: "C:\\project\\file.ts" })` |
| Linux | bash | `/home/user/...` | `read_file({ path: "/home/user/project/file.ts" })` |
| macOS | bash | `/Users/...` | `read_file({ path: "/Users/user/project/file.ts" })` |

### Tool Auto-Detection

The agent automatically detects which tool to use from natural language:

| User Says | Tool Triggered |
|-----------|----------------|
| "search for Laravel docs" | `web_search` |
| "read file composer.json" | `read_file` |
| "list files in src" | `list_files` |
| "find files named Controller" | `find_files` |
| "search code for function name" | `search_code` |
| "run git status" | `run_command` |
| "what platform am I on" | `get_platform_info` |

---

## Pipeline 4: Dual Transport Architecture

### STDIO Transport (MCP Standard)

```
┌──────────────┐     STDIO      ┌──────────────┐
│   IDE/CLI    │ ◄────────────► │  MCP Server  │
│  (JetBrains) │   stdin/stdout │  (port: stdio)│
└──────────────┘                └──────────────┘
```

- Model Context Protocol (MCP) compliant
- Standard input/output communication
- Used by IDE plugins (JetBrains, VS Code)

### HTTP/WebSocket Transport

```
┌──────────────┐     HTTP       ┌──────────────┐
│   Browser    │ ◄────────────► │  HTTP Server │
│  Dashboard   │   REST/WebSocket│  (port: 9999)│
└──────────────┘                └──────────────┘
```

- REST API endpoints
- WebSocket for real-time streaming
- Used by web dashboards and custom clients

### Transport Selection

```
if (client.type === "ide") {
  use StdioTransport();
} else if (client.type === "web") {
  use HttpTransport();
} else {
  use HttpTransport(); // default
}
```

---

## Cross-Platform Support

### Platform Detection

```typescript
import { getPlatform, isWindows, isLinux } from "./tools/FileTools";

const platform = getPlatform(); // "win32" | "linux" | "darwin"

if (isWindows()) {
  // Use PowerShell commands
  // Handle backslash paths
} else {
  // Use bash commands
  // Handle forward slash paths
}
```

### Path Normalization

```typescript
import { normalizePath, convertPath } from "./tools/FileTools";

// Auto-normalize for current platform
const path = normalizePath("C:/Users/test/file.ts");
// On Windows: "C:\Users\test\file.ts"
// On Linux: "/home/test/file.ts"

// Convert between platforms
const winPath = convertPath("/home/user/file.ts", "win32");
// Result: "\\home\\user\\file.ts"
```

### Shell Command Conversion

| Unix Command | PowerShell Equivalent |
|--------------|----------------------|
| `ls -la` | `Get-ChildItem -Force` |
| `cat file.txt` | `Get-Content file.txt` |
| `grep "pattern" file` | `Select-String "pattern" file` |
| `cp src dest` | `Copy-Item src dest` |
| `rm file` | `Remove-Item file` |
| `mkdir dir` | `New-Item -ItemType Directory dir` |
| `pwd` | `Get-Location` |
| `echo "text"` | `Write-Output "text"` |

---

## SSOT Flag Auto-Init System

### Flag States

| Flag | State | Description |
|------|-------|-------------|
| 0 | Not Scanned | Directory never indexed |
| 1 | Scanning | Currently being scanned |
| 2 | Indexed | SSOT.md generated and up-to-date |
| 3 | Error | Scan failed |

### Auto-Init Flow

```
Agent receives user query
    │
    ▼
Check SSOT Flag for current directory
    │
    ├── Flag = 0 or 3 (Not scanned / Error)
    │       │
    │       ▼
    │   Auto-call init()
    │       │
    │       ▼
    │   Scan project structure
    │   Generate SSOT.md
    │   Set flag = 2
    │
    ├── Flag = 1 (Scanning)
    │       │
    │       ▼
    │   Wait for scan complete
    │
    └── Flag = 2 (Indexed)
            │
            ▼
        Use existing SSOT.md
        (no re-scan needed)
```

### Implementation

```typescript
// In ToolRegistry or Agent
async function ensureSSOT(directory: string): Promise<void> {
  const flag = getSSOTFlag(directory);
  
  if (flag === 0 || flag === 3) {
    // Auto-init
    setSSOTFlag(directory, 1); // scanning
    try {
      await scanProject(directory);
      await generateSSOT(directory);
      setSSOTFlag(directory, 2); // indexed
    } catch (error) {
      setSSOTFlag(directory, 3); // error
    }
  }
}
```

---

## API Reference

### ToolRegistry

```typescript
import { ToolRegistry } from "./tools/ToolRegistry";

const registry = ToolRegistry.getInstance();

// Get all tools for LLM
const tools = registry.getOpenAITools();

// Execute a tool
const result = await registry.executeTool("web_search", {
  query: "Laravel 10"
});

// Auto-detect tool from query
const autoResult = await registry.autoDetectAndExecute(
  "search for React hooks documentation"
);

// Get status
const status = registry.getStatus();
```

### DuckDuckGo Search

```typescript
import { searchDuckDuckGo } from "./tools/DuckDuckGoSearch";

const results = await searchDuckDuckGo({
  query: "TypeScript best practices",
  limit: 5,
  region: "wt-wt",
  timeout: 10000,
});
```

### File Tools

```typescript
import { readFile, listFiles, searchInFiles } from "./tools/FileTools";

// Read file (cross-platform)
const content = await readFile("C:\\project\\file.ts");

// List files recursively
const files = await listFiles("./src", {
  recursive: true,
  maxDepth: 5,
  pattern: ".ts",
});

// Search code content
const matches = await searchInFiles("./src", "function name", {
  filePattern: ".ts",
  maxResults: 50,
});
```

### Shell Tools

```typescript
import { executeCommandSync, getPlatform } from "./tools/ShellTools";

// Execute command (auto-detects shell)
const result = executeCommandSync({
  command: "git status",
  cwd: "/path/to/project",
  timeout: 10000,
});

console.log(result.platform); // "win32" | "linux" | "darwin"
console.log(result.shell);    // "powershell.exe" | "/bin/bash"
```

---

## Deployment

### Dependencies

```json
{
  "dependencies": {
    "@ai-sdk/openai-compatible": "^2.0.0",
    "ai": "^6.0.205",
    "better-sqlite3": "^12.10.1"
  }
}
```

### Build & Run

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Start agent
npm start
```

### Environment Variables

```env
# Memory DB path (auto-created)
AGENT_MEMORY_DB_PATH=./agent_memory.db

# LLM API
OPENCODE_API_KEY=free-tier
OPENCODE_API_BASE=http://localhost:9999/v1

# DuckDuckGo (no key needed)
# Works out of the box!
```

---

## Summary

| Component | Status | Notes |
|-----------|--------|-------|
| Memory (SQLite) | ✅ Working | Persistent, WAL mode |
| Memory (Fallback) | ✅ Working | RAM-based, auto-activates |
| DuckDuckGo Search | ✅ Working | No API key, cross-platform |
| File Tools | ✅ Working | Windows/Linux/macOS |
| Shell Tools | ✅ Working | Auto-shell detection |
| SSOT Auto-Init | ✅ Working | Flag-based, self-healing |
| STDIO Transport | ✅ Working | MCP compliant |
| HTTP Transport | ✅ Working | REST + WebSocket |

---

*Generated by ZombieCoder Agent System*
