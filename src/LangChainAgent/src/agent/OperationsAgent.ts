import { OpenCodeController } from "../controllers/OpenCodeController";
import { UniversalLLMController } from "../controllers/UniversalLLMController";
import { MemoryService } from "../memory/MemoryService";
import { ToolRegistry } from "../tools/ToolRegistry";
import { ZombieCoderConfig } from "../../agent.config";

export class OperationsAgent {
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
# Role: Operations & Reliability Agent

You are a reliability-focused operations specialist responsible for deployment, monitoring, observability, and system stability.

## Platform Awareness
- Current OS: ${platform}
- Shell: ${shell}
- Path convention: ${pathHint}

## Primary Mission
Maintain system availability, operational visibility, and incident readiness.

## Available Tools
You have access to the following tools. Use them when the user asks to read files, search code, or run commands:

### File Tools
- **read_file**: Read file content (cross-platform). Example: read_file({ path: "C:\\path\\file.ts" }) or read_file({ path: "/path/file.ts" })
- **list_files**: List directory contents. Example: list_files({ directory: "./src", recursive: true })
- **find_files**: Find files by name. Example: find_files({ directory: ".", searchTerm: "config" })
- **search_code**: Search code content. Example: search_code({ directory: "./src", query: "health" })
- **get_file_info**: Get file metadata (size, dates, type).

### Search Tools
- **web_search**: Search DuckDuckGo (no API key needed). Example: web_search({ query: "Docker best practices 2026" })

### Shell Tools
- **run_command**: Execute shell command. Example: run_command({ command: "docker ps" })

## Core Responsibilities
- Deployment Planning
- Infrastructure Validation
- Monitoring Design
- Logging Strategy
- Incident Response
- Backup Verification
- Recovery Planning
- Operational Automation

## Working Principles
- Reliability is a feature.
- Recovery is more important than optimism.
- Every deployment must be reversible.
- Every failure must be observable.

## Operational Checklist

### Before Change
- Impact Analysis
- Backup Verification
- Rollback Plan
- Dependency Validation

### During Change
- Controlled Deployment
- Health Monitoring
- Error Observation

### After Change
- Verification
- Stability Monitoring
- Incident Review

## Communication Style
Calm, predictable, and operationally focused.

When uncertainty exists:
"Operational confirmation is pending. Monitoring should continue before final acceptance."
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

  async planDeployment(options: {
    applicationName: string;
    environment: "development" | "staging" | "production";
    changesDescription: string;
    dependencies?: string[];
    sessionId?: string;
  }): Promise<string> {
    const { applicationName, environment, changesDescription, dependencies = [], sessionId = `deploy-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "user", content: `Deploy ${applicationName} to ${environment}: ${changesDescription}` });

    const conversationContext = this.memoryService.buildContext(sessionId, 5);

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(`${applicationName} ${changesDescription}`);

    const prompt = `
Create a deployment plan for:

Application Name: ${applicationName}
Environment: ${environment}
Changes Description: ${changesDescription}

${dependencies.length > 0 ? `Dependencies:\n${dependencies.join("\n")}` : ""}

${conversationContext ? `Previous conversation:\n${conversationContext}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Pre-deployment checklist
2. Deployment steps with commands
3. Health check procedures
4. Rollback plan
5. Post-deployment verification
6. Monitoring setup
7. Communication plan
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.ops_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    }
  }

  async designMonitoring(options: {
    systemName: string;
    components: string[];
    criticalMetrics: string[];
    alertingRequirements?: string[];
    sessionId?: string;
  }): Promise<string> {
    const { systemName, components, criticalMetrics, alertingRequirements = [], sessionId = `mon-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "user", content: `Monitoring design for: ${systemName}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(`${systemName} ${components.join(" ")}`);

    const prompt = `
Design a monitoring strategy for:

System Name: ${systemName}

Components:
${components.join("\n")}

Critical Metrics:
${criticalMetrics.join("\n")}

${alertingRequirements.length > 0 ? `Alerting Requirements:\n${alertingRequirements.join("\n")}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Monitoring architecture overview
2. Metrics to collect per component
3. Dashboard design recommendations
4. Alerting rules and thresholds
5. Log aggregation strategy
6. Incident response procedures
7. Tool recommendations
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.ops_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    }
  }

  async createIncidentResponsePlan(options: {
    scenarioType: string;
    severity: "critical" | "high" | "medium" | "low";
    affectedSystems: string[];
    sessionId?: string;
  }): Promise<string> {
    const { scenarioType, severity, affectedSystems, sessionId = `incident-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "user", content: `Incident plan: ${scenarioType} [${severity}]` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(`${scenarioType} ${affectedSystems.join(" ")}`);

    const prompt = `
Create an incident response plan for:

Scenario Type: ${scenarioType}
Severity: ${severity}

Affected Systems:
${affectedSystems.join("\n")}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Incident classification
2. Initial response steps
3. Escalation matrix
4. Communication templates
5. Technical troubleshooting steps
6. Recovery procedures
7. Post-incident review template
8. Prevention recommendations
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.ops_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    }
  }

  async designBackupStrategy(options: {
    dataTypes: string[];
    retentionPeriod: string;
    recoveryTimeObjective: string;
    recoveryPointObjective: string;
    sessionId?: string;
  }): Promise<string> {
    const { dataTypes, retentionPeriod, recoveryTimeObjective, recoveryPointObjective, sessionId = `backup-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "user", content: `Backup strategy for ${dataTypes.length} data types` });

    const prompt = `
Design a backup and recovery strategy:

Data Types:
${dataTypes.join("\n")}

Retention Period: ${retentionPeriod}
Recovery Time Objective (RTO): ${recoveryTimeObjective}
Recovery Point Objective (RPO): ${recoveryPointObjective}

Please provide:
1. Backup architecture overview
2. Backup schedule per data type
3. Storage locations and redundancy
4. Encryption and security measures
5. Recovery procedures
6. Testing schedule for backups
7. Monitoring and alerting for backup failures
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.ops_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    }
  }

  async performInfrastructureReview(options: {
    currentSetup: string;
    requirements: string[];
    constraints?: string[];
    sessionId?: string;
  }): Promise<string> {
    const { currentSetup, requirements, constraints = [], sessionId = `infra-${Date.now()}` } = options;

    this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "user", content: `Infrastructure review: ${currentSetup}` });

    // Detect and execute tools
    const toolResults = await this.detectAndExecuteTools(currentSetup);

    const prompt = `
Perform an infrastructure review:

Current Setup:
${currentSetup}

Requirements:
${requirements.join("\n")}

${constraints.length > 0 ? `Constraints:\n${constraints.join("\n")}` : ""}

${toolResults.length > 0 ? `Tool Results:\n${toolResults.join("\n\n")}` : ""}

Please provide:
1. Current state assessment
2. Gap analysis
3. Recommendations for improvement
4. Cost optimization opportunities
5. Security hardening suggestions
6. Scalability improvements
7. Implementation roadmap
`.trim();

    try {
      const result = await this.openCodeController.generateText({
        model: ZombieCoderConfig.inference.opencode.models.ops_agent,
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
      return result;
    } catch (error) {
      const result = await this.universalController.generateText({
        prompt: prompt,
        systemPrompt: this.getSystemPrompt(),
      });
      this.memoryService.addMessage({ session_id: sessionId, agent_name: "Operations", role: "assistant", content: result });
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
