/**
 * Configuration and secrets.
 *
 * API keys are read from the environment only, never from code and never from
 * anything committed. .env is gitignored. A key is never printed, not even
 * partially, and never included in a trace or an error message.
 *
 * Two providers are supported. They both drive the same agent, so the choice is
 * only about which service answers the call.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Path to the project .env, resolved relative to this file. */
const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

/** Which model to drive. Override with GEMINI_MODEL if you want a different one. */
const DEFAULT_MODEL = "gemini-2.5-flash";

/** Groq's default. Fast, free tier, and good at tool calling. */
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

/** The model services the agent can talk to. */
export type ProviderName = "gemini" | "groq";

let envLoaded = false;

/**
 * Load .env into process.env once. Node can do this natively, so we do not need
 * a dotenv dependency. Real environment variables always win over the file.
 */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;

  if (!existsSync(ENV_PATH)) return;

  // process.loadEnvFile exists on modern Node. Fall back to a tiny parser so
  // this still works on older runtimes.
  const loader = (process as NodeJS.Process & { loadEnvFile?: (path: string) => void })
    .loadEnvFile;

  if (typeof loader === "function") {
    try {
      loader.call(process, ENV_PATH);
      return;
    } catch {
      // Fall through to the manual parser below.
    }
  }

  parseEnvFileManually();
}

/** Minimal KEY=VALUE parser, used only when Node cannot load the file itself. */
function parseEnvFileManually(): void {
  const text = readFileSync(ENV_PATH, "utf8");

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    // Strip one layer of matching quotes if present.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      if (value[0] === value[value.length - 1]) value = value.slice(1, -1);
    }
    if (key.length > 0 && process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * The API key, or a clear instruction if it is missing.
 * The value is returned to the caller and never logged here.
 */
export function requireApiKey(): string {
  loadEnv();
  const key = process.env.GEMINI_API_KEY?.trim();

  if (!key) {
    throw new Error(
      [
        "GEMINI_API_KEY is not set, so the agent cannot reach the model.",
        "",
        "Fix it in three steps:",
        "  1. Get a key from https://aistudio.google.com/apikey",
        "  2. Add this line to the .env file in the project root:",
        "       GEMINI_API_KEY=your_key_here",
        "  3. Run the command again.",
        "",
        ".env is already gitignored, so the key will not be committed.",
      ].join("\n"),
    );
  }

  return key;
}

/** True if a key is present. Used to give a friendly message before starting. */
export function hasApiKey(): boolean {
  loadEnv();
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/** The Gemini model id to call. */
export function modelName(): string {
  loadEnv();
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

// ------------------------------------------------------------------- Groq

/** The Groq API key, or a clear instruction if it is missing. */
export function requireGroqApiKey(): string {
  loadEnv();
  const key = process.env.GROQ_API_KEY?.trim();

  if (!key) {
    throw new Error(
      [
        "GROQ_API_KEY is not set, so the agent cannot reach the model.",
        "",
        "Fix it in three steps:",
        "  1. Get a free key from https://console.groq.com/keys",
        "  2. Add this line to the .env file in the project root:",
        "       GROQ_API_KEY=your_key_here",
        "  3. Run the command again.",
        "",
        ".env is already gitignored, so the key will not be committed.",
      ].join("\n"),
    );
  }

  return key;
}

export function hasGroqApiKey(): boolean {
  loadEnv();
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

/** The Groq model id to call. */
export function groqModelName(): string {
  loadEnv();
  return process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
}

// --------------------------------------------------------- provider choice

/**
 * Which service to use.
 *
 * MODEL_PROVIDER wins if it is set. Otherwise we pick whichever provider has a
 * key, preferring Groq. If neither has one we still answer "groq", so the error
 * the user sees names a single provider and tells them how to fix it.
 */
export function providerName(): ProviderName {
  loadEnv();
  const requested = process.env.MODEL_PROVIDER?.trim().toLowerCase();

  if (requested === "groq" || requested === "gemini") return requested;
  if (requested !== undefined && requested !== "") {
    throw new Error(
      `MODEL_PROVIDER must be "groq" or "gemini", got "${requested}".`,
    );
  }

  if (hasGroqApiKey()) return "groq";
  if (hasApiKey()) return "gemini";
  return "groq";
}

/** The model id for whichever provider is selected. Used for headers and errors. */
export function activeModelName(provider: ProviderName = providerName()): string {
  return provider === "groq" ? groqModelName() : modelName();
}
