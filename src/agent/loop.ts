/**
 * The autonomous reasoning loop.
 *
 * The model is given the world, the plan, the money and the damage, then left to
 * work. Each turn it reasons and asks for tool calls. We execute those against
 * the REAL prompt-2 tools, hand the results back (successes and rejections
 * alike), and go round again until it reports or we hit the cap.
 *
 * Nothing in here decides anything on the model's behalf. There is no fallback
 * that quietly repairs the trip if the agent does not. If the agent fails, the
 * run shows it failing, which is the honest thing for a demo to do.
 *
 * This file does not print. It reports through an observer, so the trace
 * printer is free to render however it likes.
 */

import type { Content, Part } from "@google/genai";

import type { BudgetState, TripState, World } from "../data/types.js";
import type { DisruptionOutcome } from "../events/engine.js";
import { executeToolCall, type ExecutionOutcome } from "./executor.js";
import type { AgentModel, ModelToolCall } from "./model.js";
import { NUDGE_MESSAGE, buildOpeningMessage } from "./prompts.js";

/** Stop after this many model turns, so a confused agent cannot run forever. */
const DEFAULT_MAX_TURNS = 14;

/** How many times we remind a silent model to finish before giving up. */
const MAX_NUDGES = 2;

/** One tool call and what it did. */
export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
  outcome: ExecutionOutcome;
  /** Money before and after, so the trace can show the effect. */
  budgetBefore: BudgetState;
  budgetAfter: BudgetState;
}

export interface AgentTurn {
  index: number;
  /** The model's own words. Empty when it went straight to a tool call. */
  reasoning: string;
  calls: RecordedCall[];
}

export type StopReason =
  /** The agent called notify_user. The normal ending. */
  | "reported"
  /** Hit the turn cap with the job unfinished. */
  | "max_turns"
  /** Stopped calling tools and would not report, even after being nudged. */
  | "gave_up";

export interface AgentRun {
  modelName: string;
  initialState: TripState;
  finalState: TripState;
  turns: AgentTurn[];
  /** The formatted traveller facing report, or null if it never got there. */
  notification: string | null;
  stopped: StopReason;
  /** Total tool calls, and how many the tools refused. */
  toolCallCount: number;
  rejectionCount: number;
}

/** How the loop reports progress. Every hook is optional. */
export interface AgentObserver {
  onStart?(info: { modelName: string; openingMessage: string; maxTurns: number }): void;
  onTurnStart?(index: number): void;
  onReasoning?(index: number, text: string): void;
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(call: RecordedCall): void;
  onNudge?(index: number): void;
  onFinish?(run: AgentRun): void;
}

export interface RunAgentOptions {
  model: AgentModel;
  world: World;
  state: TripState;
  /** The disruptions that just fired, in order. */
  outcomes: DisruptionOutcome[];
  observer?: AgentObserver;
  maxTurns?: number;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRun> {
  const { model, world, outcomes, observer } = options;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  const initialState = options.state;
  // The one piece of mutable bookkeeping in the whole system: which immutable
  // state is the current one. Every tool still returns a fresh object.
  let state = options.state;

  const openingMessage = buildOpeningMessage(world, state, outcomes);
  const contents: Content[] = [{ role: "user", parts: [{ text: openingMessage }] }];

  observer?.onStart?.({ modelName: model.name, openingMessage, maxTurns });

  const turns: AgentTurn[] = [];
  let notification: string | null = null;
  let stopped: StopReason = "max_turns";
  let nudges = 0;
  let toolCallCount = 0;
  let rejectionCount = 0;

  for (let index = 1; index <= maxTurns; index += 1) {
    observer?.onTurnStart?.(index);

    const modelTurn = await model.generate(contents);
    const turn: AgentTurn = { index, reasoning: modelTurn.text, calls: [] };
    turns.push(turn);

    if (modelTurn.text.length > 0) observer?.onReasoning?.(index, modelTurn.text);

    // Keep the model's turn in the conversation exactly as it came back.
    contents.push(modelTurn.content);

    if (modelTurn.toolCalls.length === 0) {
      // No tools asked for. Either it is done, or it has drifted into chatting.
      if (notification !== null) {
        stopped = "reported";
        break;
      }
      if (nudges >= MAX_NUDGES) {
        stopped = "gave_up";
        break;
      }
      nudges += 1;
      observer?.onNudge?.(index);
      contents.push({ role: "user", parts: [{ text: NUDGE_MESSAGE }] });
      continue;
    }

    // Execute every call the model asked for, in the order it asked.
    const responseParts: Part[] = [];
    let reported = false;

    for (const call of modelTurn.toolCalls) {
      observer?.onToolCall?.(call.name, call.args);

      const budgetBefore = state.budget;
      const outcome = executeToolCall(world, state, call.name, call.args);
      state = outcome.state;

      toolCallCount += 1;
      if (!outcome.ok) rejectionCount += 1;
      if (outcome.notificationMessage !== undefined) {
        notification = outcome.notificationMessage;
        reported = true;
      }

      const recorded: RecordedCall = {
        name: call.name,
        args: call.args,
        outcome,
        budgetBefore,
        budgetAfter: state.budget,
      };
      turn.calls.push(recorded);
      observer?.onToolResult?.(recorded);

      responseParts.push(toResponsePart(call, outcome));
    }

    contents.push({ role: "user", parts: responseParts });

    // The report is the last thing the agent does, so stop as soon as it lands.
    if (reported) {
      stopped = "reported";
      break;
    }
  }

  const run: AgentRun = {
    modelName: model.name,
    initialState,
    finalState: state,
    turns,
    notification,
    stopped,
    toolCallCount,
    rejectionCount,
  };

  observer?.onFinish?.(run);
  return run;
}

/** Pair a tool result back to the call that asked for it. */
function toResponsePart(call: ModelToolCall, outcome: ExecutionOutcome): Part {
  return {
    functionResponse: {
      ...(call.id !== undefined ? { id: call.id } : {}),
      name: call.name,
      response: outcome.payload,
    },
  };
}
