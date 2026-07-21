/**
 * State helpers shared by every tool.
 *
 * STATE DISCIPLINE FOR THE WHOLE PROJECT: state is IMMUTABLE.
 *
 * No tool and no disruption ever edits a TripState or a World in place. They
 * take the current one and return a brand new one. That gives prompt 3 a free
 * undo (keep the old reference) and a clean before/after for the demo, and it
 * makes it impossible for two callers to see different versions of the trip.
 *
 * The second rule: derived money is never written by hand. Any change to the
 * itinerary or to the allocations goes back through computeBudgetState, so
 * spent, remaining and totals can never drift away from the itinerary.
 */

import {
  CATEGORIES,
  type Budget,
  type Category,
  type ItineraryItem,
  type Option,
  type TripState,
  type World,
} from "../data/types.js";
import { computeBudgetState } from "./loader.js";

/** An option is bookable unless a disruption has explicitly closed it. */
export function isAvailable(option: Option): boolean {
  return option.available !== false;
}

/** Is this option currently in the plan? */
export function isBooked(state: TripState, optionId: string): boolean {
  return state.itinerary.some((item) => item.optionId === optionId);
}

/**
 * Read the live allocations back out of a TripState as a Budget.
 * computeBudgetState needs a Budget, and after a reallocation the live
 * allocations are the ones on the state, not the ones in the world file.
 */
export function budgetFromState(state: TripState): Budget {
  const allocations = {} as Record<Category, number>;
  for (const category of CATEGORIES) {
    allocations[category] = state.budget.byCategory[category].allocated;
  }
  return { totalINR: state.budget.totalINR, allocations };
}

/** New state with a different itinerary, budget recomputed from it. */
export function withItinerary(
  world: World,
  state: TripState,
  itinerary: ItineraryItem[],
): TripState {
  return {
    ...state,
    itinerary,
    budget: computeBudgetState(world, itinerary, budgetFromState(state)),
  };
}

/** New state with different allocations, budget recomputed against the same plan. */
export function withAllocations(
  world: World,
  state: TripState,
  allocations: Record<Category, number>,
): TripState {
  const budget: Budget = { totalINR: state.budget.totalINR, allocations };
  return { ...state, budget: computeBudgetState(world, state.itinerary, budget) };
}

/**
 * New state recomputed against a changed world. Used after a price disruption,
 * where the plan is untouched but what it costs is not.
 */
export function withWorld(world: World, state: TripState): TripState {
  return withItinerary(world, state, state.itinerary);
}

/** New world with one option patched. The original world object is left alone. */
export function patchOption(world: World, optionId: string, patch: Partial<Option>): World {
  return {
    ...world,
    options: world.options.map((option) =>
      option.id === optionId ? { ...option, ...patch } : option,
    ),
  };
}
