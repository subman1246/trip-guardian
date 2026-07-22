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

import { CATEGORIES, type BudgetState, type TimeSlot, type TripState, type World } from "../data/types.js";
import type { DisruptionOutcome } from "../events/engine.js";
import { formatINR } from "../world/money.js";
import { executeToolCall, type ExecutionOutcome } from "./executor.js";
import type { AgentModel, ModelToolCall } from "./model.js";
import { NUDGE_MESSAGE, buildDiscrepancyMessage, buildOpeningMessage } from "./prompts.js";

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
  /** The agent called notify_user and the report matched the trip. The normal ending. */
  | "reported"
  /**
   * The agent reported, was told twice that the report did not match the trip,
   * and reported anyway. The run is over but the summary cannot be trusted.
   */
  | "reported_with_discrepancy"
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
  /**
   * Ways the final report disagrees with the final trip, in plain words. Empty on
   * a clean run. Anything in here should be shown, loudly: the budget can hold and
   * the report can still be false.
   */
  unresolved: string[];
}

/** How the loop reports progress. Every hook is optional. */
export interface AgentObserver {
  onStart?(info: { modelName: string; openingMessage: string; maxTurns: number }): void;
  onTurnStart?(index: number): void;
  onReasoning?(index: number, text: string): void;
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(call: RecordedCall): void;
  /** reason says what the agent is being sent back for, so a trace can be specific. */
  onNudge?(index: number, reason?: string): void;
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

  // The slots the disruptions actually emptied. These are the ones the agent owes
  // an answer for, either a booking or an admission. Slots that were never filled
  // are not its problem.
  const emptiedSlots = [
    ...new Set(
      outcomes
        .map((outcome) => outcome.emptiedSlot)
        .filter((slot): slot is TimeSlot => slot !== undefined),
    ),
  ];

  const turns: AgentTurn[] = [];
  let notification: string | null = null;
  let stopped: StopReason = "max_turns";
  let nudges = 0;
  let toolCallCount = 0;
  let rejectionCount = 0;

  /**
   * Where the report and the trip disagree. Empty means the agent can finish.
   *
   * An empty slot on its own is NOT a problem: sometimes nothing can fill one and
   * saying so is the right answer. The problem is a report that does not admit it.
   * An overspent category is a problem no wording can excuse.
   */
  const openProblems = (): string[] => {
    const problems: string[] = [];
    const filled = new Set(state.itinerary.map((item) => item.timeSlot));

    for (const slot of emptiedSlots) {
      if (filled.has(slot)) continue;
      if (notification !== null && admitsEmptySlot(notification, slot)) continue;
      problems.push(
        `${slot} is still empty, and your report does not say so. Either book something there or say plainly that you are leaving it empty and why.`,
      );
    }

    for (const category of CATEGORIES) {
      const ledger = state.budget.byCategory[category];
      if (ledger.remaining < 0) {
        problems.push(
          `${category} is still ${formatINR(-ledger.remaining)} over its allocation of ${formatINR(ledger.allocated)}.`,
        );
      }
    }

    return problems;
  };

  /**
   * Called when the agent has reported. Returns true when the run may end.
   * Otherwise it sends the agent back, reusing the same nudge budget as the
   * silent case so a confused model still cannot loop forever.
   */
  const settleReport = (index: number): boolean => {
    const problems = openProblems();
    if (problems.length === 0) {
      stopped = "reported";
      return true;
    }
    if (nudges >= MAX_NUDGES) {
      // Out of nudges and still wrong. End, but never as a clean success.
      stopped = "reported_with_discrepancy";
      return true;
    }

    nudges += 1;
    observer?.onNudge?.(index, problems.join(" "));
    contents.push({ role: "user", parts: [{ text: buildDiscrepancyMessage(problems) }] });
    return false;
  };

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
        if (settleReport(index)) break;
        continue;
      }
      if (nudges >= MAX_NUDGES) {
        stopped = "gave_up";
        break;
      }
      nudges += 1;
      observer?.onNudge?.(index, "no tool calls yet and no report");
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

    // The report is normally the last thing the agent does, but only once it
    // actually describes the trip it is handing back.
    if (reported && settleReport(index)) break;
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
    unresolved: openProblems(),
  };

  observer?.onFinish?.(run);
  return run;
}

/**
 * Words that mean a slot was left unfilled. If one of these sits near the slot's
 * name in the report, the agent has owned the gap.
 */
const ADMISSION = new RegExp(
  [
    "empt",
    "unfilled",
    "not booked",
    "nothing booked",
    "no booking",
    "without a booking",
    "unbooked",
    "no option",
    "no alternative",
    "no replacement",
    "left open",
    "left free",
    "left it open",
    "left unbooked",
    "gap",
    "could not",
    "cannot",
    "can not",
    "unable",
    "nothing (?:is |was |we |i )?(?:available|left|open)",
    "remains? free",
    "stays? free",
  ].join("|"),
  "i",
);

/**
 * Does the report admit that this slot is empty?
 *
 * Deliberately a heuristic, and deliberately a narrow one. It looks for the slot
 * name in the report and then for an admission near it. Both ways of being wrong
 * are safe: a missed admission costs one nudge asking the agent to be explicit,
 * and a false admission only means the discrepancy warning does not fire on a
 * report that was probably fine anyway. Nothing here can change the itinerary or
 * the budget, so it cannot let a bad trip through as a good one.
 */
function admitsEmptySlot(notification: string, slot: TimeSlot): boolean {
  // The report is wrapped to a fixed width, so a slot name can straddle a line
  // break. Flatten the whitespace before looking for it.
  const flat = notification.replace(/\s+/g, " ");
  const needle = slot.toLowerCase();
  const haystack = flat.toLowerCase();

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;

    // Read around the mention: enough before to catch "nothing could fill Day 2
    // Morning", enough after to catch "Day 2 Morning is left empty".
    const window = flat.slice(Math.max(0, at - 120), at + needle.length + 220);
    if (ADMISSION.test(window)) return true;

    from = at + needle.length;
  }
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
