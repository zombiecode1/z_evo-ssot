import { createOpenAICompatible as createOpenAI } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import { ZombieCoderConfig } from "../../agent.config";

const universalClient = createOpenAI({
  name: "universal",
  baseURL: ZombieCoderConfig.inference.universal_openai.api_base,
  apiKey: ZombieCoderConfig.inference.universal_openai.api_key,
});

export class UniversalLLMController {
  async generateText(options: {
    model?: string;
    prompt: string;
    systemPrompt?: string;
  }): Promise<string> {
    const { 
      model = ZombieCoderConfig.inference.universal_openai.default_model, 
      prompt, 
      systemPrompt = "" 
    } = options;

    try {
      const result = await generateText({
        model: universalClient(model) as any,
        system: systemPrompt,
        prompt: prompt,
      });
      return result.text;
    } catch (error) {
      throw new Error(
        `Universal LLM API failed for model ${model}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  async streamText(options: {
    model?: string;
    prompt: string;
    systemPrompt?: string;
  }): Promise<any> {
    const { 
      model = ZombieCoderConfig.inference.universal_openai.default_model, 
      prompt, 
      systemPrompt = "" 
    } = options;

    try {
      const result = streamText({
        model: universalClient(model) as any,
        system: systemPrompt,
        prompt: prompt,
      });
      return result;
    } catch (error) {
      throw new Error(
        `Universal LLM streaming failed for model ${model}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
}
