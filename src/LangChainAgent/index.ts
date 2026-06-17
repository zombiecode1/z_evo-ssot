import { SolutionArchitectAgent } from "./src/agent/SolutionArchitectAgent";
import { DevelopmentEngineerAgent } from "./src/agent/DevelopmentEngineerAgent";
import { QualityAssuranceAgent } from "./src/agent/QualityAssuranceAgent";
import { DocumentationAgent } from "./src/agent/DocumentationAgent";
import { OperationsAgent } from "./src/agent/OperationsAgent";
import { IdentityService } from "./src/identity/IdentityService";
import { MemoryService } from "./src/memory/MemoryService";
import { ZombieCoderConfig } from "./agent.config";

export class LangChainAgent {
  public solutionArchitect: SolutionArchitectAgent;
  public developmentEngineer: DevelopmentEngineerAgent;
  public qualityAssurance: QualityAssuranceAgent;
  public documentation: DocumentationAgent;
  public operations: OperationsAgent;
  public identityService: IdentityService;
  public memoryService: MemoryService;

  constructor() {
    this.identityService = IdentityService.getInstance();
    this.memoryService = MemoryService.getInstance();
    this.solutionArchitect = new SolutionArchitectAgent();
    this.developmentEngineer = new DevelopmentEngineerAgent();
    this.qualityAssurance = new QualityAssuranceAgent();
    this.documentation = new DocumentationAgent();
    this.operations = new OperationsAgent();

    // Validate identity on initialization
    if (!this.identityService.validateIdentity()) {
      console.warn("Warning: Identity validation failed. Please check identity.json");
    }

    // Initialize memory database
    try {
      this.memoryService.initialize();
      console.log("[LangChainAgent] Memory database initialized successfully");
    } catch (error) {
      console.error("[LangChainAgent] Failed to initialize memory database:", error);
    }
  }

  public getSystemInfo(): {
    name: string;
    version: string;
    owner: string;
    tagline: string;
  } {
    const identity = this.identityService.loadIdentity();
    return {
      name: identity.system_identity.name,
      version: identity.system_identity.version,
      owner: identity.system_identity.branding.owner,
      tagline: identity.system_identity.tagline,
    };
  }

  public getResponseHeaders(): Record<string, string> {
    return this.identityService.getResponseHeaders();
  }

  public getConfig() {
    return ZombieCoderConfig;
  }

  public getMemoryStats() {
    return this.memoryService.getStats();
  }

  /**
   * Graceful shutdown - close database connections
   */
  public shutdown(): void {
    this.memoryService.close();
    console.log("[LangChainAgent] Shutdown complete");
  }
}

// Default export for easy import
export default LangChainAgent;
