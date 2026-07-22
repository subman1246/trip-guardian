/**
 * The Gemini implementation of AgentModel.
 *
 * This is the only file that talks to the network. The API key comes from the
 * environment and is handed straight to the SDK. It is never logged, never put
 * in a trace, and never included in an error message.
 */

import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";

import { modelName, requireApiKey } from "./config.js";
import { AGENT_FUNCTION_DECLARATIONS } from "./declarations.js";
import type { AgentModel, ModelTurn } from "./model.js";
import { SYSTEM_INSTRUCTION } from "./prompts.js";

/**
 * Slightly below the default. We want the agent to be inventive about tradeoffs
 * but consistent about arithmetic and option ids.
 */
const TEMPERATURE = 0.4;

export interface GeminiOptions {
  /**
   * Tools beyond the four prompt-2 ones. Omit this and behaviour is exactly
   * what it always was: the scripted scenario run never sets it. Chat is the
   * only caller that does, adding apply_disruption (see chatDeclarations.ts).
   */
  declarations?: FunctionDeclaration[];
}

export function createGeminiModel(options: GeminiOptions = {}): AgentModel {
  const apiKey = requireApiKey();
  const model = modelName();
  const ai = new GoogleGenAI({ apiKey });
  const declarations = options.declarations ?? AGENT_FUNCTION_DECLARATIONS;

  return {
    name: model,

    async generate(contents: Content[]): Promise<ModelTurn> {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          tools: [{ functionDeclarations: declarations }],
          // We run the loop ourselves so every call goes through the real tools
          // and lands in the visible trace.
          automaticFunctionCalling: { disable: true },
          temperature: TEMPERATURE,
        },
      });

      const candidate = response.candidates?.[0];
      const content: Content = candidate?.content ?? { role: "model", parts: [] };

      const toolCalls = (response.functionCalls ?? []).map((call) => ({
        ...(call.id !== undefined ? { id: call.id } : {}),
        name: call.name ?? "",
        args: (call.args ?? {}) as Record<string, unknown>,
      }));

      return { text: (response.text ?? "").trim(), toolCalls, content };
    },
  };
}
