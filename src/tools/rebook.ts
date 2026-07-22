/**
 * Agent tool: rebook_slot
 *
 * Swap one option in the itinerary for another, or fill a slot a disruption
 * emptied. Returns a new TripState with the budget recomputed.
 *
 * Everything is checked before anything changes, so a rejected rebooking leaves
 * the trip exactly as it was.
 */

import type { Category, CategoryLedger, Option, TimeSlot, TripState, World } from "../data/types.js";
import { formatINR } from "../world/money.js";
import { isAvailable, withItinerary } from "../world/state.js";
import { fail, succeed, type ToolResult } from "./types.js";

export interface RebookDetails {
  timeSlot: TimeSlot;
  category: Category;
  /** What came out of the plan, or null when we filled an empty slot. */
  removed: Option | null;
  added: Option;
  /** Added price minus removed price. Negative means the swap saved money. */
  priceDelta: number;
  categoryBefore: CategoryLedger;
  categoryAfter: CategoryLedger;
}

/**
 * Pass oldOptionId as null to fill a slot that is currently empty, for example
 * right after a cancellation. The slot is taken from the new option itself.
 */
export function rebookSlot(
  world: World,
  state: TripState,
  oldOptionId: string | null,
  newOptionId: string,
): ToolResult<RebookDetails> {
  const added = world.options.find((option) => option.id === newOptionId);
  if (!added) {
    return fail(state, "unknown_option", `There is no option with id "${newOptionId}".`);
  }
  if (!isAvailable(added)) {
    return fail(
      state,
      "option_unavailable",
      `"${added.name}" is no longer available, it cannot be booked.`,
    );
  }
  if (state.itinerary.some((item) => item.optionId === newOptionId)) {
    return fail(state, "already_booked", `"${added.name}" is already in the itinerary.`);
  }

  // Work out what, if anything, is coming out of the plan.
  let removed: Option | null = null;

  if (oldOptionId !== null) {
    if (!state.itinerary.some((item) => item.optionId === oldOptionId)) {
      return fail(state, "not_booked", `"${oldOptionId}" is not in the itinerary, nothing to replace.`);
    }
    const existing = world.options.find((option) => option.id === oldOptionId);
    if (!existing) {
      return fail(state, "unknown_option", `There is no option with id "${oldOptionId}".`);
    }
    if (existing.timeSlot !== added.timeSlot) {
      return fail(
        state,
        "slot_mismatch",
        `"${added.name}" is a ${added.timeSlot} option, it cannot replace a ${existing.timeSlot} booking.`,
      );
    }
    if (existing.category !== added.category) {
      return fail(
        state,
        "category_mismatch",
        `"${added.name}" is ${added.category}, it cannot replace the ${existing.category} booking "${existing.name}".`,
      );
    }
    removed = existing;
  } else {
    // Filling an empty slot. Refuse if that slot and category is already taken,
    // rather than quietly double booking. The "Trip" slot legitimately holds one
    // stay and one transport at the same time, hence the category check.
    const occupant = state.itinerary
      .map((item) => world.options.find((option) => option.id === item.optionId))
      .find(
        (option) =>
          option !== undefined &&
          option.timeSlot === added.timeSlot &&
          option.category === added.category,
      );
    if (occupant) {
      return fail(
        state,
        "slot_occupied",
        `${added.timeSlot} already has the ${added.category} booking "${occupant.name}". Name it as the option to replace.`,
      );
    }
  }

  // Build the candidate plan, then let the budget be recomputed from it.
  const itinerary = state.itinerary
    .filter((item) => item.optionId !== oldOptionId)
    .concat({ timeSlot: added.timeSlot, optionId: added.id });

  const candidate = withItinerary(world, state, itinerary);

  const categoryBefore = state.budget.byCategory[added.category];
  const categoryAfter = candidate.budget.byCategory[added.category];

  // Refuse to create or worsen an overspend. A swap that leaves the category
  // negative is still allowed when it is strictly better than where we started,
  // otherwise a price spike would trap the trip: every repair inside that
  // category would be blocked for not fixing the whole gap in one move.
  const improvesAnOverspend =
    categoryBefore.remaining < 0 && categoryAfter.remaining > categoryBefore.remaining;

  if (categoryAfter.remaining < 0 && !improvesAnOverspend) {
    const shortfall = -categoryAfter.remaining;
    return fail(
      state,
      "category_would_go_negative",
      `Booking "${added.name}" would put ${added.category} ${formatINR(shortfall)} over its allocation of ${formatINR(categoryAfter.allocated)}.`,
      { shortfall },
    );
  }

  const priceDelta = added.price - (removed?.price ?? 0);
  const movement =
    priceDelta === 0
      ? "at the same price"
      : priceDelta < 0
        ? `saving ${formatINR(-priceDelta)}`
        : `costing ${formatINR(priceDelta)} more`;
  const base =
    removed === null
      ? `Booked "${added.name}" for ${added.timeSlot}, ${formatINR(added.price)}.`
      : `Swapped "${removed.name}" for "${added.name}" in ${added.timeSlot}, ${movement}.`;

  // If the category is still over, say so, so the caller knows the job is not done.
  const summary =
    categoryAfter.remaining < 0
      ? `${base} ${added.category} is still ${formatINR(-categoryAfter.remaining)} over its allocation, keep going.`
      : base;

  return succeed(candidate, summary, {
    timeSlot: added.timeSlot,
    category: added.category,
    removed,
    added,
    priceDelta,
    categoryBefore,
    categoryAfter,
  });
}
