/**
 * Turning live state into the JSON the browser draws.
 *
 * The browser never sees a World, a TripState or anything from the agent
 * internals. It sees these flat, already resolved shapes, which is why the page
 * needs no lookup logic and no money maths of its own.
 *
 * Nothing here reads the environment, so nothing here can leak a key.
 */

import {
  CATEGORIES,
  TIME_SLOTS,
  type Category,
  type TimeSlot,
  type TripState,
  type World,
} from "../data/types.js";
import type { DisruptionOutcome } from "../events/engine.js";
import { getOption } from "../world/loader.js";

export interface BookingView {
  optionId: string;
  name: string;
  category: Category;
  price: number;
  description: string;
}

/** One row of the itinerary panel. Day slots hold 0 or 1, "Trip" holds the stay and the local transport. */
export interface SlotView {
  timeSlot: TimeSlot;
  /** True for the day slots, which read as a gap when empty. */
  isDaySlot: boolean;
  bookings: BookingView[];
}

export interface CategoryView {
  category: Category;
  allocated: number;
  spent: number;
  remaining: number;
}

export interface BudgetView {
  totalINR: number;
  totalSpent: number;
  totalRemaining: number;
  byCategory: CategoryView[];
}

export interface TripView {
  city: string;
  tripLengthDays: number;
  slots: SlotView[];
  budget: BudgetView;
  /** Day slots with nothing in them. The panel calls these out. */
  emptySlots: TimeSlot[];
  /** Categories currently past their allocation. Drawn in red. */
  overspentCategories: Category[];
  itineraryTotal: number;
}

/** Everything the itinerary and budget panels need, in one object. */
export function toTripView(world: World, state: TripState): TripView {
  const slots: SlotView[] = TIME_SLOTS.map((timeSlot) => ({
    timeSlot,
    isDaySlot: timeSlot !== "Trip",
    bookings: state.itinerary
      .filter((item) => item.timeSlot === timeSlot)
      .map((item) => {
        const option = getOption(world, item.optionId);
        return {
          optionId: option.id,
          name: option.name,
          category: option.category,
          price: option.price,
          description: option.description,
        };
      })
      // Stay before transport in the Trip row, so the row does not reorder itself
      // when the agent swaps one of them.
      .sort((a, b) => a.category.localeCompare(b.category)),
  }));

  return {
    city: state.city,
    tripLengthDays: state.tripLengthDays,
    slots,
    budget: toBudgetView(state),
    emptySlots: slots
      .filter((slot) => slot.isDaySlot && slot.bookings.length === 0)
      .map((slot) => slot.timeSlot),
    overspentCategories: CATEGORIES.filter(
      (category) => state.budget.byCategory[category].remaining < 0,
    ),
    itineraryTotal: state.budget.totalSpent,
  };
}

export function toBudgetView(state: TripState): BudgetView {
  return {
    totalINR: state.budget.totalINR,
    totalSpent: state.budget.totalSpent,
    totalRemaining: state.budget.totalRemaining,
    byCategory: CATEGORIES.map((category) => ({
      category,
      ...state.budget.byCategory[category],
    })),
  };
}

/** What a disruption did, for the banner the trace opens with. */
export function toDisruptionView(outcome: DisruptionOutcome): Record<string, unknown> {
  return {
    id: outcome.disruption.id,
    kind: outcome.disruption.kind,
    message: outcome.disruption.message,
    changes: outcome.changes,
    optionName: outcome.option.name,
  };
}
