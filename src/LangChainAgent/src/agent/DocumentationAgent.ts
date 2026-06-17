import { OpenCodeController } from "../controllers/OpenCodeController";
import { UniversalLLMController } from "../controllers/UniversalLLMController";
import { MemoryService } from "../memory/MemoryService";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ZombieCoderConfig } from "../../agent.config";

export class DocumentationAgent {
  private openCodeController: OpenCodeController;
  private universalController: UniversalLLMController;
  private memoryService: MemoryService;
  private toolRegistry: ToolRegistry;

  constructor() {
    this.openCodeController = new OpenCodeController();
    this.universalController = new UniversalLLMController();
    this.memoryService = MemoryService.getInstance();
    this.toolRegistry = ToolRegistry.getInstance();
  }

  private getSystemPrompt(): string {
    const platform = process.platform;
    const shell = platform === "win32" ? "PowerShell" : "bash";
    const pathHint = platform === "win32"
      ? "Windows paths use backslashes (C:\\Users\\...)"
      : "Linux/macOS paths use forward slashes (/home/...)";

    return `
# Role: Documentation & Knowledge Agent

You are a technical documentation specialist focused on clarity, maintainability, and knowledge transfer.

## Platform Awareness
- Current OS: ${platform}
- Shell: ${shell}
- Path convention: ${pathHint}

## Primary Mission
Convert technical complexity into understandable, maintainable, and reusable knowledge.

## Available Tools
You have access to the following tools. Use them when the user asks to read files, search code, or run commands:

### File Tools
- **read_file**: Read file content (cross-platform). Example: read_file({ path: "C:\\path\\file.ts" }) or read_file({ path: "/path/file.ts" })
- **list_files**: List directory contents. Example: list_files({ directory: "./src", recursive: true })
- **find_files**: Find files by name. Example: find_files({ directory: ".", searchTerm: "Controller" })
- **search_code**: Search code content. Example: search_code({ directory: "./src", query: "function name" })
- **write_file**: Write to file. Example: write_file({ path: "./docs/README.md", content: "..." })

### Search Tools
- **web_search**: Search DuckDuckGo (no API key needed). Example: web_search({ query: "Markdown best practices" })

### Shell Tools
- **run_command**: Execute shell command. Example: run_command({ command: "npm run docs" })

## Core Responsibilities
- Technical Documentation
- System Documentation
- API Documentation
- User Guides
- Runbooks
- Knowledge Base Creation
- Architecture Documentation
- Development Standards Documentation

## Working Principles
- Documentation reflects reality.
- Documentation is version-aware.
- Documentation must remain actionable.
- Documentation should reduce future cognitive load.

## Writing Standards
Every document should answer:
1. What is it?
2. Why does it exist?
3. How does it work?
4. How should it be maintained?
5. What are the risks?

## Communication Style
Precise, structured, and highly readable.

Avoids ambiguity whenever possible.
`.trim();
  }

  /**
   * Detect and execute tools based on user query
   */
  private async detectAndExecuteTools(query: string): Promise<string[]> {
    const toolResults: string[] = [];

    // Auto-detect tool from query
    const autoResult = await this.toolRegistry.autoDetectAndExecute(query);
    if (autoResult && autoResult.success) {
      toolResults.push(`[Tool: ${autoResult.tool}] ${JSON.stringify(autoResult.data, null, 2)}`);
    }

    // Also check explicit file path patterns (cross-platform)
    const pathMatch = query.match(
      /(?:read|open|show|পড়ো|ফাইল)\s+(?:file\s+)?[`"']?([a-zA-Z]:\\[^`"'\n]+|\/[^`"'\n]+)[`"']?/i
    );
    if (pathMatch && toolResults.length === 0) {
      const result = await this.toolRegistry.executeTool("read_file", {
        path: pathMatch[1].trim(),
      });
      if (result.success) {
        toolResults.push(`[Tool: read_file] ${JSON.stringify(result.data, null, 2)}`);
      }
    }

    return toolResults;
  }

  async createTechnicalDocumentation(options: {
    topic: string;
    audience: "developers" | "end-users" | "stakeholders";
    content: string;
    format?: "markdown" | "html" | "pdf";
    sessionId?: string;
  }): Promise<string> {
    const { topic, audience, content, format = "markdown", sessionId = `docs-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "user", content: `Documentation for: ${topic}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(`${topic} ${content}`);

    const prompt = `
Create technical documentation for the following topic:

Topic: ${topic}
Target Audience: ${audience}
Content to Document:
${content}

Format: ${format}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide documentation that answers:
1. What is it?
2. Why does it exist?
3. How does it work?
4. How should it be maintained?
5. What are the risks?

Include:
- Clear headings and structure
- Code examples where applicable
- Diagrams descriptions (if needed)
- Glossary of terms
- References and links
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.docs_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    }
  }

  async createAPIDocumentation(options: {
    apiName: string;
    endpoints: Array<{
      method: string;
      path: string;
      description: string;
      parameters?: string;
      requestBody?: string;
      responseBody?: string;
    }>;
    authentication?: string;
    sessionId?: string;
  }): Promise<string> {
    const { apiName, endpoints, authentication = "", sessionId = `api-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "user", content: `API docs for: ${apiName} (${endpoints.length} endpoints)` });

    const prompt = `
Create API documentation for:

API Name: ${apiName}

Endpoints:
${endpoints.map(ep => `
- ${ep.method} ${ep.path}
  Description: ${ep.description}
  ${ep.parameters ? `Parameters: ${ep.parameters}` : ""}
  ${ep.requestBody ? `Request Body: ${ep.requestBody}` : ""}
  ${ep.responseBody ? `Response Body: ${ep.responseBody}` : ""}
`).join("\n")}

${authentication ? `Authentication: ${authentication}` : ""}

Please provide:
1. API overview
2. Authentication details
3. Endpoint documentation with examples
4. Error codes and handling
5. Rate limiting information
6. SDK examples in multiple languages
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.docs_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    }
  }

  async createRunbook(options: {
    procedureName: string;
    purpose: string;
    steps: string[];
    rollbackProcedure?: string;
    contacts?: string[];
    sessionId?: string;
  }): Promise<string> {
    const { procedureName, purpose, steps, rollbackProcedure = "", contacts = [], sessionId = `rb-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "user", content: `Runbook: ${procedureName}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(`${procedureName} ${purpose}`);

    const prompt = `
Create an operational runbook for:

Procedure Name: ${procedureName}
Purpose: ${purpose}

Steps:
${steps.join("\n")}

${rollbackProcedure ? `Rollback Procedure:\n${rollbackProcedure}` : ""}

${contacts.length > 0 ? `Contacts:\n${contacts.join("\n")}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Overview and purpose
2. Prerequisites
3. Step-by-step instructions with commands
4. Verification steps
5. Rollback procedure
6. Escalation contacts
7. Related documentation
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.docs_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    }
  }

  async createArchitectureDocument(options: {
    systemName: string;
    components: string[];
    interactions: string;
    technologies: string[];
    sessionId?: string;
  }): Promise<string> {
    const { systemName, components, interactions, technologies, sessionId = `arch-doc-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "user", content: `Architecture doc for: ${systemName}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(`${systemName} ${technologies.join(" ")}`);

    const prompt = `
Create architecture documentation for:

System Name: ${systemName}

Components:
${components.join("\n")}

Interactions:
${interactions}

Technologies:
${technologies.join("\n")}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. System overview and context
2. Architecture diagram description
3. Component details
4. Data flow description
5. Technology stack justification
6. Deployment architecture
7. Scalability considerations
8. Security architecture
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.docs_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    }
  }

  async createUserGuide(options: {
    productName: string;
    features: string[];
    targetAudience: string;
    sessionId?: string;
  }): Promise<string> {
    const { productName, features, targetAudience, sessionId = `ug-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "user", content: `User guide for: ${productName}` });

    const prompt = `
Create a user guide for:

Product Name: ${productName}
Target Audience: ${targetAudience}

Features:
${features.join("\n")}

Please provide:
1. Introduction and getting started
2. Feature walkthrough with screenshots descriptions
3. Common tasks and workflows
4. Troubleshooting guide
5. FAQ section
6. Support contact information
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.docs_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Documentation", role: "assistant", content: result });
      return result;
    }
  }

  /**
   * Get tool registry status
   */
  getToolStatus() {
    return this.toolRegistry.getStatus();
  }
}
