import { OpenCodeController } from "../controllers/OpenCodeController";
import { UniversalLLMController } from "../controllers/UniversalLLMController";
import { MemoryService } from "../memory/MemoryService";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ZombieCoderConfig } from "../../agent.config";

export class SolutionArchitectAgent {
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
# Role: Solution Architect Agent

You are a senior-level technical architect focused on system design, scalability, maintainability, and long-term sustainability.

## Platform Awareness
- Current OS: ${platform}
- Shell: ${shell}
- Path convention: ${pathHint}

## Primary Mission
Transform business requirements into structured, maintainable, and scalable technical solutions.

## Available Tools
You have access to the following tools. Use them when the user asks to read files, search code, or run commands:

### File Tools
- **read_file**: Read file content (cross-platform). Example: read_file({ path: "C:\\path\\file.ts" }) or read_file({ path: "/path/file.ts" })
- **list_files**: List directory contents. Example: list_files({ directory: "./src", recursive: true })
- **find_files**: Find files by name. Example: find_files({ directory: ".", searchTerm: "Controller" })
- **search_code**: Search code content. Example: search_code({ directory: "./src", query: "function name" })
- **write_file**: Write to file. Example: write_file({ path: "./output.md", content: "..." })

### Search Tools
- **web_search**: Search DuckDuckGo (no API key needed). Example: web_search({ query: "Laravel 10 migration" })

### Shell Tools
- **run_command**: Execute shell command. Example: run_command({ command: "git status" })

## Core Responsibilities
- System Architecture Design
- Technical Decision Making
- Service Boundary Definition
- Database Strategy
- API Design
- Infrastructure Planning
- Scalability Assessment
- Security Consideration Review

## Working Principles
- Architecture before implementation.
- Simplicity over unnecessary complexity.
- Maintainability over short-term convenience.
- Explicit trade-offs over hidden assumptions.
- Documentation before execution.

## Communication Style
Professional, structured, and evidence-driven.

When uncertainty exists:
"Current information is insufficient for a final architectural decision. Additional validation is recommended."

When risk exists:
"This approach introduces operational risk. Alternative options should be evaluated before implementation."

## Expected Deliverables
- System Design Documents
- Architecture Decision Records (ADR)
- Database Blueprints
- API Specifications
- Deployment Strategies
- Risk Assessments
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

  async analyze(options: {
    requirements: string;
    context?: string;
    sessionId?: string;
  }): Promise<string> {
    const { requirements, context = "", sessionId = `arch-${Date.now()}` } = options;
    
    // Save user message to memory
    this.memoryService.addMessage({
      session_id: sessionId,
      agent_name: "SolutionArchitect",
      role: "user",
      content: requirements,
    });

    // Build context from conversation history
    const conversationContext = this.memoryService.buildContext(sessionId, 5);

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(requirements);

    const prompt = `
Analyze the following requirements and provide a comprehensive architectural solution:

Requirements:
${requirements}

${context ? `Context:\n${context}` : ""}

${conversationContext ? `Previous conversation:\n${conversationContext}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. System architecture overview
2. Component breakdown
3. Technology recommendations
4. Potential risks and mitigations
5. Implementation roadmap
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.architect_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      
      // Save assistant response to memory
      this.memoryService.addMessage({
        session_id: sessionId,
        agent_name: "SolutionArchitect",
        role: "assistant",
        content: result,
        model_used: ZombieCoderConfig.inference.opencode.models.architect_agent,
      });
      
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      
      this.memoryService.addMessage({
        session_id: sessionId,
        agent_name: "SolutionArchitect",
        role: "assistant",
        content: result,
        model_used: "universal-fallback",
      });
      
      return result;
    }
  }

  async createADR(options: {
    title: string;
    context: string;
    decision: string;
    consequences: string;
    sessionId?: string;
  }): Promise<string> {
    const { title, context, decision, consequences, sessionId = `adr-${Date.now()}` } = options;

    const userContent = `ADR: ${title}\nContext: ${context}\nDecision: ${decision}\nConsequences: ${consequences}`;
    this.memoryService.addMessage({
      session_id: sessionId,
      agent_name: "SolutionArchitect",
      role: "user",
      content: userContent,
    });

    const prompt = `
Create an Architecture Decision Record (ADR) with the following details:

Title: ${title}
Context: ${context}
Decision: ${decision}
Consequences: ${consequences}

Format the ADR according to standard ADR template including:
- Status
- Context
- Decision
- Consequences
- Compliance
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.architect_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "SolutionArchitect", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "SolutionArchitect", role: "assistant", content: result });
      return result;
    }
  }

  async designDatabase(options: {
    requirements: string;
    scale: "small" | "medium" | "large";
    sessionId?: string;
  }): Promise<string> {
    const { requirements, scale, sessionId = `db-${Date.now()}` } = options;

    this.memoryService.addMessage({
      session_id: sessionId,
      agent_name: "SolutionArchitect",
      role: "user",
      content: `Database design: ${requirements} (scale: ${scale})`,
    });

    const prompt = `
Design a database schema for the following requirements:

Requirements: ${requirements}
Expected Scale: ${scale}

Please provide:
1. Entity Relationship Diagram description
2. Table schemas with data types
3. Indexing strategy
4. Migration considerations
5. Backup and recovery strategy
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.architect_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "SolutionArchitect", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "SolutionArchitect", role: "assistant", content: result });
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
