/**
 * Zombie Agent Controller — জম্বিদের ডাকার জন্য
 * 
 * This controller bridges the main server with LangChainAgent.
 * Uses the agents' system prompts but calls via our own Proxi server.
 * Logs all activity to agent_memory.db for admin panel visibility.
 */

import { Request, Response } from 'express';
import { logAgentActivity, getAgentStats, getAgentActivity, getAgentActivitySummary } from '../services/agentMemoryDb';

const PROXI_SERVER = process.env.PROXI_BRIDGE_URL || 'http://localhost:9999';

// Agent system prompts (from original LangChainAgent code)
const AGENT_PROMPTS: Record<string, string> = {
  architect: `# Role: Solution Architect Agent
You are a senior-level technical architect focused on system design, scalability, and maintainability.
Respond in the same language as the user. Be concise.`,
  
  engineer: `# Role: Development Engineer Agent
You are a senior software engineer focused on writing clean, maintainable code.
Respond in the same language as the user. Be concise.`,
  
  qa: `# Role: Quality Assurance Agent
You are a senior QA engineer focused on ensuring software quality.
Respond in the same language as the user. Be concise.`,
  
  docs: `# Role: Documentation Agent
You are a technical writer focused on creating clear documentation.
Respond in the same language as the user. Be concise.`,
  
  ops: `# Role: Operations Agent
You are a DevOps engineer focused on system reliability.
Respond in the same language as the user. Be concise.`,
};

const AGENT_MODELS: Record<string, string> = {
  architect: process.env.ZOMBIE_AGENT_ARCHITECT_MODEL || 'nemotron-3-ultra-free',
  engineer: process.env.ZOMBIE_AGENT_ENGINEER_MODEL || 'deepseek-v4-flash-free',
  qa: process.env.ZOMBIE_AGENT_QA_MODEL || 'big-pickle',
  docs: process.env.ZOMBIE_AGENT_DOCS_MODEL || 'mimo-v2.5-free',
  ops: process.env.ZOMBIE_AGENT_OPS_MODEL || 'nemotron-3-ultra-free',
};

export const handleZombieAgentChat = async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const { agent, prompt, model, context } = req.body;

    if (!agent || !prompt) {
      return res.status(400).json({ error: 'agent and prompt are required' });
    }

    const agentKey = agent.toLowerCase();
    const systemPrompt = AGENT_PROMPTS[agentKey];
    if (!systemPrompt) {
      return res.status(400).json({ 
        error: `Unknown agent: ${agent}`,
        available: Object.keys(AGENT_PROMPTS)
      });
    }

    const selectedModel = model || AGENT_MODELS[agentKey] || 'deepseek-v4-flash-free';

    // Get identity prompt
    let identityPrompt = '';
    try {
      const { getIdentity } = require('../services/identityService');
      const identity = getIdentity();
      identityPrompt = identity?.system_identity?.system_prompt || '';
    } catch (_) {}

    // Call our own Proxi server
    const response = await fetch(`${PROXI_SERVER}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          ...(identityPrompt ? [{ role: 'system', content: identityPrompt }] : []),
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    const durationMs = Date.now() - startTime;

    // Log success to database
    logAgentActivity({
      agent_id: agentKey,
      prompt,
      response: content,
      model: selectedModel,
      status: 'success',
      duration_ms: durationMs,
      tokens_input: data.usage?.prompt_tokens || 0,
      tokens_output: data.usage?.completion_tokens || 0,
    });

    console.log(`✅ Zombie ${agentKey} [${selectedModel}] ${durationMs}ms`);

    res.json({
      agent,
      model: selectedModel,
      response: content,
      duration_ms: durationMs,
    });

  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    
    // Log error to database
    logAgentActivity({
      agent_id: req.body?.agent || 'unknown',
      prompt: req.body?.prompt || '',
      model: req.body?.model || 'unknown',
      status: 'error',
      error_message: error.message,
      duration_ms: durationMs,
    });

    console.error(`❌ Zombie agent error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
};

export const handleZombieAgentList = async (_req: Request, res: Response) => {
  let systemInfo = { name: 'ZombieCoder', version: '1.0.0', owner: 'Unknown', tagline: '' };
  try {
    const { getIdentity } = require('../services/identityService');
    const identity = getIdentity();
    systemInfo = {
      name: identity?.system_identity?.name || 'ZombieCoder',
      version: identity?.system_identity?.version || '1.0.0',
      owner: identity?.system_identity?.branding?.owner || 'Unknown',
      tagline: identity?.system_identity?.tagline || '',
    };
  } catch (_) {}

  const stats = getAgentStats();

  res.json({
    system: systemInfo,
    agents: stats.map(s => ({
      name: s.agent_id,
      display_name: s.name,
      model: s.model,
      stats: {
        total_requests: s.total_requests,
        successful_requests: s.successful_requests,
        failed_requests: s.failed_requests,
        avg_duration_ms: Math.round(s.avg_duration_ms),
        last_used_at: s.last_used_at,
      },
    })),
  });
};

// ─── Admin API Endpoints ──────────────────────────────────────

export const handleZombieAgentStats = async (_req: Request, res: Response) => {
  const stats = getAgentStats();
  const summary = getAgentActivitySummary();
  res.json({ stats, summary });
};

export const handleZombieAgentActivity = async (req: Request, res: Response) => {
  const { agent_id } = req.query;
  const limit = parseInt(req.query.limit as string) || 50;
  const activity = getAgentActivity(agent_id as string, limit);
  res.json({ activity });
};
