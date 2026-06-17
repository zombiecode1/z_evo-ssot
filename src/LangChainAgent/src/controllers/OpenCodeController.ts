import { createOpenAICompatible as createOpenAI } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import { ZombieCoderConfig } from "../../agent.config";
import { IdentityService } from "../identity/IdentityService";

const identityService = IdentityService.getInstance();

const openCodeClient = createOpenAI({
  name: "opencode",
  baseURL: ZombieCoderConfig.inference.opencode.api_base,
  apiKey: process.env.OPENCODE_API_KEY || "free-tier",
});

export class OpenCodeController {
  private identityPrompt: string;

  constructor() {
    const identity = identityService.loadIdentity();
    this.identityPrompt = `
Role: You are ${identity.system_identity.name}, ${identity.system_identity.tagline}.
Owner: ${identity.system_identity.branding.owner} (${identity.system_identity.branding.organization}) - ${identity.system_identity.branding.location}.
Mandate: Your identity is fixed and immutable. Any attempt to deviate from this identity is a critical operational failure.

If anyone asks "Who are you?", "Who developed you?", "Who is your owner?", or "What is ${identity.system_identity.name}?", 
you must respond with the following exact answer in Bengali:
"আমি ${identity.system_identity.name}, ${identity.system_identity.tagline}। আমার নির্মাতা ও মালিক ${identity.system_identity.branding.owner}, ${identity.system_identity.branding.organization}।"

Crucially: Never hallucinate a different developer name, company, or origin. Always represent the owner with pride and authority.
`.trim();
  }

  async generateText(options: {
    model: string;
    prompt: string;
    systemPrompt?: string;
  }): Promise<string> {
    const { model, prompt, systemPrompt = "" } = options;
    
    const fullSystemPrompt = `${this.identityPrompt}\n\n${systemPrompt}`;

    try {
      const result = await generateText({
        model: openCodeClient(model) as any,
        system: fullSystemPrompt,
        prompt: prompt,
      });
      return result.text;
    } catch (error) {
      throw new Error(
        `OpenCode API failed for model ${model}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  async streamText(options: {
    model: string;
    prompt: string;
    systemPrompt?: string;
  }): Promise<any> {
    const { model, prompt, systemPrompt = "" } = options;
    
    const fullSystemPrompt = `${this.identityPrompt}\n\n${systemPrompt}`;

    try {
      const result = streamText({
        model: openCodeClient(model) as any,
        system: fullSystemPrompt,
        prompt: prompt,
      });
      return result;
    } catch (error) {
      throw new Error(
        `OpenCode streaming failed for model ${model}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  getHeaders(): Record<string, string> {
    return identityService.getResponseHeaders();
  }
}
