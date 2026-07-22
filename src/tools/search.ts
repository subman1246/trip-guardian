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
   * Sort the options the category can already afford to the top. Affordability is
   * measured on the delta, since swapping out the current pick frees its price.
   *
   * This SORTS, it never removes. An option that exists but cannot be paid for
   * yet is still an option: the answer to it is to free up budget, not to
   * conclude the slot is unfillable. Filtering those out once made an empty slot
   * with one expensive option look identical to a slot with no options at all,
   * and the agent gave up on a repair that was two moves away.
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
  /** Rupees the category is short for this swap. Zero when it already fits. */
  shortfall: number;
}

export interface SearchDetails {
  timeSlot?: TimeSlot;
  category?: Category;
  /** What is booked here now, or null if the slot is empty (or ambiguous). */
  current: Option | null;
  /** Everything that exists and is open, affordable or not. */
  alternatives: Alternative[];
  /** How many of those need more budget than the category currently has. */
  shortOfBudget: number;
  /**
   * What genuinely did not come back, so the agent is not left wondering.
   * Being unaffordable is not in here, on purpose: it is a reason to find money,
   * not a reason to hide the option.
   */
  excluded: {
    alreadyBooked: number;
    unavailable: number;
    overMaxPrice: number;
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

  const excluded = { alreadyBooked: 0, unavailable: 0, overMaxPrice: 0 };
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

    // Swapping refunds the current pick, so only the difference has to fit. On an
    // empty slot there is nothing to refund, so the delta is the whole price.
    const refund = current !== null && current.category === option.category ? current.price : 0;
    const priceDelta = option.price - refund;
    const remaining = state.budget.byCategory[option.category].remaining;
    const fitsRemainingBudget = priceDelta <= remaining;

    // Unaffordable options are annotated, never dropped.
    alternatives.push({
      option,
      priceDelta,
      fitsRemainingBudget,
      shortfall: fitsRemainingBudget ? 0 : priceDelta - remaining,
    });
  }

  const byChosenKey =
    constraints.sortBy === "closest_price"
      ? (a: Alternative, b: Alternative) => Math.abs(a.priceDelta) - Math.abs(b.priceDelta)
      : (a: Alternative, b: Alternative) => a.option.price - b.option.price;

  alternatives.sort((a, b) => {
    // The affordability preference only decides the order.
    if (
      constraints.mustFitRemainingBudget === true &&
      a.fitsRemainingBudget !== b.fitsRemainingBudget
    ) {
      return a.fitsRemainingBudget ? -1 : 1;
    }
    return byChosenKey(a, b);
  });

  const shortOfBudget = alternatives.filter((alternative) => !alternative.fitsRemainingBudget).length;

  // Read only: the state goes back exactly as it came in.
  return succeed(state, buildSummary(query, alternatives, excluded, shortOfBudget), {
    ...(query.timeSlot !== undefined ? { timeSlot: query.timeSlot } : {}),
    ...(query.category !== undefined ? { category: query.category } : {}),
    current,
    alternatives,
    shortOfBudget,
    excluded,
  });
}

/**
 * The sentence the agent reads first, so it has to carry the distinction the
 * whole tool exists to protect: "there is nothing here" and "there is something
 * here you cannot pay for yet" must never read the same.
 */
function buildSummary(
  query: SearchQuery,
  alternatives: Alternative[],
  excluded: SearchDetails["excluded"],
  shortOfBudget: number,
): string {
  const where = describeQuery(query);
  const cheapest = alternatives[0];

  if (cheapest === undefined) {
    const notes: string[] = [];
    if (excluded.unavailable > 0) {
      notes.push(`${excluded.unavailable} option(s) here are closed by a disruption`);
    }
    if (excluded.overMaxPrice > 0) {
      notes.push(`${excluded.overMaxPrice} option(s) exist but sit above the maxPrice you set`);
    }
    if (excluded.alreadyBooked > 0) {
      notes.push(`${excluded.alreadyBooked} already in the itinerary`);
    }
    return notes.length === 0
      ? `Nothing exists for ${where}. This slot genuinely cannot be filled.`
      : `Nothing came back for ${where}: ${notes.join(", ")}.`;
  }

  const head = `Found ${alternatives.length} option(s) for ${where}, from ${formatINR(cheapest.option.price)}.`;

  if (shortOfBudget === 0) {
    return `${head} All of them fit what the category has left.`;
  }

  const smallestShortfall = Math.min(
    ...alternatives.filter((a) => !a.fitsRemainingBudget).map((a) => a.shortfall),
  );
  const affordable = alternatives.length - shortOfBudget;

  if (affordable === 0) {
    return (
      `${head} NONE of them fit what the category has left yet, the closest is short by ` +
      `${formatINR(smallestShortfall)}. They exist and they are bookable. Free up that much ` +
      `first (downgrade another booking to spend less, then reallocate_budget), then rebook. ` +
      `Do not treat this slot as impossible.`
    );
  }

  return (
    `${head} ${affordable} fit what the category has left, ${shortOfBudget} need more money ` +
    `(the closest of those is short by ${formatINR(smallestShortfall)}, which you can free up ` +
    `by spending less elsewhere and reallocating).`
  );
}

function describeQuery(query: SearchQuery): string {
  const parts: string[] = [];
  if (query.timeSlot !== undefined) parts.push(query.timeSlot);
  if (query.category !== undefined) parts.push(query.category);
  return parts.length > 0 ? parts.join(" ") : "the whole trip";
}
