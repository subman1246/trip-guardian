/**
 * The shape every agent tool returns.
 *
 * Tools never throw for an expected problem and never print. They return a
 * result the caller can inspect. In prompt 3 the agent reads exactly this shape
 * to decide what to do next, so failures have to be as informative as successes.
 *
 * Every result carries a state, including failures, where it is the unchanged
 * state. That means a caller can always write `state = result.state` and keep
 * going without branching first.
 */

import type { TripState } from "../data/types.js";

/**
 * Machine readable failure reasons. The agent branches on these, the summary
 * string is for humans.
 */
export type FailureReason =
  /** No option in the world has that id. */
  | "unknown_option"
  /** A disruption has closed this option, it cannot be booked. */
  | "option_unavailable"
  /** The option named as the one to replace is not in the itinerary. */
  | "not_booked"
  /** That option is already in the itinerary. */
  | "already_booked"
  /** The replacement belongs to a different time slot than the one it would fill. */
  | "slot_mismatch"
  /** The replacement is a different category (a hotel cannot replace a train). */
  | "category_mismatch"
  /** The slot already holds an option of this category, say which one to replace. */
  | "slot_occupied"
  /** The action would push a category past its allocation. */
  | "category_would_go_negative"
  /** The source category does not have that much unspent allocation to give. */
  | "insufficient_allocation"
  /** Moving budget from a category to itself does nothing. */
  | "same_category"
  /** Amount was not a positive whole number of rupees. */
  | "invalid_amount";

export interface ToolSuccess<TDetails> {
  ok: true;
  /** One line a human can read, for example "Swapped Amber Fort for City Palace, saved Rs 500". */
  summary: string;
  /** The state after the action. Read only tools return the state unchanged. */
  state: TripState;
  /** Everything the caller needs to explain what changed. */
  details: TDetails;
}

export interface ToolFailure {
  ok: false;
  reason: FailureReason;
  /** One line a human can read, saying why it did not happen. */
  summary: string;
  /** The unchanged state. A failed tool call never damages the trip. */
  state: TripState;
  /** How many rupees short the action was, when the reason is about money. */
  shortfall?: number;
}

export type ToolResult<TDetails> = ToolSuccess<TDetails> | ToolFailure;

/** Build a failure result. Keeps the tools themselves free of boilerplate. */
export function fail(
  state: TripState,
  reason: FailureReason,
  summary: string,
  extra: { shortfall?: number } = {},
): ToolFailure {
  return { ok: false, reason, summary, state, ...extra };
}

/** Build a success result. */
export function succeed<TDetails>(
  state: TripState,
  summary: string,
  details: TDetails,
): ToolSuccess<TDetails> {
  return { ok: true, summary, state, details };
}
