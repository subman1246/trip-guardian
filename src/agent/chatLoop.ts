/**
 * The chat turn loop.
 *
 * This is NOT runAgent from loop.ts, and that is a deliberate choice, not an
 * oversight. runAgent always opens with buildOpeningMessage ("something has
 * just gone wrong, repair this trip now") and will not stop until notify_user
 * lands or it gives up. That is exactly right for one scripted disruption. It
 * is the wrong shape for an open ended conversation, where most messages are a
 * quick question or a small instruction and forcing a traveller facing report
 * out of every reply would be strange. Reusing runAgent unmodified for chat
 * would have meant either mangling it into two behaviours or bending chat to
 * fit a report cycle it does not need, so this file gives chat its own turn
 * loop instead. It mirrors runAgent's shape closely on purpose: reason, call
 * tools, feed results back, repeat.
 *
 * WHAT IS GENUINELY REUSED, NOT REBUILT. The four real tools (via
 * chatTools.ts's dispatcher, which delegates to executor.ts unchanged), the
 * SAME TripState and World types and the ONE live pair the session holds (no
 * parallel state), the SAME AgentModel interface and the SAME two providers.
 * Nothing here does its own budget maths or its own world mutation, that is
 * still 100% the prompt-2 tools and the disruption engine.
 *
 * ---------------------------------------------------------------------------
 * THE TRIMMING RULE, READ THIS BEFORE CHANGING EITHER NUMBER BELOW.
 *
 * A growing, fully replayed transcript is what exhausted the previous quota:
 * every extra turn cost tokens for every turn that came before it, forever.
 * Chat avoids that two separate ways.
 *
 *   1. THE TRIP SUMMARY IS NEVER STORED. buildContextMessage rebuilds a
 *      description of the live World and TripState FRESH at the top of every
 *      single call, from describeWorld/describeTripState (the same functions
 *      the scripted run already uses). Its size depends only on the CURRENT
 *      trip, never on how long the conversation has run.
 *   2. THE BACK AND FORTH IS TRIMMED, NOT SUMMARISED. Only the last
 *      MAX_HISTORY_ENTRIES entries of actual conversation (the traveller's
 *      messages, the model's own turns, and the tool results that followed
 *      them) are kept at all, and that trim happens once per exchange, right
 *      before the result is handed back to be persisted. Anything older is
 *      discarded outright. That is a deliberately simple rule: a small, fixed,
 *      easy to reason about ceiling beats a clever compaction scheme that can
 *      still grow unbounded in some edge case.
 *
 * A model turn counts as one entry, and one batch of tool results counts as
 * one entry (matching how loop.ts's own contents array is shaped), so
 * MAX_HISTORY_ENTRIES = 16 keeps roughly the last 8 round trips in view.
 * ---------------------------------------------------------------------------
 */

import type { Content, Part } from "@google/genai";

import type { TripState, World } from "../data/types.js";
import { describeTripState, describeWorld } from "./prompts.js";
import { executeChatToolCall, type ChatExecutionOutcome } from "./chatTools.js";
import type { AgentModel, ModelToolCall } from "./model.js";

/** See the big comment above. */
export const MAX_HISTORY_ENTRIES = 16;

/**
 * Turns allowed within ONE exchange (one traveller message). Kept small on
 * purpose: chat should feel snappy, and an exchange that needs more than a
 * handful of tool calls to settle is better handed a follow up message than
 * left to loop silently.
 */
const MAX_TURNS_PER_MESSAGE = 4;

export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
  outcome: ChatExecutionOutcome;
}

/** How chat reports progress. Every hook is optional, same convention as AgentObserver. */
export interface ChatObserver {
  onTurnStart?(index: number): void;
  onReasoning?(index: number, text: string): void;
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(call: ChatToolCall): void;
  /** Fired only when a tool call in this exchange was notify_user. */
  onNotification?(message: string): void;
}

export interface RunChatTurnOptions {
  model: AgentModel;
  world: World;
  state: TripState;
  /** The pristine, full length catalogue, used to name an option this trip does not carry. */
  baseWorld: World;
  /** Already trimmed by a previous call. See MAX_HISTORY_ENTRIES. */
  history: Content[];
  userMessage: string;
  observer?: ChatObserver;
}

export interface ChatTurnResult {
  world: World;
  state: TripState;
  /** Trimmed and ready to persist as is for the next call. */
  history: Content[];
  /** The plain reply text to show the traveller for this exchange. */
  reply: string;
  toolCallCount: number;
  rejectionCount: number;
}

export async function runChatTurn(options: RunChatTurnOptions): Promise<ChatTurnResult> {
  const { model, baseWorld, observer } = options;
  let world = options.world;
  let state = options.state;

  const history: Content[] = [
    ...options.history,
    { role: "user", parts: [{ text: options.userMessage }] },
  ];

  let toolCallCount = 0;
  let rejectionCount = 0;
  let reply = "";
  let lastReasoning = "";

  for (let index = 1; index <= MAX_TURNS_PER_MESSAGE; index += 1) {
    observer?.onTurnStart?.(index);

    // Rebuilt fresh every turn. See the trimming rule above.
    const contents: Content[] = [
      { role: "user", parts: [{ text: buildContextMessage(world, state) }] },
      ...history,
    ];

    const modelTurn = await model.generate(contents);
    history.push(modelTurn.content);

    if (modelTurn.text.length > 0) {
      lastReasoning = modelTurn.text;
      observer?.onReasoning?.(index, modelTurn.text);
    }

    if (modelTurn.toolCalls.length === 0) {
      // Nothing left to do. Either it answered a question, or it is finished
      // acting and is telling the traveller so in its own words.
      reply = modelTurn.text;
      break;
    }

    const responseParts: Part[] = [];

    for (const call of modelTurn.toolCalls) {
      observer?.onToolCall?.(call.name, call.args);

      const outcome = executeChatToolCall(world, state, call.name, call.args, baseWorld);
      world = outcome.world;
      state = outcome.state;

      toolCallCount += 1;
      if (!outcome.ok) rejectionCount += 1;

      const recorded: ChatToolCall = { name: call.name, args: call.args, outcome };
      observer?.onToolResult?.(recorded);
      if (outcome.notificationMessage !== undefined) {
        observer?.onNotification?.(outcome.notificationMessage);
      }

      responseParts.push(toResponsePart(call, outcome));
    }

    history.push({ role: "user", parts: responseParts });
  }

  if (reply === "") {
    reply =
      lastReasoning ||
      "I made the changes above, but I do not have anything further to add right now.";
  }

  return {
    world,
    state,
    // Trim once, right before this goes back to be persisted, so the very next
    // exchange starts from a bounded window rather than an ever growing one.
    history: history.slice(-MAX_HISTORY_ENTRIES),
    reply,
    toolCallCount,
    rejectionCount,
  };
}

/**
 * What the model is told at the top of every turn: the tools available, the
 * live world, the live plan. Regenerated fresh every call, never accumulated.
 */
function buildContextMessage(world: World, state: TripState): string {
  return [CHAT_INSTRUCTION, "", describeWorld(world), "", describeTripState(world, state)].join(
    "\n",
  );
}

const CHAT_INSTRUCTION = `
You are Trip Guardian, talking with the traveller directly. You already know how to defend their
itinerary and their budget, you are simply doing it through conversation now instead of reacting
to one scripted event.

WHAT YOU CAN DO

You have the same four tools you always have: search_alternatives, rebook_slot,
reallocate_budget, notify_user. You also have one more: apply_disruption. Use apply_disruption
ONLY when the traveller tells you something real just happened to their trip (a cancellation, a
closure, a price change), never to invent trouble yourself and never as a way to change a booking
you simply feel like changing, that is what rebook_slot and reallocate_budget are for. Point it at
the exact option id if the traveller named the thing, or at a time slot and a category together if
they only described where it sits, and it acts on whatever is actually booked there.

HOW TO ANSWER

A plain question gets a plain answer in your own words, no tool call required. An instruction or a
description of damage gets acted on with the real tools, exactly as it would if a scripted
disruption had fired. If a tool refuses something, that is the budget holding, not a bug: read the
reason, look for a legal way through (search first, reallocate before you rebook), and if there is
none, say so plainly rather than pretending it worked.

You do not have to call notify_user for every message. That tool is for a final traveller facing
report, not for a quick reply. Never describe a booking or a price you did not just get back from
a tool. Never use em dashes.
`.trim();

function toResponsePart(call: ModelToolCall, outcome: ChatExecutionOutcome): Part {
  return {
    functionResponse: {
      ...(call.id !== undefined ? { id: call.id } : {}),
      name: call.name,
      response: outcome.payload,
    },
  };
}
