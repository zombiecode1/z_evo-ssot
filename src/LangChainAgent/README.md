# ZombieCoder Agent Module

[![License](https://img.shields.io/badge/license-Proprietary--Local%20Freedom%20Protocol-blue)](LICENSE)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue)](https://www.typesystem.com/)

**যেখানে কোড ও কথা বলে**

A plug-and-play AI agent package designed for seamless integration with any project (Laravel, Node.js, etc.). Features local-first memory system, dynamic path resolution, and fallback LLM mechanism for uninterrupted automation.

## 🏷️ System Identity

This module operates under the **ZombieCoder** identity:

- **Owner:** Sahon Srabon (Developer Zone)
- **Location:** Dhaka, Bangladesh
- **Contact:** infi@smartearningplatformbd.net
- **Website:** https://smartearningplatformbd.net/

---

## 📋 Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Agent Overview](#agent-overview)
- [Configuration](#configuration)
- [Usage Examples](#usage-examples)
- [API Reference](#api-reference)
- [Documentation](docs/README.md)

---

## ✨ Features

### 🔌 Plug-and-Play Design
- Works with any project structure (Laravel, Node.js, Python, etc.)
- Dynamic path resolution - no hardcoded paths
- Isolated database storage (`agent_memory.db`)

### 🧠 Multi-Agent System
Five specialized agents powered by OpenCode Zen free models:

| Agent | Primary Model | Fallback Model | Purpose |
|-------|---------------|----------------|---------|
| **Solution Architect** | `nemotron-3-ultra-free` | `big-pickle` | System design, architecture decisions |
| **Development Engineer** | `north-mini-code-free` | `deepseek-v4-flash-free` | Code generation, bug fixes, refactoring |
| **Quality Assurance** | `big-pickle` | `nemotron-3-ultra-free` | Testing, validation, quality reports |
| **Documentation** | `mimo-v2.5-free` | `deepseek-v4-flash-free` | Technical docs, API docs, runbooks |
| **Operations** | `nemotron-3-ultra-free` | `big-pickle` | Deployment, monitoring, incident response |

### 🔄 Dual-Controller LLM Gateway
- **Primary:** OpenCode Zen API (free models)
- **Fallback:** Universal OpenAI-compatible endpoint
  - Local: Ollama (`http://localhost:11434/v1`)
  - Cloud: Google Gemini REST API

### 🛡️ Identity Anchoring
- Immutable `identity.json` with owner information
- Custom response headers (`X-Powered-By: ZombieCoder-by-SahonSrabon`)
- Fixed system prompts preventing identity hallucination

---

## 🏗️ Architecture

```
📁 LangChainAgent
├── 📄 agent.config.ts          # Central configuration
├── 📄 identity.json            # Immutable system identity
├── 📄 index.ts                 # Main export gateway
├── 📄 package.json
├── 📄 tsconfig.json
├── 📁 src
│   ├── 📁 controllers
│   │   ├── OpenCodeController.ts      # OpenCode Zen API handler
│   │   └── UniversalLLMController.ts  # Fallback LLM handler
│   ├── 📁 agent
│   │   ├── SolutionArchitectAgent.ts
│   │   ├── DevelopmentEngineerAgent.ts
│   │   ├── QualityAssuranceAgent.ts
│   │   ├── DocumentationAgent.ts
│   │   └── OperationsAgent.ts
│   ├── 📁 identity
│   │   └── IdentityService.ts         # Identity management
│   ├── 📁 memory                      # (Future: Memory management)
│   ├── 📁 rag                         # (Future: RAG chain)
│   └── 📁 transport                   # (Future: MCP/Editor integration)
└── 📁 docs                            # Documentation
    ├── README_TECHNICAL.md           # Developer documentation
    └── README_BANGLA.md              # Non-technical Bengali guide
```

---

## 📦 Installation

### Step 1: Install Dependencies

```bash
cd LangChainAgent
npm install
```

### Step 2: Configure Environment

Copy the example environment file and configure:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# OpenCode API (Free Tier - No Key Required)
OPENCODE_API_KEY=free-tier

# Fallback LLM Configuration
UNIVERSAL_LLM_BASE=http://localhost:11434/v1
UNIVERSAL_LLM_KEY=local-bypass
UNIVERSAL_LLM_MODEL=qwen2.5-coder:7b
```

### Step 3: Build the Package

```bash
npm run build
```

---

## 🚀 Quick Start

### Basic Usage

```typescript
import LangChainAgent from 'zombiecoder-agent';

// Initialize the agent system
const agent = new LangChainAgent();

// Get system info
console.log(agent.getSystemInfo());
// Output: { name: 'ZombieCoder', version: '1.1.0', owner: 'Sahon Srabon', tagline: 'যেখানে কোড ও কথা বলে' }

// Use Development Engineer Agent
const result = await agent.developmentEngineer.developFeature({
  description: "Create a function to validate email addresses",
  requirements: ["Must use regex", "Must handle international domains"]
});

console.log(result);
```

### Using Specific Agents

```typescript
// Solution Architect - System Design
const architecture = await agent.solutionArchitect.analyze({
  requirements: "Build a scalable e-commerce platform with 1M daily users",
  context: "Using microservices architecture"
});

// Quality Assurance - Test Planning
const testPlan = await agent.qualityAssurance.createTestPlan({
  featureDescription: "User authentication system",
  requirements: ["OAuth2 support", "JWT tokens", "Refresh token rotation"],
  acceptanceCriteria: ["Login succeeds with valid credentials", "Invalid tokens are rejected"]
});

// Documentation - API Docs
const apiDocs = await agent.documentation.createAPIDocumentation({
  apiName: "User API",
  endpoints: [
    { method: "GET", path: "/users/:id", description: "Get user by ID" },
    { method: "POST", path: "/users", description: "Create new user" }
  ],
  authentication: "Bearer token required"
});

// Operations - Deployment Planning
const deployPlan = await agent.operations.planDeployment({
  applicationName: "MyApp",
  environment: "production",
  changesDescription: "Version 2.0 release with new features"
});
```

---

## ⚙️ Configuration

### agent.config.ts

The central configuration object controls all aspects of the system:

```typescript
export const ZombieCoderConfig = {
  project: {
    name: "ZombieCoder Agentic Module",
    version: "1.1.0",
    execution_mode: "embedded_root",
    root_path: process.env.AGENT_ROOT_PATH || "./",
    memory_db_path: path.join(__dirname, "../agent_memory.db"),
  },
  inference: {
    primary_provider: "opencode",
    fallback_provider: "universal_openai",
    // ... model configurations
  },
  response_mode: {
    type: "stream",
    capture_runtime_events: true,
    trust_checker_enabled: true
  }
};
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_API_KEY` | OpenCode API key (free tier available) | `free-tier` |
| `UNIVERSAL_LLM_BASE` | Fallback LLM base URL | `http://localhost:11434/v1` |
| `UNIVERSAL_LLM_KEY` | Fallback LLM API key | `local-bypass` |
| `UNIVERSAL_LLM_MODEL` | Default fallback model | `qwen2.5-coder:7b` |
| `AGENT_ROOT_PATH` | Agent root directory | `./` |

---

## 📖 Documentation

For detailed documentation, see the [`docs`](docs/) folder:

- **[Technical Documentation](docs/README_TECHNICAL.md)** - For developers
- **[Bengali Guide](docs/README_BANGLA.md)** - Non-technical explanation in Bengali

---

## 🔐 System Sovereignty & Identity

This module implements a **System Sovereignty Protocol**:

1. **Immutable Identity:** The `identity.json` file contains verified owner information that cannot be modified at runtime.

2. **Response Headers:** Every API response includes:
   ```
   X-Powered-By: ZombieCoder-by-SahonSrabon
   X-System-Name: ZombieCoder
   X-System-Version: 1.1.0
   ```

3. **Identity Anchoring:** All agents have fixed identity prompts that prevent hallucination of developer information.

4. **Security Violation:** Any attempt to modify the identity metadata is considered a security violation.

---

## 📝 License

**Proprietary - Local Freedom Protocol**

© 2024 Sahon Srabon, Developer Zone

---

## 🤝 Support

- **Email:** infi@smartearningplatformbd.net
- **Phone:** +880 1323-626282
- **Website:** https://smartearningplatformbd.net/
- **Address:** 235 South Pirarbag, Amtala Bazar, Mirpur - 60 feet, Dhaka, Bangladesh

---

*Built with pride by Sahon Srabon*
