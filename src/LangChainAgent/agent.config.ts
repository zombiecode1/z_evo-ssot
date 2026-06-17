import path from "path";

export const ZombieCoderConfig = {
  project: {
    name: "ZombieCoder Agentic Module",
    version: "1.1.0",
    execution_mode: "embedded_root",
    root_path: process.env.AGENT_ROOT_PATH || "./",
    memory_db_path: path.join(__dirname, "agent_memory.db"),
  },
  inference: {
    primary_provider: "opencode",
    fallback_provider: "universal_openai",
    opencode: {
      api_base: "http://localhost:9999/v1",
      default_model: "deepseek-v4-flash-free",
      models: {
        code_agent: "north-mini-code-free",
        analysis_agent: "big-pickle",
        general_agent: "mimo-v2.5-free",
        architect_agent: "nemotron-3-ultra-free",
        engineer_agent: "north-mini-code-free",
        qa_agent: "big-pickle",
        docs_agent: "mimo-v2.5-free",
        ops_agent: "nemotron-3-ultra-free",
      },
      fallback_models: {
        code_agent: "deepseek-v4-flash-free",
        analysis_agent: "nemotron-3-ultra-free",
        general_agent: "deepseek-v4-flash-free",
        architect_agent: "big-pickle",
        engineer_agent: "deepseek-v4-flash-free",
        qa_agent: "nemotron-3-ultra-free",
        docs_agent: "deepseek-v4-flash-free",
        ops_agent: "big-pickle",
      },
    },
    universal_openai: {
      api_base: process.env.UNIVERSAL_LLM_BASE || "http://localhost:11434/v1",
      api_key: process.env.UNIVERSAL_LLM_KEY || "local-bypass",
      default_model: process.env.UNIVERSAL_LLM_MODEL || "qwen2.5-coder:7b",
    },
  },
  response_mode: {
    type: "stream",
    capture_runtime_events: true,
    trust_checker_enabled: true,
  },
};
