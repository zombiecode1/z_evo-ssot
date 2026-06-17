# ZombieCoder Agent - Technical Documentation

## For Developers

This document provides comprehensive technical documentation for integrating and extending the ZombieCoder Agent module.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Installation Guide](#installation-guide)
3. [Integration with Existing Projects](#integration-with-existing-projects)
4. [API Reference](#api-reference)
5. [Agent Details](#agent-details)
6. [Configuration Options](#configuration-options)
7. [Error Handling](#error-handling)
8. [Testing](#testing)
9. [Deployment](#deployment)
10. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                     LangChainAgent                          │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ IdentityService  │  │ ZombieCoderConfig│                │
│  └──────────────────┘  └──────────────────┘                │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  Agents Layer                        │  │
│  │  ┌─────────┐ ┌──────────┐ ┌──────┐ ┌─────────┐      │  │
│  │  │Architect│ │Engineer  │ │ QA   │ │ Docs    │ ...  │  │
│  │  └─────────┘ └──────────┘ └──────┘ └─────────┘      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │               Controllers Layer                      │  │
│  │  ┌──────────────────┐  ┌──────────────────────┐     │  │
│  │  │ OpenCodeController│  │ UniversalLLMController│    │  │
│  │  └──────────────────┘  └──────────────────────┘     │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Request Initiation:** User calls an agent method
2. **Identity Injection:** System prompt includes immutable identity
3. **Primary LLM Call:** OpenCode Zen API is called first
4. **Fallback Mechanism:** If primary fails, Universal LLM controller handles
5. **Response Delivery:** Result returned with identity headers

---

## Installation Guide

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- TypeScript >= 5.0.0

### Step-by-Step Installation

```bash
# Clone or copy the LangChainAgent folder to your project
cp -r LangChainAgent /path/to/your/project/

# Navigate to the module
cd LangChainAgent

# Install dependencies
npm install

# Build the TypeScript code
npm run build

# Create environment file
cp .env.example .env

# Edit .env with your configuration
nano .env
```

### Verify Installation

```bash
# Run a simple test
node -e "const { LangChainAgent } = require('./dist'); const agent = new LangChainAgent(); console.log(agent.getSystemInfo());"
```

---

## Integration with Existing Projects

### Laravel Integration

```php
// In your Laravel controller
use Illuminate\Support\Facades\Http;

public function getArchitecture(Request $request)
{
    $response = Http::post('http://localhost:3000/api/architect', [
        'requirements' => $request->input('requirements')
    ]);
    
    return response()->json($response->json());
}
```

### Node.js Integration

```typescript
// Express.js example
import express from 'express';
import LangChainAgent from './LangChainAgent';

const app = express();
const agent = new LangChainAgent();

app.post('/api/architect', async (req, res) => {
  try {
    const result = await agent.solutionArchitect.analyze(req.body);
    res.set(agent.getResponseHeaders());
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Python Integration

```python
# Using subprocess or HTTP requests
import requests

def get_code_review(code: str) -> dict:
    response = requests.post(
        'http://localhost:3000/api/review',
        json={'code': code},
        headers={'Content-Type': 'application/json'}
    )
    return response.json()
```

---

## API Reference

### LangChainAgent Class

#### Constructor

```typescript
constructor()
```

Initializes all five agents and validates identity.

#### Methods

| Method | Return Type | Description |
|--------|-------------|-------------|
| `getSystemInfo()` | `object` | Returns system identity information |
| `getResponseHeaders()` | `Record<string, string>` | Returns HTTP headers with identity |
| `getConfig()` | `object` | Returns full configuration object |

### SolutionArchitectAgent

```typescript
analyze(options: { requirements: string; context?: string }): Promise<string>
createADR(options: { title: string; context: string; decision: string; consequences: string }): Promise<string>
designDatabase(options: { requirements: string; scale: "small" | "medium" | "large" }): Promise<string>
```

### DevelopmentEngineerAgent

```typescript
developFeature(options: { description: string; existingCode?: string; requirements?: string[] }): Promise<string>
fixBug(options: { bugDescription: string; errorCode: string; errorMessage?: string; stepsToReproduce?: string }): Promise<string>
refactorCode(options: { code: string; goals: string[]; constraints?: string[] }): Promise<string>
reviewCode(options: { code: string; checklist?: string[] }): Promise<string>
```

### QualityAssuranceAgent

```typescript
createTestPlan(options: { featureDescription: string; requirements: string[]; acceptanceCriteria: string[] }): Promise<string>
generateTestCases(options: { functionality: string; testType: "unit" | "integration" | "e2e" | "regression"; framework?: string }): Promise<string>
analyzeDefect(options: { defectDescription: string; severity: string; stepsToReproduce: string; actualResult: string; expectedResult: string }): Promise<string>
performRegressionAnalysis(options: { changesDescription: string; affectedAreas: string[] }): Promise<string>
generateQualityReport(options: { projectContext: string; metricsData?: object }): Promise<string>
```

### DocumentationAgent

```typescript
createTechnicalDocumentation(options: { topic: string; audience: string; content: string; format?: string }): Promise<string>
createAPIDocumentation(options: { apiName: string; endpoints: Array<object>; authentication?: string }): Promise<string>
createRunbook(options: { procedureName: string; purpose: string; steps: string[] }): Promise<string>
createArchitectureDocument(options: { systemName: string; components: string[]; interactions: string }): Promise<string>
createUserGuide(options: { productName: string; features: string[]; targetAudience: string }): Promise<string>
```

### OperationsAgent

```typescript
planDeployment(options: { applicationName: string; environment: string; changesDescription: string }): Promise<string>
designMonitoring(options: { systemName: string; components: string[]; criticalMetrics: string[] }): Promise<string>
createIncidentResponsePlan(options: { scenarioType: string; severity: string; affectedSystems: string[] }): Promise<string>
designBackupStrategy(options: { dataTypes: string[]; retentionPeriod: string; rto: string; rpo: string }): Promise<string>
performInfrastructureReview(options: { currentSetup: string; requirements: string[] }): Promise<string>
```

---

## Agent Details

### Model Mapping

| Agent | Primary Model | Fallback Model | Use Case |
|-------|---------------|----------------|----------|
| Solution Architect | `nemotron-3-ultra-free` | `big-pickle` | Complex system design |
| Development Engineer | `north-mini-code-free` | `deepseek-v4-flash-free` | Code generation |
| Quality Assurance | `big-pickle` | `nemotron-3-ultra-free` | Analysis & testing |
| Documentation | `mimo-v2.5-free` | `deepseek-v4-flash-free` | Writing tasks |
| Operations | `nemotron-3-ultra-free` | `big-pickle` | Infrastructure planning |

### Fallback Logic

```typescript
try {
  // Try OpenCode Zen first
  return await openCodeController.generateText({...});
} catch (error) {
  // Fallback to Universal LLM (Ollama/Gemini)
  return await universalController.generateText({...});
}
```

---

## Configuration Options

### Full Configuration Object

```typescript
{
  project: {
    name: "ZombieCoder Agentic Module",
    version: "1.1.0",
    execution_mode: "embedded_root",
    root_path: "./",
    memory_db_path: "./agent_memory.db"
  },
  inference: {
    primary_provider: "opencode",
    fallback_provider: "universal_openai",
    opencode: {
      api_base: "https://opencode.ai/zen/v1",
      default_model: "deepseek-v4-flash-free",
      models: { /* agent-specific models */ },
      fallback_models: { /* fallback per agent */ }
    },
    universal_openai: {
      api_base: "http://localhost:11434/v1",
      api_key: "local-bypass",
      default_model: "qwen2.5-coder:7b"
    }
  },
  response_mode: {
    type: "stream",
    capture_runtime_events: true,
    trust_checker_enabled: true
  }
}
```

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Failed to load identity.json` | File missing or corrupted | Restore from backup |
| `OpenCode API failed` | Network issue or rate limit | Check connection, wait and retry |
| `Universal LLM API failed` | Ollama not running | Start Ollama service |
| `Identity validation failed` | Missing required fields | Check identity.json structure |

### Error Handling Pattern

```typescript
try {
  const result = await agent.developmentEngineer.developFeature({...});
} catch (error) {
  if (error.message.includes('OpenCode')) {
    // Primary provider failed, fallback should have triggered
    console.error('Both providers failed');
  }
  // Handle error appropriately
}
```

---

## Testing

### Unit Tests

```typescript
// __tests__/agent.test.ts
import { LangChainAgent } from '../index';

describe('LangChainAgent', () => {
  let agent: LangChainAgent;

  beforeEach(() => {
    agent = new LangChainAgent();
  });

  test('should initialize with correct identity', () => {
    const info = agent.getSystemInfo();
    expect(info.name).toBe('ZombieCoder');
    expect(info.owner).toBe('Sahon Srabon');
  });

  test('should return correct headers', () => {
    const headers = agent.getResponseHeaders();
    expect(headers['X-Powered-By']).toContain('ZombieCoder');
  });
});
```

### Running Tests

```bash
npm test
```

---

## Deployment

### Production Checklist

- [ ] Set proper `OPENCODE_API_KEY` if using premium tier
- [ ] Configure fallback LLM endpoint
- [ ] Set `NODE_ENV=production`
- [ ] Enable logging
- [ ] Set up monitoring
- [ ] Configure rate limiting
- [ ] Backup `identity.json`

### Docker Deployment

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY identity.json ./identity.json

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

---

## Troubleshooting

### Issue: Agents returning empty responses

**Solution:** Check OpenCode API connectivity:
```bash
curl https://opencode.ai/zen/v1/models
```

### Issue: Identity not appearing in responses

**Solution:** Verify `identity.json` exists and is valid JSON:
```bash
node -e "console.log(require('./identity.json'))"
```

### Issue: Fallback not triggering

**Solution:** Ensure Universal LLM endpoint is accessible:
```bash
curl http://localhost:11434/v1/models
```

---

## Support

For technical support:
- **Email:** infi@smartearningplatformbd.net
- **GitHub Issues:** https://github.com/zombiecoder/langchain-agent/issues

---

*© 2024 Sahon Srabon, Developer Zone*
