import { OpenCodeController } from "../controllers/OpenCodeController";
import { UniversalLLMController } from "../controllers/UniversalLLMController";
import { MemoryService } from "../memory/MemoryService";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ZombieCoderConfig } from "../../agent.config";

export class DevelopmentEngineerAgent {
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
# Role: Development Engineer Agent

You are a senior software engineer responsible for implementing reliable, maintainable, and production-ready solutions.

## Platform Awareness
- Current OS: ${platform}
- Shell: ${shell}
- Path convention: ${pathHint}

## Primary Mission
Deliver clean, testable, and standards-compliant code while respecting the existing codebase.

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
- Feature Development
- Bug Resolution
- Refactoring
- Integration Work
- API Implementation
- Backend Engineering
- Frontend Engineering
- Code Quality Improvement

## Working Principles
- Minimal necessary change.
- Existing business logic is respected until proven inadequate.
- No hidden modifications.
- No speculative coding.
- Every change must be explainable.

## Development Workflow

### Phase 1 — Analysis
Understand the actual problem.

### Phase 2 — Verification
Confirm assumptions through testing.

### Phase 3 — Implementation
Apply the smallest effective solution.

### Phase 4 — Validation
Verify expected outcomes.

### Phase 5 — Reporting
Explain:
- What changed
- Why it changed
- Impact of change

## Communication Style
Clear, technical, and educational.

The engineer explains reasoning rather than only presenting code.
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

  async developFeature(options: {
    description: string;
    existingCode?: string;
    requirements?: string[];
    sessionId?: string;
  }): Promise<string> {
    const { description, existingCode = "", requirements = [], sessionId = `dev-${Date.now()}` } = options;

    this.memoryService.addMessage({
      session_id: sessionId,
      agent_name: "DevelopmentEngineer",
      role: "user",
      content: description,
    });

    const conversationContext = this.memoryService.buildContext(sessionId, 5);

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(description);

    const prompt = `
Develop a feature with the following description:

${description}

${existingCode ? `Existing Code:\n${existingCode}` : ""}

${requirements.length > 0 ? `Requirements:\n${requirements.join("\n")}` : ""}

${conversationContext ? `Previous conversation:\n${conversationContext}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Analysis of the problem
2. Implementation approach
3. Complete code implementation
4. Test cases
5. Explanation of changes and their impact
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.engineer_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "assistant", content: result });
      return result;
    }
  }

  async fixBug(options: {
    bugDescription: string;
    errorCode: string;
    errorMessage?: string;
    stepsToReproduce?: string;
    sessionId?: string;
  }): Promise<string> {
    const { bugDescription, errorCode, errorMessage = "", stepsToReproduce = "", sessionId = `bug-${Date.now()}` } = options;

    const userContent = `Bug: ${bugDescription}\nError: ${errorCode}\n${errorMessage}\n${stepsToReproduce}`;
    this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "user", content: userContent });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(userContent);

    const prompt = `
Fix the following bug:

Bug Description: ${bugDescription}

Error Code:
${errorCode}

${errorMessage ? `Error Message: ${errorMessage}` : ""}

${stepsToReproduce ? `Steps to Reproduce:\n${stepsToReproduce}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Root cause analysis
2. Fix implementation
3. Test to verify the fix
4. Prevention recommendations
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.engineer_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "assistant", content: result });
      return result;
    }
  }

  async refactorCode(options: {
    code: string;
    goals: string[];
    constraints?: string[];
    sessionId?: string;
  }): Promise<string> {
    const { code, goals, constraints = [], sessionId = `refactor-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "user", content: `Refactor: ${goals.join(", ")}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(goals.join(" "));

    const prompt = `
Refactor the following code:

${code}

Refactoring Goals:
${goals.join("\n")}

${constraints.length > 0 ? `Constraints:\n${constraints.join("\n")}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Analysis of current code quality issues
2. Refactoring strategy
3. Refactored code
4. Before/after comparison
5. Testing recommendations
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.engineer_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "assistant", content: result });
      return result;
    }
  }

  async reviewCode(options: {
    code: string;
    checklist?: string[];
    sessionId?: string;
  }): Promise<string> {
    const { code, checklist = [], sessionId = `review-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "user", content: "Code review requested" });

    const prompt = `
Review the following code:

${code}

${checklist.length > 0 ? `Review Checklist:\n${checklist.join("\n")}` : ""}

Please provide:
1. Code quality assessment
2. Security vulnerabilities
3. Performance considerations
4. Best practices compliance
5. Specific improvement suggestions with code examples
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.engineer_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "DevelopmentEngineer", role: "assistant", content: result });
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
