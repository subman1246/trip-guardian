/**
 * The Groq implementation of AgentModel.
 *
 * Groq speaks the OpenAI chat completions format, which is a different shape to
 * the one the loop passes around. Rather than change the loop, this provider
 * owns the translation in both directions:
 *
 *   loop's Content[]  ->  OpenAI messages   (on the way out)
 *   OpenAI message    ->  loop's ModelTurn  (on the way back)
 *
 * That keeps loop.ts, executor.ts and trace.ts completely unaware that there is
 * more than one provider. The tools are not redefined here either, they are
 * translated from the same declarations Gemini gets.
 *
 * No SDK. Groq's endpoint is one POST, and Node has fetch built in, so adding a
 * dependency to send a single JSON body would not earn its keep.
 */

import type { Content, FunctionDeclaration, Part, Schema } from "@google/genai";

import { groqModelName, requireGroqApiKey } from "./config.js";
import { AGENT_FUNCTION_DECLARATIONS } from "./declarations.js";
import type { AgentModel, ModelToolCall, ModelTurn } from "./model.js";
import { SYSTEM_INSTRUCTION } from "./prompts.js";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** Matches the Gemini provider, so the two behave the same way. */
const TEMPERATURE = 0.4;

/**
 * Some open models emit tool call syntax that Groq's own parser rejects, which
 * comes back as a 400. It is a coin flip rather than a bad request, so the same
 * call often works on a second try. Weaker models fail this way often enough
 * that it is worth retrying rather than losing the run.
 */
const MAX_ATTEMPTS = 3;

function isMalformedToolCall(status: number, body: string): boolean {
  return (
    status === 400 &&
    /Failed to call a function|tool call validation failed|tool_use_failed/i.test(body)
  );
}

/** Transient server side failures are worth one more go as well. */
function isTransient(status: number): boolean {
  return status === 500 || status === 502 || status === 503;
}

/**
 * The free tier caps tokens per minute, and a reasoning model burns through
 * that quickly because the conversation grows every turn. Groq tells us exactly
 * how long to wait, so waiting is nearly always better than losing the run.
 */
const MAX_RATE_LIMIT_WAITS = 4;

/** Longest single pause we will take before giving up and reporting the limit. */
const MAX_WAIT_MS = 30_000;

/** Read Groq's "Please try again in 4.83s" hint. Falls back to a short pause. */
function retryAfterMs(body: string, headers: Headers): number {
  const header = Number(headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_WAIT_MS);

  const match = body.match(/try again in ([\d.]+)\s*(ms|s|m)\b/i);
  if (match?.[1]) {
    const value = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    const ms = unit === "ms" ? value : unit === "m" ? value * 60_000 : value * 1000;
    // A little padding, since the window is measured on their clock, not ours.
    if (Number.isFinite(ms)) return Math.min(ms + 500, MAX_WAIT_MS);
  }
  return 5_000;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The slice of the OpenAI wire format we actually use.

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiResponse {
  choices?: {
    message?: {
      content?: string | null;
      /**
       * Reasoning models on Groq (the gpt-oss family) put their working here
       * rather than in content, and often send tool calls with no content at
       * all. Without this the trace would show decisions and no thinking.
       */
      reasoning?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }[];
}

export interface GroqOptions {
  /**
   * Called when we are pausing for the per minute limit. The provider does not
   * print, so the caller decides how to show that the run is waiting rather
   * than stuck.
   */
  onRateLimit?: (waitMs: number, attempt: number) => void;
  /**
   * Tools beyond the four prompt-2 ones. Omit this and behaviour is exactly
   * what it always was: the scripted scenario run never sets it. Chat is the
   * only caller that does, adding apply_disruption (see chatDeclarations.ts).
   */
  declarations?: FunctionDeclaration[];
}

export function createGroqModel(options: GroqOptions = {}): AgentModel {
  const apiKey = requireGroqApiKey();
  const model = groqModelName();
  const { onRateLimit } = options;
  const tools = options.declarations === undefined ? OPENAI_TOOLS : toOpenAiTools(options.declarations);

  return {
    name: model,

    async generate(contents: Content[]): Promise<ModelTurn> {
      const body = JSON.stringify({
        model,
        messages: toOpenAiMessages(contents),
        tools,
        tool_choice: "auto",
        temperature: TEMPERATURE,
      });

      let response!: Response;
      let errorBody = "";
      let malformedRetries = 0;
      let rateLimitWaits = 0;

      // Two independent budgets: one for the model fumbling a tool call, one
      // for waiting out the per minute token ceiling.
      for (;;) {
        response = await fetch(GROQ_ENDPOINT, {
          method: "POST",
          headers: {
            // The key goes in the header and nowhere else. It is never logged.
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        });

        if (response.ok) break;
        errorBody = await response.text();

        if (response.status === 429 && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
          rateLimitWaits += 1;
          const wait = retryAfterMs(errorBody, response.headers);
          onRateLimit?.(wait, rateLimitWaits);
          await delay(wait);
          continue;
        }

        const fumbled =
          isMalformedToolCall(response.status, errorBody) || isTransient(response.status);
        if (fumbled && malformedRetries < MAX_ATTEMPTS - 1) {
          malformedRetries += 1;
          await delay(400 * malformedRetries);
          continue;
        }

        break;
      }

      if (!response.ok) {
        // Shape the failure so the shared explainer can read the status out of it.
        throw new Error(
          JSON.stringify({
            error: {
              code: response.status,
              provider: "groq",
              message: extractErrorMessage(errorBody) ?? errorBody.slice(0, 300),
            },
          }),
        );
      }

      const payload = (await response.json()) as OpenAiResponse;
      const message = payload.choices?.[0]?.message;

      const spoken = (message?.content ?? "").trim();
      const reasoning = (message?.reasoning ?? "").trim();

      const toolCalls: ModelToolCall[] = (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        args: parseArguments(call.function.arguments),
      }));

      // The trace shows whatever the model actually thought, falling back to the
      // reasoning field when it said nothing out loud. The conversation itself
      // only carries the spoken content, since private reasoning is not ours to
      // replay back to the API.
      return {
        text: spoken.length > 0 ? spoken : reasoning,
        toolCalls,
        content: toContent(spoken, toolCalls),
      };
    },
  };
}

// ------------------------------------------------- outbound: loop to OpenAI

/** Translate the loop's conversation into OpenAI messages. */
function toOpenAiMessages(contents: Content[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [
    { role: "system", content: SYSTEM_INSTRUCTION },
  ];

  for (const content of contents) {
    const parts = content.parts ?? [];

    if (content.role === "model") {
      const text = collectText(parts);
      const toolCalls = parts
        .filter((part) => part.functionCall !== undefined)
        .map((part, index): OpenAiToolCall => {
          const call = part.functionCall;
          return {
            id: call?.id ?? `call_${index}`,
            type: "function",
            function: {
              name: call?.name ?? "",
              arguments: JSON.stringify(call?.args ?? {}),
            },
          };
        });

      // An assistant turn with tool calls carries null content by convention.
      messages.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // A user turn is either ordinary text or a batch of tool results. The loop
    // never mixes the two, but handle both so order is always preserved.
    const text = collectText(parts);
    if (text.length > 0) {
      messages.push({ role: "user", content: text });
    }

    for (const part of parts) {
      const response = part.functionResponse;
      if (response === undefined) continue;
      messages.push({
        role: "tool",
        // The id round trips: Groq issues it, the loop echoes it back here.
        tool_call_id: response.id ?? response.name ?? "",
        content: JSON.stringify(response.response ?? {}),
      });
    }
  }

  return messages;
}

function collectText(parts: Part[]): string {
  return parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

// ------------------------------------------------- inbound: OpenAI to loop

/** Rebuild the loop's Content shape from what the model just said. */
function toContent(text: string, toolCalls: ModelToolCall[]): Content {
  const parts: Part[] = [];
  if (text.length > 0) parts.push({ text });

  for (const call of toolCalls) {
    parts.push({
      functionCall: {
        ...(call.id !== undefined ? { id: call.id } : {}),
        name: call.name,
        args: call.args,
      },
    });
  }

  return { role: "model", parts };
}

/**
 * Tool arguments arrive as a JSON string. A model can get that wrong, and when
 * it does we hand back an empty object so the executor rejects it with a proper
 * message instead of the run dying on a parse error.
 */
function parseArguments(raw: string): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function extractErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------ tool translation

/**
 * The same four tools Gemini gets, in OpenAI's shape.
 *
 * Gemini schemas use an uppercase type enum ("STRING"), JSON Schema wants
 * lowercase ("string"), so the types are folded on the way through.
 */
function toOpenAiTools(declarations: FunctionDeclaration[]): unknown[] {
  return declarations.map((declaration) => ({
    type: "function",
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.parameters
        ? toJsonSchema(declaration.parameters)
        : { type: "object", properties: {} },
    },
  }));
}

function toJsonSchema(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (schema.type !== undefined) out["type"] = String(schema.type).toLowerCase();
  if (schema.description !== undefined) out["description"] = schema.description;
  if (schema.enum !== undefined) out["enum"] = schema.enum;
  if (schema.items !== undefined) out["items"] = toJsonSchema(schema.items);

  if (schema.properties !== undefined) {
    out["properties"] = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]),
    );
  }
  // An empty required list is noise, and some models treat it as meaningful.
  if (schema.required !== undefined && schema.required.length > 0) {
    out["required"] = schema.required;
  }

  return out;
}

/** Built once, since the declarations never change at runtime. */
const OPENAI_TOOLS = toOpenAiTools(AGENT_FUNCTION_DECLARATIONS);
