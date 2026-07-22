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
  type Category,
  type TimeSlot,
  type TripState,
  type World,
} from "../data/types.js";
import type { DisruptionOutcome } from "../events/engine.js";
import { getOption } from "../world/loader.js";
import { formatINR } from "../world/money.js";
import { MAX_TRIP_DAYS, MIN_TRIP_DAYS, slotsForTripLength } from "../world/slots.js";
import {
  CATEGORY_HEADROOM_RATE,
  DISCRETIONARY_SPLIT,
  TOTAL_HEADROOM_RATE,
  type TripPlan,
} from "../world/trip.js";

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

/**
 * Everything the itinerary and budget panels need, in one object.
 *
 * The rows are the slots THIS trip has, taken from its own length, so a 1 day
 * trip does not draw four empty rows it can never fill.
 */
export function toTripView(world: World, state: TripState): TripView {
  const slots: SlotView[] = slotsForTripLength(state.tripLengthDays).map((timeSlot) => ({
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

// ------------------------------------------------------------- the setup panel

export interface SetupCategoryView {
  category: Category;
  /** Cheapest this category could possibly spend on this trip. */
  floor: number;
  allocated: number;
  startingSpend: number;
  headroom: number;
}

/** How the trip was constructed, shown before any scenario is fired. */
export interface SetupView {
  days: number;
  nights: number;
  minDays: number;
  maxDays: number;
  totalINR: number;
  byCategory: SetupCategoryView[];
  cheapestPlanINR: number;
  startingSpendINR: number;
  headroomINR: number;
  headroomPercent: number;
  requiredBookings: number;
  /** The split rule and the headroom target, in the same words as the README. */
  rule: string[];
}

export function toSetupView(plan: TripPlan): SetupView {
  const percent = (rate: number): string => `${Math.round(rate * 100)}%`;

  return {
    days: plan.days,
    nights: plan.nights,
    minDays: MIN_TRIP_DAYS,
    maxDays: MAX_TRIP_DAYS,
    totalINR: plan.totalINR,
    byCategory: plan.byCategory.map((entry) => ({
      category: entry.category,
      floor: entry.floor,
      allocated: entry.allocated,
      startingSpend: entry.startingSpend,
      headroom: entry.headroom,
    })),
    cheapestPlanINR: plan.cheapestPlanINR,
    startingSpendINR: plan.startingSpendINR,
    headroomINR: plan.headroomINR,
    headroomPercent: plan.headroomPercent,
    requiredBookings: plan.requiredBookings,
    rule: [
      `This trip has to book ${plan.requiredBookings} things: the arrival, ` +
        `${plan.nights === 0 ? "the local transport" : "the room and the local transport"}, ` +
        `and one activity for every other day slot.`,
      `The cheapest way to book all of them costs ${formatINR(plan.cheapestPlanINR)}. ` +
        `Every category is given that floor first, so it can always afford its own bookings.`,
      `What is left over, ${formatINR(plan.totalINR - plan.cheapestPlanINR)}, is shared out ` +
        `${percent(DISCRETIONARY_SPLIT.transport)} to transport, ${percent(DISCRETIONARY_SPLIT.stay)} to stay ` +
        `and ${percent(DISCRETIONARY_SPLIT.activity)} to activity` +
        `${plan.nights === 0 ? ", with stay's share spread over the other two since a day trip books no room." : "."}`,
      `The starting itinerary then buys the best trip that still leaves ` +
        `${percent(TOTAL_HEADROOM_RATE)} of the total and ${percent(CATEGORY_HEADROOM_RATE)} of every ` +
        `allocation unspent. It is holding back ${formatINR(plan.headroomINR)}, which is ` +
        `${plan.headroomPercent}% of the budget, for the agent to work with.`,
    ],
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
