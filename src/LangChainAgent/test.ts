/**
 * ZombieCoder LangChainAgent - Integration Test
 * Tests: Database, Memory, Agent instantiation, Bridge connectivity
 */

import { LangChainAgent } from "./index";
import { MemoryService } from "./src/memory/MemoryService";
import { ZombieCoderConfig } from "./agent.config";

async function runTests() {
  console.log("=".repeat(60));
  console.log("  ZombieCoder LangChainAgent - Integration Tests");
  console.log("=".repeat(60));
  
  let passed = 0;
  let failed = 0;

  function test(name: string, success: boolean, detail?: string) {
    if (success) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.log(`  ❌ FAIL: ${name}${detail ? ` - ${detail}` : ""}`);
      failed++;
    }
  }

  // ─── Test 1: Configuration ──────────────────────────────
  console.log("\n📋 Test 1: Configuration");
  test("Config loaded", !!ZombieCoderConfig);
  test("Project name set", ZombieCoderConfig.project.name === "ZombieCoder Agentic Module");
  test("Memory DB path set", !!ZombieCoderConfig.project.memory_db_path);
  test("OpenCode API base correct", ZombieCoderConfig.inference.opencode.api_base === "http://localhost:9999/v1");
  test("Default model set", !!ZombieCoderConfig.inference.opencode.default_model);

  // ─── Test 2: Memory Service ─────────────────────────────
  console.log("\n📋 Test 2: Memory Service (SQLite)");
  try {
    const memory = MemoryService.getInstance();
    test("MemoryService singleton", !!memory);
    
    memory.initialize();
    test("Database initialized", true);

    // Create a test session
    memory.createSession("test-session-1", "TestAgent");
    const session = memory.getSession("test-session-1");
    test("Session created", !!session);
    test("Session agent name", session?.agent_name === "TestAgent");

    // Add messages
    const msgId1 = memory.addMessage({
      session_id: "test-session-1",
      agent_name: "TestAgent",
      role: "user",
      content: "Hello, this is a test message",
    });
    test("Message 1 added", msgId1 > 0);

    const msgId2 = memory.addMessage({
      session_id: "test-session-1",
      agent_name: "TestAgent",
      role: "assistant",
      content: "Hello! I am a test assistant response.",
      model_used: "test-model",
      tokens_used: 50,
    });
    test("Message 2 added", msgId2 > 0);

    // Retrieve messages
    const messages = memory.getMessages("test-session-1");
    test("Messages retrieved", messages.length === 2);
    test("Message content correct", messages[0].content === "Hello, this is a test message");

    // Build context
    const context = memory.buildContext("test-session-1", 5);
    test("Context built", context.includes("user") && context.includes("assistant"));

    // Search messages
    const results = memory.searchMessages("test");
    test("Search works", results.length >= 2);

    // Stats
    const stats = memory.getStats();
    test("Stats available", stats.total_messages >= 2);

    // Cleanup
    memory.deleteSession("test-session-1");
    const deleted = memory.getSession("test-session-1");
    test("Session deleted", !deleted);

    memory.close();
    test("Database closed", true);
  } catch (error: any) {
    test("Memory Service", false, error.message);
  }

  // ─── Test 3: Agent Instantiation ────────────────────────
  console.log("\n📋 Test 3: Agent Instantiation");
  try {
    const agent = new LangChainAgent();
    test("LangChainAgent created", !!agent);
    test("IdentityService loaded", !!agent.identityService);
    test("MemoryService available", !!agent.memoryService);
    test("SolutionArchitect agent", !!agent.solutionArchitect);
    test("DevelopmentEngineer agent", !!agent.developmentEngineer);
    test("QualityAssurance agent", !!agent.qualityAssurance);
    test("Documentation agent", !!agent.documentation);
    test("Operations agent", !!agent.operations);

    // System info
    const info = agent.getSystemInfo();
    test("System info available", !!info);
    test("System name", info.name === "ZombieCoder");
    test("System owner", info.owner === "Sahon Srabon");

    // Response headers
    const headers = agent.getResponseHeaders();
    test("Response headers available", !!headers["X-Powered-By"]);
    test("X-System-Name header", headers["X-System-Name"] === "ZombieCoder");

    // Config
    const config = agent.getConfig();
    test("Config accessible", !!config);

    // Memory stats
    const memStats = agent.getMemoryStats();
    test("Memory stats available", !!memStats);

    agent.shutdown();
    test("Graceful shutdown", true);
  } catch (error: any) {
    test("Agent Instantiation", false, error.message);
  }

  // ─── Test 4: Bridge Connectivity ────────────────────────
  console.log("\n📋 Test 4: Bridge Connectivity");
  try {
    const response = await fetch("http://localhost:9999/v1/models", {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    test("Bridge server reachable", response.ok);
    const data: any = await response.json();
    test("Models endpoint returns data", !!data);
    const modelCount = data?.data?.length || data?.models?.length || 0;
    test("Models loaded (>0)", modelCount > 0);
    console.log(`    ℹ️  ${modelCount} models available on bridge`);
    
    // Test agent endpoint
    try {
      const agentResponse = await fetch("http://localhost:9999/v1/agent/status", {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      test("Agent status endpoint", agentResponse.ok);
    } catch {
      test("Agent status endpoint", false, "endpoint not available");
    }
  } catch (error: any) {
    test("Bridge server reachable", false, "Server not running on port 9999");
  }

  // ─── Summary ────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error("Test runner failed:", error);
  process.exit(1);
});
