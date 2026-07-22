/**
 * Picking a model provider.
 *
 * Both providers implement the same AgentModel interface, so the reasoning loop
 * cannot tell them apart. Choosing one is the only decision made here.
 *
 * Selection order:
 *   1. MODEL_PROVIDER in .env, if set ("groq" or "gemini").
 *   2. Otherwise whichever provider has a key, preferring Groq.
 *   3. Otherwise Groq, so the missing key message names one provider clearly.
 */

import { activeModelName, providerName, type ProviderName } from "./config.js";
import { createGeminiModel, type GeminiOptions } from "./gemini.js";
import { createGroqModel, type GroqOptions } from "./groq.js";
import type { AgentModel } from "./model.js";

/**
 * Both providers' options are optional and additive (an extra tool list, a rate
 * limit hook), so a caller that passes neither gets the exact behaviour it
 * always got. Only chat passes `declarations`, since only chat adds a tool.
 */
export function createModel(
  provider: ProviderName = providerName(),
  options: GroqOptions & GeminiOptions = {},
): AgentModel {
  return provider === "groq" ? createGroqModel(options) : createGeminiModel(options);
}

/** One line for the demo header, for example "groq / llama-3.3-70b-versatile". */
export function describeProvider(provider: ProviderName = providerName()): string {
  return `${provider} / ${activeModelName(provider)}`;
}
