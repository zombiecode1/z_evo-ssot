# ZombieCoder Agent Module - Technical Documentation

## Overview
A plug-and-play AI agent module with multi-agent support, built on LangChain and Vercel AI SDK.

## Installation
```bash
npm install zombiecoder-agent-module
```

## Quick Start
```typescript
import { createZombieCoderAgent } from 'zombiecoder-agent-module';

const agent = createZombieCoderAgent({
  userId: 'user-123',
  conversationId: 'conv-456',
});

// Execute task with specific agent role
const result = await agent.executeTask('development-engineer', 'Fix this bug...');
console.log(result.response.text);
```

## Available Agents
1. **Solution Architect** - System design and architecture
2. **Development Engineer** - Code implementation and debugging
3. **Quality Assurance** - Testing and validation
4. **Documentation** - Technical writing
5. **Operations** - Deployment and monitoring

## Model Configuration
- Primary: OpenCode Zen (free models)
- Fallback: Universal LLM (Ollama, Gemini, etc.)

## Environment Variables
```bash
UNIVERSAL_LLM_BASE=http://localhost:11434/v1
UNIVERSAL_LLM_KEY=your-api-key
UNIVERSAL_LLM_MODEL=qwen2.5-coder:7b
```

## API Reference
See `src/index.ts` for full API documentation.
