# 🧟 ZombieCoder

**Where Lost Dreams Come Alive Again**

> "In a society where talented dreams are destroyed for lack of opportunity, where skilled people are mentally defeated — ZombieCoder rises as a beacon of hope."

---

## 💔 The Story Behind the Name

"Zombie" here doesn't mean a corpse. It represents millions of people who:

- 💔 Have **dreams** but **no resources**
- 🎯 Have **skills** but **no recognition**
- 😔 Are slowly becoming "zombies" — mentally defeated
- 🌟 Still believe: **"I can try, even if I fail"**

**ZombieCoder** is for those who refuse to give up.

---

## 🌟 Real Life Stories

### Rashid — A Freelancer (Dhaka)

> "I've been freelancing for 3 years. Working until 2 AM every night. But clients say — 'Your work isn't good enough', 'I'll get someone else.' One night, tears came to my eyes while working. That's when I realized — I'm slowly becoming a 'zombie.' Then I found ZombieCoder. It told me — 'If you keep trying, I'm with you.' Now I'm learning something new every day. I'm no longer a 'zombie.'"

### Nadia — A Student (Chittagong)

> "I'm studying Computer Science. I've given up many times trying to learn programming. Teachers say — 'No time for students like you.' Friends say — 'You can't do it.' One day I used ZombieCoder. It explained everything step by step. No judgment, no ridicule. Just patient explanation. Today I built my first website. I did it!"

### Kamal — A Small Business Owner (Sylhet)

> "I have a small shop. I want to sell online but don't know how. I told my daughter — 'Dad, make me a website.' She said — 'Dad, I can't.' Then a friend said — 'There's ZombieCoder, it'll help.' I didn't believe it. But I tried. Today I have my own website. I'm selling online. My daughter is now proud — 'Dad, you did it!'"

---

## 🔍 "Local First" — The Truth

> "Nothing in this world is truly local. Your computer's motherboard is Intel, graphics card NVIDIA, operating system Windows, editor VS Code, GitHub, browser Google Chrome — without these, a person can't live in modern society."

**We don't lie.** When we say "Local-First", we mean:

| Aspect | The Truth |
|--------|-----------|
| AI Model | Runs on your computer (local LLM) |
| Data Storage | Stays on your hard drive |
| Conversations | Saved in SQLite file on your computer |
| Network | Works offline (local model) |
| Cost | Completely free |

**What we admit:**
- ❌ Completely local — not possible
- ❌ No data ever leaves — that's a lie
- ✅ You have maximum control over your data

Read more: [Local First — The Truth](docs/local-first.html)

---

## 🚀 Quick Start

### Prerequisites
- Node.js >= 18.0.0
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/zombiecode1/Ssot.git
cd Ssot

# Install dependencies
npm install

# Build
npm run build
npm start

# Start server
npm start
```

That's it! Now open `http://localhost:9999` and talk to ZombieCoder.

---

## 🤖 Our Agents

| Agent | Role | Model |
|-------|------|-------|
| 🏛️ Solution Architect | System design, scalability | nemotron-3-ultra-free |
| 💻 Development Engineer | Code implementation, debugging | north-mini-code-free |
| ✅ Quality Assurance | Testing, validation | big-pickle |
| 📚 Documentation | Technical writing | mimo-v2.5-free |
| ⚙️ Operations | Deployment, monitoring | nemotron-3-ultra-free |

---

## 🛠️ Available Tools (9 Tools)

### 📁 File System Tools (Cross-Platform)

| Tool | Description | Platform |
|------|-------------|----------|
| `read_file` | Read file | Win/Linux/Mac |
| `list_files` | List directory | Win/Linux/Mac |
| `find_files` | Find files | Win/Linux/Mac |
| `search_code` | Search code | Win/Linux/Mac |
| `write_file` | Write file | Win/Linux/Mac |
| `get_file_info` | File info | Win/Linux/Mac |

### 🔍 Search & Shell Tools

| Tool | Description | Feature |
|------|-------------|---------|
| `web_search` | DuckDuckGo search | No API Key needed! |
| `run_command` | Run command | PowerShell/Bash auto-detect |
| `get_platform_info` | System info | OS auto-detect |

---

## 🌐 API Endpoints

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Server health check |
| GET | `/v1/models` | List available models |

### Agent Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/agent/chat` | Chat with agent |
| GET | `/v1/agent/status` | Agent system status |
| GET | `/v1/agent/clients` | Connected clients |
| POST | `/v1/agent/register` | Register editor |
| GET | `/v1/agent/index` | Directory index |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ZombieCoder Agent System                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Memory    │  │    RAG      │  │   Tools     │             │
│  │  (SQLite)   │  │  (SSOT.md)  │  │ (9 Tools)   │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                       │
│         └────────────────┼────────────────┘                       │
│                          │                                        │
│                    ┌─────▼─────┐                                 │
│                    │   Tool    │                                 │
│                    │ Registry  │                                 │
│                    └─────┬─────┘                                 │
│                          │                                        │
│              ┌───────────┼───────────┐                           │
│              │           │           │                            │
│         ┌────▼────┐ ┌────▼────┐ ┌────▼────┐                     │
│         │  File   │ │ Search  │ │  Shell  │                     │
│         │  Tools  │ │ (DDG)   │ │  Tools  │                     │
│         └─────────┘ └─────────┘ └─────────┘                     │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📊 SSOT (Single Source of Truth)

SSOT.md is auto-generated documentation that:

- ✅ Scans your project structure
- ✅ Documents key files and configurations
- ✅ Auto-updates when files change
- ✅ Provides context for all agents

### SSOT Flag System

| Flag | Status | Description |
|------|--------|-------------|
| 0 | Not scanned | Directory never indexed |
| 1 | Scanning | Currently processing |
| 2 | Indexed | SSOT up-to-date |
| 3 | Error | Scan failed |

---

## 🖥️ Editor Configurations

MCP configuration files for various editors are in the `mcp/editor-configs/` directory.
Each editor uses a different format, verified against official documentation:

| Editor | Config File | Format Notes |
|--------|------------|--------------|
| **VS Code** | `mcp/editor-configs/vscode-mcp.json` | Standalone file uses `"servers"` root key (not `"mcp": { "servers" }`) |
| **Windsurf** | `mcp/editor-configs/windsurf-mcp_config.json` | HTTP servers use `"serverUrl"` field, not `"url"` |
| **JetBrains** | `mcp/editor-configs/jetbrains-mcp.json` | Only supports **stdio** transport; HTTP/sse servers require the `mcp-remote` proxy |
| **Zed** | `mcp/editor-configs/zed-settings.json` | Uses `"context_servers"` + `"url"` format |
| **Generic** | `.mcp.json` (root) | Cross-editor format with `mcp-remote` proxy |

### ⚠️ Important: JetBrains mcp-remote Dependency

JetBrains IDEs (IntelliJ IDEA, PhpStorm, WebStorm) only support stdio transport for MCP.
To connect to the ZombieCoder server (which uses HTTP/SSE transport), you need to install and use `mcp-remote` as a proxy:

```bash
# Install mcp-remote globally
npm install -g mcp-remote@latest

# Or use npx (no install needed)
npx -y mcp-remote@latest http://localhost:9999/mcp
```

This is already configured in `mcp/editor-configs/jetbrains-mcp.json` — just point the `.json` file path in your IDE's MCP settings.

---

## 👨‍💻 Developer

**Sahon Srabon**
- 📍 Dhaka, Bangladesh
- 🏢 Developer Zone
- 🌐 [zombiecoder.my.id](https://zombiecoder.my.id/)
- 📧 infi@zombiecoder.my.id
- 📞 +880 1323-626282

---

## 📜 License

Proprietary - Local Freedom Protocol

---

<p align="center">
  <em>"Every failed attempt is one step closer to success."</em>
</p>
