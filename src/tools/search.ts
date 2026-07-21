/**
 * Agent tool: search_alternatives
 *
 * Read only. Given a time slot and/or a category, return the options that could
 * fill it, excluding whatever is already booked and anything a disruption has
 * closed. This is how the agent discovers its choices before committing.
 */

import type { Category, Option, TimeSlot, TripState, World } from "../data/types.js";
import { formatINR } from "../world/money.js";
import { isAvailable } from "../world/state.js";
import { succeed, type ToolResult } from "./types.js";

export interface SearchConstraints {
  /** Hard ceiling on the option's own price, in whole rupees. */
  maxPrice?: number;
  /**
   * Only return options the category can actually afford. Affordability is
   * measured on the delta, since swapping out the current pick frees its price.
   */
  mustFitRemainingBudget?: boolean;
  /** "cheapest" is the default. "closest_price" keeps the plan's shape. */
  sortBy?: "cheapest" | "closest_price";
}

/**
 * At least one of timeSlot or category should be given. The "Trip" slot holds
 * both a stay and a local transport option, so pass a category alongside it if
 * you want the price comparison to mean anything.
 */
export interface SearchQuery {
  timeSlot?: TimeSlot;
  category?: Category;
  constraints?: SearchConstraints;
}

export interface Alternative {
  option: Option;
  /** New price minus the currently booked price. Negative means it saves money. */
  priceDelta: number;
  /** Whether this swap fits what the category has left. */
  fitsRemainingBudget: boolean;
}

export interface SearchDetails {
  timeSlot?: TimeSlot;
  category?: Category;
  /** What is booked here now, or null if the slot is empty (or ambiguous). */
  current: Option | null;
  alternatives: Alternative[];
  /** What got filtered out, so the agent is not left wondering. */
  excluded: {
    alreadyBooked: number;
    unavailable: number;
    overMaxPrice: number;
    overBudget: number;
  };
}

export function searchAlternatives(
  world: World,
  state: TripState,
  query: SearchQuery,
): ToolResult<SearchDetails> {
  const constraints = query.constraints ?? {};

  // The pool is everything matching the slot and category filters given.
  const matchesQuery = (option: Option): boolean =>
    (query.timeSlot === undefined || option.timeSlot === query.timeSlot) &&
    (query.category === undefined || option.category === query.category);

  const pool = world.options.filter(matchesQuery);

  // What is booked inside that pool right now. Exactly one means we can quote a
  // meaningful price delta, zero means the slot is empty (a cancellation), and
  // more than one means the query was too broad to have a single "current".
  const bookedIds = new Set(state.itinerary.map((item) => item.optionId));
  const bookedInPool = pool.filter((option) => bookedIds.has(option.id));
  const current = bookedInPool.length === 1 ? (bookedInPool[0] ?? null) : null;

  const excluded = { alreadyBooked: 0, unavailable: 0, overMaxPrice: 0, overBudget: 0 };
  const alternatives: Alternative[] = [];

  for (const option of pool) {
    if (bookedIds.has(option.id)) {
      excluded.alreadyBooked += 1;
      continue;
    }
    if (!isAvailable(option)) {
      excluded.unavailable += 1;
      continue;
    }
    if (constraints.maxPrice !== undefined && option.price > constraints.maxPrice) {
      excluded.overMaxPrice += 1;
      continue;
    }

    // Swapping refunds the current pick, so only the difference has to fit.
    const refund = current !== null && current.category === option.category ? current.price : 0;
    const priceDelta = option.price - refund;
    const fitsRemainingBudget = priceDelta <= state.budget.byCategory[option.category].remaining;

    if (constraints.mustFitRemainingBudget === true && !fitsRemainingBudget) {
      excluded.overBudget += 1;
      continue;
    }

    alternatives.push({ option, priceDelta, fitsRemainingBudget });
  }

  if (constraints.sortBy === "closest_price") {
    alternatives.sort((a, b) => Math.abs(a.priceDelta) - Math.abs(b.priceDelta));
  } else {
    alternatives.sort((a, b) => a.option.price - b.option.price);
  }

  const where = describeQuery(query);
  const summary =
    alternatives.length === 0
      ? `No alternatives available for ${where}.`
      : `Found ${alternatives.length} alternative(s) for ${where}, from ${formatINR(
          alternatives[0]?.option.price ?? 0,
        )}.`;

  // Read only: the state goes back exactly as it came in.
  return succeed(state, summary, {
    ...(query.timeSlot !== undefined ? { timeSlot: query.timeSlot } : {}),
    ...(query.category !== undefined ? { category: query.category } : {}),
    current,
    alternatives,
    excluded,
  });
}

function describeQuery(query: SearchQuery): string {
  const parts: string[] = [];
  if (query.timeSlot !== undefined) parts.push(query.timeSlot);
  if (query.category !== undefined) parts.push(query.category);
  return parts.length > 0 ? parts.join(" ") : "the whole trip";
}
