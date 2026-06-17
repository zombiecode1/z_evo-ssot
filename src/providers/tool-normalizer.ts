// ─── Tool Call Normalizer ─────────────────────────────────
// Converts provider-native tool call formats to OpenAI-compatible format.
// Different providers return tool calls in different structures;
// this module normalizes them all.

import { ToolCall, ToolDefinition } from './types';

// ─── Anthropic Tool Call Format ──────────────────────────

export interface AnthropicToolCall {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Convert Anthropic content blocks to OpenAI tool_calls */
export function normalizeAnthropicToolCalls(
  contentBlocks: Array<{ type: string; id?: string; name?: string; input?: any; text?: string }>,
): ToolCall[] | undefined {
  const toolUseBlocks = contentBlocks.filter(b => b.type === 'tool_use');
  if (toolUseBlocks.length === 0) return undefined;

  return toolUseBlocks.map((block, i) => ({
    id: block.id || `toolu_${Date.now()}_${i}`,
    type: 'function' as const,
    function: {
      name: block.name || '',
      arguments: JSON.stringify(block.input || {}),
    },
  }));
}

/** Convert Anthropic tool definitions to OpenAI tool format */
export function normalizeAnthropicTools(
  tools: Array<{ name: string; description?: string; input_schema?: any }>,
): ToolDefinition[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || {},
    },
  }));
}

/** Convert OpenAI tool_calls to Anthropic content blocks */
export function denormalizeToAnthropicToolCalls(
  toolCalls: ToolCall[],
): AnthropicToolCall[] {
  return toolCalls.map(tc => ({
    type: 'tool_use' as const,
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments || '{}'),
  }));
}

/** Convert tool results to Anthropic format */
export function denormalizeToAnthropicToolResults(
  results: Array<{ tool_call_id: string; content: string; isError?: boolean }>,
): AnthropicToolResult[] {
  return results.map(r => ({
    type: 'tool_result' as const,
    tool_use_id: r.tool_call_id,
    content: r.content,
    is_error: r.isError || false,
  }));
}

// ─── Gemini Tool Call Format ─────────────────────────────

export interface GeminiFunctionCall {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GeminiFunctionResponse {
  functionResponse: {
    name: string;
    response: { error?: string; result?: unknown };
  };
}

/** Convert Gemini function calls to OpenAI tool_calls */
export function normalizeGeminiToolCalls(
  parts: Array<{ functionCall?: { name: string; args: any }; text?: string }>,
): ToolCall[] | undefined {
  const fcParts = parts.filter(p => p.functionCall);
  if (fcParts.length === 0) return undefined;

  return fcParts.map((part, i) => ({
    id: `toolu_gemini_${Date.now()}_${i}`,
    type: 'function' as const,
    function: {
      name: part.functionCall!.name,
      arguments: JSON.stringify(part.functionCall!.args || {}),
    },
  }));
}

/** Convert OpenAI tool_calls to Gemini function call parts */
export function denormalizeToGeminiToolCalls(
  toolCalls: ToolCall[],
): GeminiFunctionCall[] {
  return toolCalls.map(tc => ({
    functionCall: {
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments || '{}'),
    },
  }));
}

/** Convert tool results to Gemini function response parts */
export function denormalizeToGeminiToolResults(
  results: Array<{ tool_call_id: string; name?: string; content: string; isError?: boolean }>,
): GeminiFunctionResponse[] {
  return results.map(r => ({
    functionResponse: {
      name: r.name || r.tool_call_id,
      response: r.isError
        ? { error: r.content }
        : { result: r.content },
    },
  }));
}

// ─── Ollama Tool Call Format ─────────────────────────────

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

/** Convert Ollama tool calls to OpenAI format */
export function normalizeOllamaToolCalls(
  toolCalls: OllamaToolCall[],
): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;

  return toolCalls.map((tc, i) => ({
    id: `toolu_ollama_${Date.now()}_${i}`,
    type: 'function' as const,
    function: {
      name: tc.function?.name || '',
      arguments: JSON.stringify(tc.function?.arguments || {}),
    },
  }));
}

// ─── Generic Tool Call Utilities ─────────────────────────

/** Check if a response contains tool calls (any format) */
export function hasToolCalls(response: any): boolean {
  // OpenAI format
  if (response?.tool_calls?.length > 0) return true;
  if (response?.choices?.[0]?.message?.tool_calls?.length > 0) return true;
  // Anthropic format
  if (response?.content?.some((b: any) => b.type === 'tool_use')) return true;
  // Gemini format
  if (response?.parts?.some((p: any) => p.functionCall)) return true;
  return false;
}

/** Extract tool calls from any response format */
export function extractToolCalls(response: any): ToolCall[] | undefined {
  // OpenAI format
  if (response?.tool_calls) return response.tool_calls;
  if (response?.choices?.[0]?.message?.tool_calls) return response.choices[0].message.tool_calls;
  // Anthropic format
  if (response?.content) return normalizeAnthropicToolCalls(response.content);
  // Gemini format
  if (response?.parts) return normalizeGeminiToolCalls(response.parts);
  return undefined;
}

/** Build a tool result message for any provider format */
export function buildToolResultMessage(
  toolCallId: string,
  content: string,
  isError: boolean = false,
): { role: 'tool'; tool_call_id: string; content: string } {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: isError ? `Error: ${content}` : content,
  };
}

/** Validate tool definitions are properly formatted */
export function validateToolDefinitions(tools: ToolDefinition[]): {
  valid: ToolDefinition[];
  errors: string[];
} {
  const errors: string[] = [];
  const valid: ToolDefinition[] = [];

  for (const tool of tools) {
    if (!tool.function?.name) {
      errors.push(`Tool missing function.name: ${JSON.stringify(tool)}`);
      continue;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tool.function.name)) {
      errors.push(`Invalid tool name: ${tool.function.name}`);
      continue;
    }
    valid.push(tool);
  }

  return { valid, errors };
}
