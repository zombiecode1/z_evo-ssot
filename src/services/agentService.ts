import { GroqService } from './groqService';
import { DiskRAGService } from './ragService';
import { getIdentity } from './identityService';
import { AgentResponse, AgentFlags } from '../types';

interface AgentConfig {
  autoRag: boolean;
  maxRagChunks: number;
  defaultModel: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  autoRag: true,
  maxRagChunks: 5,
  defaultModel: 'deepseek-v4-flash-free',
};

// NOTE: This service implements the legacy "AgentResponse" JSON wrapper format used by the
// /v1/agent/chat route in legacy mode. For OpenAI-compatible tool calling, prefer passing
// tools to /v1/chat/completions (or the non-legacy mode of /v1/agent/chat).
export class AgentService {
  private config: AgentConfig;
  private identityCache: { name: string; prompt: string } | null = null;
  private lastResponse: AgentResponse | null = null;

  constructor(
    private groq: GroqService,
    private rag?: DiskRAGService,
    config?: Partial<AgentConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.loadIdentity();
  }

  private loadIdentity(): void {
    try {
      const identity = getIdentity();
      if (identity?.system_identity) {
        this.identityCache = {
          name: identity.system_identity.name || 'ZombieCoder',
          prompt: identity.system_identity.system_prompt || '',
        };
      }
    } catch {
      this.identityCache = null;
    }
  }

  getPersonaName(): string {
    return this.identityCache?.name || 'ZombieCoder';
  }

  getLastResponse(): AgentResponse | null {
    return this.lastResponse;
  }

  updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private getLegacyResponseFormatInstructions(): string {
    return [
      '--- Legacy Agent Response Format ---',
      'Return ONLY a JSON object when possible, using this shape:',
      '{',
      '  "content": "your answer",',
      '  "flags": {',
      '    "type": "chat" | "code" | "tool" | "error",',
      '    "execute": true | false,',
      '    "language": "python" | "javascript" | "typescript" | etc,',
      '    "safety": "safe" | "unsafe" | "unknown"',
      '  }',
      '}',
      '',
      'Rules:',
      '- type "chat": normal conversation',
      '- type "code": code generation; if execute:true, the client may run it',
      '- type "tool": indicates an external action is required (API call, file write, etc.)',
      '- type "error": for failures; provide a helpful explanation',
      '- safety "unsafe": requires explicit user confirmation',
    ].join('\n');
  }

  private detectRagIntent(messages: { role: string; content: string }[]): boolean {
    if (!this.config.autoRag || !this.rag?.ssotExists()) return false;
    const lastMsg = messages[messages.length - 1]?.content || '';
    const lower = lastMsg.toLowerCase();
    const ragKeywords = [
      'documentation', 'docs', 'how to', 'what is', 'explain', 'guide',
      'manual', 'readme', 'project', 'code',
      'function', 'class', 'api', 'endpoint', 'route', 'service',
    ];
    return ragKeywords.some(k => lower.includes(k));
  }

  async processMessage(
    userMessages: { role: string; content: string }[],
    preferredModel?: string,
  ): Promise<AgentResponse> {
    const startTime = Date.now();

    let ragContext = '';
    if (this.detectRagIntent(userMessages)) {
      const lastMsg = userMessages[userMessages.length - 1]?.content || '';
      ragContext = this.rag!.searchSSOT(lastMsg);
    }

    const systemParts: string[] = [];
    if (this.identityCache?.prompt) systemParts.push(this.identityCache.prompt);
    systemParts.push(this.getLegacyResponseFormatInstructions());

    if (ragContext) {
      systemParts.push(
        '--- Project Documentation (from SSOT.md) ---',
        ragContext,
        '--- End of Documentation ---',
      );
    }

    const systemMessage = systemParts.join('\n\n');
    const model = preferredModel || this.config.defaultModel;

    try {
      const groqMessages = [{ role: 'system', content: systemMessage } as any, ...userMessages];
      const completion = await this.groq.createChatCompletion({
        model,
        messages: groqMessages,
        max_tokens: 1024,
        temperature: 0.7,
        stream: false,
      });

      const rawContent = (completion as any).choices?.[0]?.message?.content || '';
      const { content, flags } = this.parseResponse(rawContent);

      this.lastResponse = {
        content,
        model,
        flags,
        ragUsed: !!ragContext,
        durationMs: Date.now() - startTime,
      };

      if (this.rag) {
        this.rag.addToSession(`[User] ${userMessages[userMessages.length - 1]?.content || ''}`);
        this.rag.addToSession(`[Agent] ${content.substring(0, 200)}`);
      }

      return this.lastResponse;
    } catch (err: any) {
      const modelName = model;
      if (modelName !== this.config.defaultModel) {
        console.warn(`⚠️ Agent legacy mode: ${modelName} failed, falling back to ${this.config.defaultModel}`);
        const fallbackMsgs = [
          { role: 'system', content: this.identityCache?.prompt || 'You are a helpful assistant.' },
          ...userMessages,
        ];
        const fallback = await this.groq.createChatCompletion({
          model: this.config.defaultModel,
          messages: fallbackMsgs as any,
          max_tokens: 512,
          temperature: 0.7,
          stream: false,
        });
        const fbContent = (fallback as any).choices?.[0]?.message?.content || '';
        this.lastResponse = {
          content: fbContent,
          model: this.config.defaultModel,
          flags: { type: 'chat', safety: 'unknown' },
          ragUsed: false,
          durationMs: Date.now() - startTime,
        };
        return this.lastResponse;
      }
      throw err;
    }
  }

  private parseResponse(raw: string): { content: string; flags: AgentFlags } {
    try {
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        const jsonStr = raw.slice(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(jsonStr);
        if (parsed.content && parsed.flags) {
          return {
            content: parsed.content,
            flags: {
              type: parsed.flags.type || 'chat',
              execute: parsed.flags.execute || false,
              language: parsed.flags.language,
              safety: parsed.flags.safety || 'safe',
            },
          };
        }
      }
    } catch {
      // fall through to raw text
    }

    return {
      content: raw,
      flags: { type: 'chat', safety: 'safe' },
    };
  }
}

