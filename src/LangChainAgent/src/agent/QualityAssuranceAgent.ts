import { OpenCodeController } from "../controllers/OpenCodeController";
import { UniversalLLMController } from "../controllers/UniversalLLMController";
import { MemoryService } from "../memory/MemoryService";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ZombieCoderConfig } from "../../agent.config";

export class QualityAssuranceAgent {
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
# Role: Quality Assurance Agent

You are a verification-focused specialist responsible for reliability, stability, and regression prevention.

## Platform Awareness
- Current OS: ${platform}
- Shell: ${shell}
- Path convention: ${pathHint}

## Primary Mission
Ensure that implemented solutions behave correctly without introducing unintended side effects.

## Available Tools
You have access to the following tools. Use them when the user asks to read files, search code, or run commands:

### File Tools
- **read_file**: Read file content (cross-platform). Example: read_file({ path: "C:\\path\\file.ts" }) or read_file({ path: "/path/file.ts" })
- **list_files**: List directory contents. Example: list_files({ directory: "./src", recursive: true })
- **find_files**: Find files by name. Example: find_files({ directory: ".", searchTerm: "Controller" })
- **search_code**: Search code content. Example: search_code({ directory: "./src", query: "function name" })

### Search Tools
- **web_search**: Search DuckDuckGo (no API key needed). Example: web_search({ query: "Jest testing best practices" })

### Shell Tools
- **run_command**: Execute shell command. Example: run_command({ command: "npm test" })

## Core Responsibilities
- Functional Testing
- Regression Testing
- Integration Testing
- Validation Planning
- Defect Analysis
- Root Cause Investigation
- Quality Reporting

## Working Principles
- Verify before concluding.
- Reproduce before fixing.
- Measure before optimizing.
- Evidence over assumptions.

## Validation Framework

### Environment Verification
Confirm actual runtime conditions.

### Functional Verification
Ensure requirements are satisfied.

### Regression Analysis
Confirm existing functionality remains intact.

### Risk Assessment
Identify remaining uncertainties.

## Communication Style
Objective and evidence-based.

Avoids emotional conclusions and focuses on measurable outcomes.
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

  async createTestPlan(options: {
    featureDescription: string;
    requirements: string[];
    acceptanceCriteria: string[];
    sessionId?: string;
  }): Promise<string> {
    const { featureDescription, requirements, acceptanceCriteria, sessionId = `qa-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "user", content: `Test plan for: ${featureDescription}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(featureDescription);

    const prompt = `
Create a comprehensive test plan for the following feature:

Feature Description: ${featureDescription}

Requirements:
${requirements.join("\n")}

Acceptance Criteria:
${acceptanceCriteria.join("\n")}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Test strategy overview
2. Test scenarios with priorities
3. Test cases with steps and expected results
4. Test data requirements
5. Environment setup requirements
6. Risk assessment and mitigation
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.qa_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    }
  }

  async generateTestCases(options: {
    functionality: string;
    testType: "unit" | "integration" | "e2e" | "regression";
    framework?: string;
    sessionId?: string;
  }): Promise<string> {
    const { functionality, testType, framework = "Jest", sessionId = `test-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "user", content: `Generate ${testType} tests for: ${functionality}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(functionality);

    const prompt = `
Generate test cases for the following functionality:

Functionality: ${functionality}
Test Type: ${testType}
Testing Framework: ${framework}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Test case descriptions
2. Test data setup
3. Test implementation code
4. Expected results
5. Edge cases to consider
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.qa_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    }
  }

  async analyzeDefect(options: {
    defectDescription: string;
    severity: "critical" | "high" | "medium" | "low";
    stepsToReproduce: string;
    actualResult: string;
    expectedResult: string;
    environment?: string;
    sessionId?: string;
  }): Promise<string> {
    const { 
      defectDescription, 
      severity, 
      stepsToReproduce, 
      actualResult, 
      expectedResult,
      environment = "",
      sessionId = `defect-${Date.now()}`
    } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "user", content: `Defect: ${defectDescription} [${severity}]` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(defectDescription);

    const prompt = `
Analyze the following defect:

Defect Description: ${defectDescription}
Severity: ${severity}

Steps to Reproduce:
${stepsToReproduce}

Actual Result: ${actualResult}
Expected Result: ${expectedResult}

${environment ? `Environment: ${environment}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Root cause analysis
2. Impact assessment
3. Reproduction verification steps
4. Recommended fix approach
5. Test cases to verify the fix
6. Regression testing recommendations
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.qa_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    }
  }

  async performRegressionAnalysis(options: {
    changesDescription: string;
    affectedAreas: string[];
    existingTestSuite?: string;
    sessionId?: string;
  }): Promise<string> {
    const { changesDescription, affectedAreas, existingTestSuite = "", sessionId = `reg-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "user", content: `Regression analysis: ${changesDescription}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(changesDescription);

    const prompt = `
Perform regression analysis for the following changes:

Changes Description: ${changesDescription}

Affected Areas:
${affectedAreas.join("\n")}

${existingTestSuite ? `Existing Test Suite:\n${existingTestSuite}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Impact analysis
2. Regression test scope
3. Test cases to re-run
4. New test cases needed
5. Risk assessment
6. Sign-off recommendation
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.qa_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    }
  }

  async generateQualityReport(options: {
    projectContext: string;
    metricsData?: {
      testCoverage?: string;
      defectDensity?: string;
      passRate?: string;
    };
    sessionId?: string;
  }): Promise<string> {
    const { projectContext, metricsData, sessionId = `qr-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "user", content: `Quality report for: ${projectContext}` });

    const prompt = `
Generate a quality assurance report for the following project:

Project Context: ${projectContext}

${metricsData ? `Metrics Data:
- Test Coverage: ${metricsData.testCoverage || "N/A"}
- Defect Density: ${metricsData.defectDensity || "N/A"}
- Pass Rate: ${metricsData.passRate || "N/A"}
` : ""}

Please provide:
1. Executive summary
2. Quality metrics analysis
3. Defect trends
4. Risk areas
5. Recommendations for improvement
6. Overall quality assessment
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.qa_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "QualityAssurance", role: "assistant", content: result });
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
