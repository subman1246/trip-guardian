/**
 * Building a trip from what the traveller asked for: a number of days and a
 * total budget in whole rupees.
 *
 * Everything in this file is arithmetic over the local catalogue. No network, no
 * model, nothing random. The same inputs always give the same trip, which is
 * what makes it testable offline.
 *
 * WHAT THIS FILE IS ALLOWED TO DO. It decides how a trip is CONSTRUCTED: which
 * options exist at this length, how the total is split across the three
 * categories, and which options the traveller starts with. It does not touch a
 * single rule about what is legal afterwards. The constructed world goes through
 * the very same validateWorld the JSON file goes through, and the state is built
 * by the very same buildInitialTripState, so computeBudgetState stays the only
 * producer of derived money and every tool rejection is unchanged.
 *
 * ------------------------------------------------------------------------
 * THE SPLIT RULE
 *
 *   1. Work out the CHEAPEST BOOKABLE PLAN for this many days: for each thing
 *      the trip must book (the arrival, the stay, the local transport, one
 *      activity per remaining day slot), take the cheapest open option. Add up
 *      what that costs per category. Call those the floors.
 *   2. The surplus is the total budget minus the sum of the floors. It is the
 *      discretionary money, the part that buys a nicer trip.
 *   3. Give every category its floor, then share the surplus out in fixed
 *      proportions: 20% to transport, 40% to stay, 40% to activity. Transport
 *      moves you around and is worth the least extra spend, a bed and the things
 *      you came to do are worth the most. On a 1 day trip there is no stay, so
 *      its share is spread over the other two in the same proportions.
 *   4. Transport and stay take the whole rupee floor of their share and activity
 *      takes whatever is left, so the three allocations sum to the total exactly
 *      and never need rounding forgiveness.
 *
 *   Every category is guaranteed to afford its own cheapest bookings, which is
 *   precisely what makes the trip buildable at all.
 *
 * ------------------------------------------------------------------------
 * THE HEADROOM TARGET
 *
 * The starting itinerary must leave
 *   - at least 20% of the TOTAL budget unspent, and
 *   - at least 5% of EVERY category's allocation unspent.
 *
 * That headroom is the whole reason the agent has anything to work with. A trip
 * booked right up to its allocations cannot absorb a price spike, cannot lend
 * between categories, and turns every disruption into an unfixable one. So the
 * builder buys the nicest trip it can that still respects both ceilings, and
 * feasibility (below) refuses any budget where even the cheapest plan cannot.
 */

import {
  CATEGORIES,
  type Budget,
  type Category,
  type ItineraryItem,
  type Option,
  type TimeSlot,
  type TripState,
  type World,
} from "../data/types.js";
import { buildInitialTripState, validateWorld } from "./loader.js";
import { formatINR } from "./money.js";
import {
  MAX_TRIP_DAYS,
  MIN_TRIP_DAYS,
  REFERENCE_DAYS,
  REFERENCE_NIGHTS,
  assertSupported,
  daySlotsForTripLength,
  nightsForTripLength,
  slotsForTripLength,
} from "./slots.js";
import { isAvailable } from "./state.js";

/** How the surplus above the cheapest plan is shared out. See the split rule. */
export const DISCRETIONARY_SPLIT: Record<Category, number> = {
  transport: 0.2,
  stay: 0.4,
  activity: 0.4,
};

/** Share of the total budget the starting itinerary must leave unspent. */
export const TOTAL_HEADROOM_RATE = 0.2;

/** Share of each category's allocation the starting itinerary must leave unspent. */
export const CATEGORY_HEADROOM_RATE = 0.05;

/** One thing the trip has to book, and everything open that could fill it. */
export interface RequiredBooking {
  timeSlot: TimeSlot;
  category: Category;
  /** Open options for this slot and category, cheapest first. */
  candidates: Option[];
}

/** Per category numbers, for the panel that explains the trip. */
export interface CategoryPlan {
  category: Category;
  /** Cheapest this category could possibly spend on this trip. */
  floor: number;
  allocated: number;
  /** What the constructed itinerary actually spends. */
  startingSpend: number;
  /** allocated minus startingSpend. Always at least the 5% target. */
  headroom: number;
}

/** Everything the UI needs to explain the trip it was given. */
export interface TripPlan {
  days: number;
  nights: number;
  totalINR: number;
  byCategory: CategoryPlan[];
  /** Cost of the cheapest bookable plan at this length. */
  cheapestPlanINR: number;
  startingSpendINR: number;
  headroomINR: number;
  /** Headroom as a whole percentage of the total, for the copy. */
  headroomPercent: number;
  /** How many things this trip has to book. */
  requiredBookings: number;
}

/** A constructed trip: the catalogue it can use, the plan, and the live state. */
export interface TripBlueprint {
  world: World;
  state: TripState;
  plan: TripPlan;
}

/** Why a requested budget cannot buy a trip, and what would. */
export interface FeasibilityReport {
  ok: boolean;
  days: number;
  totalINR: number;
  /** Cost of the cheapest bookable plan at this length. */
  cheapestPlanINR: number;
  /** Smallest total that leaves the required headroom at this length. */
  minimumINR: number;
  /** Ready to show. Empty when ok. */
  message: string;
}

// --------------------------------------------------------------- the catalogue

/**
 * The options a trip of this length can actually use.
 *
 * Two things happen here. Slots the trip does not have are dropped, so a 2 day
 * trip never sees a Day 4 activity. And "Trip" slot options that are charged by
 * the night or by the day are rebuilt at this length, so a 4 day trip pays for
 * four days of cab and three nights of hotel rather than the two and one the
 * reference trip pays for.
 *
 * At the reference length this returns the file's own prices and names
 * unchanged, which is why every existing script still prints what it always did.
 */
export function catalogueForTrip(base: World, days: number): Option[] {
  assertSupported(days);

  const slots = new Set<TimeSlot>(slotsForTripLength(days));
  const nights = nightsForTripLength(days);
  const catalogue: Option[] = [];

  for (const option of base.options) {
    if (!slots.has(option.timeSlot)) continue;

    if (option.scalesPer === undefined) {
      catalogue.push({ ...option });
      continue;
    }

    const units = option.scalesPer === "night" ? nights : days;
    // A day trip sleeps nowhere, so the stays are not offered rather than being
    // offered at a price of zero.
    if (units === 0) continue;

    const unitPrice = option.unitPrice ?? 0;
    const rebuilt: Option = {
      ...option,
      price: unitPrice * units,
      // "{n}" takes the count and "{s}" takes the plural, so a one day rental
      // reads "1 day" rather than "1 days".
      name:
        option.nameTemplate === undefined
          ? option.name
          : option.nameTemplate.replace("{n}", String(units)).replace("{s}", units === 1 ? "" : "s"),
    };

    if (option.scalesPer === "night") {
      rebuilt.nightsCovered = units;
      // The name of a hotel does not carry a night count, so say it here instead,
      // and only when it is not the single night the file is written for.
      if (units !== REFERENCE_NIGHTS) {
        rebuilt.description = `${option.description} Priced for ${units} nights at ${formatINR(unitPrice)} a night.`;
      }
    }

    catalogue.push(rebuilt);
  }

  return catalogue;
}

/**
 * Everything a trip of this length has to book, in the order the builder fills
 * them: the arrival first, then the two things that span the whole visit, then
 * one activity for every remaining day slot.
 */
export function requiredBookings(catalogue: Option[], days: number): RequiredBooking[] {
  assertSupported(days);

  const bookings: RequiredBooking[] = [];
  const add = (timeSlot: TimeSlot, category: Category): void => {
    const candidates = catalogue
      .filter(
        (option) =>
          option.timeSlot === timeSlot && option.category === category && isAvailable(option),
      )
      .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));

    if (candidates.length === 0) {
      throw new Error(`No open option exists for ${timeSlot} ${category} on a ${days} day trip.`);
    }
    bookings.push({ timeSlot, category, candidates });
  };

  const daySlots = daySlotsForTripLength(days);
  const arrival = daySlots[0] as TimeSlot;

  add(arrival, "transport");
  if (nightsForTripLength(days) > 0) add("Trip", "stay");
  add("Trip", "transport");
  for (const slot of daySlots.slice(1)) add(slot, "activity");

  return bookings;
}

// ------------------------------------------------------------------ the money

/** Cheapest possible spend per category. Step 1 of the split rule. */
function floorsFor(bookings: RequiredBooking[]): Record<Category, number> {
  const floors: Record<Category, number> = { transport: 0, stay: 0, activity: 0 };
  for (const booking of bookings) {
    const cheapest = booking.candidates[0] as Option;
    floors[booking.category] += cheapest.price;
  }
  return floors;
}

/** The categories this trip actually books in. A day trip books no stay. */
function categoriesInPlay(bookings: RequiredBooking[]): Category[] {
  const present = new Set(bookings.map((booking) => booking.category));
  return CATEGORIES.filter((category) => present.has(category));
}

/**
 * Steps 2 to 4 of the split rule. Returns allocations that sum to totalINR
 * exactly, with every category holding at least its own floor.
 */
function allocate(
  floors: Record<Category, number>,
  present: Category[],
  totalINR: number,
): Record<Category, number> {
  const floorTotal = present.reduce((sum, category) => sum + floors[category], 0);
  const surplus = totalINR - floorTotal;
  const weightTotal = present.reduce((sum, category) => sum + DISCRETIONARY_SPLIT[category], 0);

  const allocations: Record<Category, number> = { transport: 0, stay: 0, activity: 0 };
  let assigned = 0;

  // Everyone but the last category in play takes the whole rupee floor of its
  // share. The last one takes the remainder, so the three sum to the total with
  // no rounding drift.
  present.forEach((category, index) => {
    if (index === present.length - 1) return;
    const share = Math.floor((surplus * DISCRETIONARY_SPLIT[category]) / weightTotal);
    allocations[category] = floors[category] + share;
    assigned += allocations[category];
  });

  const last = present[present.length - 1] as Category;
  allocations[last] = totalINR - assigned;

  return allocations;
}

/** Does the cheapest plan clear both headroom ceilings at this budget? */
function clearsHeadroom(
  floors: Record<Category, number>,
  allocations: Record<Category, number>,
  present: Category[],
  totalINR: number,
): boolean {
  const floorTotal = present.reduce((sum, category) => sum + floors[category], 0);
  if (floorTotal > totalCap(totalINR)) return false;

  for (const category of present) {
    if (floors[category] > categoryCap(allocations[category])) return false;
  }
  return true;
}

/** The most the whole itinerary may spend. */
function totalCap(totalINR: number): number {
  return Math.floor(totalINR * (1 - TOTAL_HEADROOM_RATE));
}

/** The most one category may spend out of its allocation. */
function categoryCap(allocated: number): number {
  return Math.floor(allocated * (1 - CATEGORY_HEADROOM_RATE));
}

// ------------------------------------------------------------- feasibility

/**
 * TASK 3: can this budget buy a viable trip of this length at all?
 *
 * Pure arithmetic over the catalogue, run BEFORE anything is constructed and
 * long before the agent exists. If the cheapest bookable plan cannot leave the
 * required headroom, no plan can, so nothing is built and the traveller is told
 * the smallest budget that would work.
 */
export function assessTripFeasibility(
  base: World,
  days: number,
  totalINR: number,
): FeasibilityReport {
  assertSupported(days);

  const catalogue = catalogueForTrip(base, days);
  const bookings = requiredBookings(catalogue, days);
  const floors = floorsFor(bookings);
  const present = categoriesInPlay(bookings);
  const cheapestPlanINR = present.reduce((sum, category) => sum + floors[category], 0);
  const minimumINR = minimumBudgetFor(floors, present, cheapestPlanINR);

  if (!Number.isInteger(totalINR) || totalINR < 0) {
    return {
      ok: false,
      days,
      totalINR,
      cheapestPlanINR,
      minimumINR,
      message: `The budget must be a whole number of rupees, and at least ${formatINR(minimumINR)} for a ${days} day trip.`,
    };
  }

  const ok = clearsHeadroom(floors, allocate(floors, present, totalINR), present, totalINR);

  return {
    ok,
    days,
    totalINR,
    cheapestPlanINR,
    minimumINR,
    message: ok
      ? ""
      : [
          `${formatINR(totalINR)} cannot cover a ${days} day trip in ${base.city}.`,
          `The cheapest bookable plan for ${days} days costs ${formatINR(cheapestPlanINR)},`,
          `and we hold back ${Math.round(TOTAL_HEADROOM_RATE * 100)}% of the budget as headroom so the`,
          `agent has room to repair things when they break.`,
          `Raise the budget to at least ${formatINR(minimumINR)} for ${days} days, or ask for fewer days.`,
        ].join(" "),
  };
}

/**
 * The smallest total that clears both headroom ceilings at this length.
 *
 * Start from the closed form bound (the total ceiling needs
 * floorTotal / 0.8, and each category needs enough surplus that its 5% is
 * covered), then step up one rupee at a time against the real integer
 * allocation, so the answer is exactly the smallest number the builder accepts
 * rather than a number that only holds before rounding.
 */
function minimumBudgetFor(
  floors: Record<Category, number>,
  present: Category[],
  floorTotal: number,
): number {
  const weightTotal = present.reduce((sum, category) => sum + DISCRETIONARY_SPLIT[category], 0);

  let candidate = Math.ceil(floorTotal / (1 - TOTAL_HEADROOM_RATE));
  for (const category of present) {
    const weight = DISCRETIONARY_SPLIT[category] / weightTotal;
    const surplusNeeded =
      (CATEGORY_HEADROOM_RATE * floors[category]) / ((1 - CATEGORY_HEADROOM_RATE) * weight);
    candidate = Math.max(candidate, floorTotal + Math.ceil(surplusNeeded));
  }

  // The closed form ignores integer rounding, so confirm against the real thing.
  // This has never needed more than a handful of steps, the guard is only there
  // so a future change to the split rule cannot turn this into a hang.
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const total = candidate + attempt;
    if (clearsHeadroom(floors, allocate(floors, present, total), present, total)) return total;
  }

  throw new Error(
    `Could not find a workable minimum budget from ${formatINR(candidate)}. The split rule and the headroom targets disagree.`,
  );
}

// --------------------------------------------------------------- the builder

/**
 * TASK 2: build the trip the traveller asked for.
 *
 * Throws if the budget is not feasible, so callers must run
 * assessTripFeasibility first and show its message. That ordering is deliberate:
 * a broken trip should never exist, not even for a moment.
 */
export function buildTrip(base: World, days: number, totalINR: number): TripBlueprint {
  const feasibility = assessTripFeasibility(base, days, totalINR);
  if (!feasibility.ok) {
    throw new Error(feasibility.message);
  }

  const catalogue = catalogueForTrip(base, days);
  const bookings = requiredBookings(catalogue, days);
  const floors = floorsFor(bookings);
  const present = categoriesInPlay(bookings);
  const allocations = allocate(floors, present, totalINR);

  const chosen = chooseStartingOptions(bookings, allocations, totalINR);

  const startingItinerary: ItineraryItem[] = chosen.map((option) => ({
    timeSlot: option.timeSlot,
    optionId: option.id,
  }));

  const budget: Budget = { totalINR, allocations };
  const world: World = {
    city: base.city,
    currency: "INR",
    tripLengthDays: days,
    options: catalogue,
    startingItinerary,
    budget,
  };

  // The same checks a hand written world file gets, no exceptions. A trip we
  // computed is not trusted more than a trip somebody typed.
  validateWorld(world);

  // One check a constructed trip gets that the file does not: world.json is a
  // catalogue spanning every supported length, so it legitimately holds Day 4
  // options on a 2 day reference trip. A CONSTRUCTED trip must not. If an option
  // for a slot this trip does not have ever reached the agent, it could book
  // something on a day the traveller is not there.
  const allowed = new Set<TimeSlot>(slotsForTripLength(days));
  const stray = catalogue.filter((option) => !allowed.has(option.timeSlot));
  if (stray.length > 0) {
    throw new Error(
      `Constructed ${days} day trip carries options for slots it does not have: ` +
        stray.map((option) => `${option.id} (${option.timeSlot})`).join(", "),
    );
  }

  const state = buildInitialTripState(world);

  return { world, state, plan: buildPlan(world, state, floors, bookings.length) };
}

/**
 * Pick what the traveller starts with: the nicest trip that still leaves the
 * headroom.
 *
 * Everything starts on its cheapest option, which feasibility has already proved
 * fits. Then each booking in turn is upgraded to the most expensive option that
 * keeps both its own category and the whole trip inside the headroom ceilings.
 * Falling back to the cheapest always works, because the cheapest is exactly
 * what the ceilings were last checked against.
 */
function chooseStartingOptions(
  bookings: RequiredBooking[],
  allocations: Record<Category, number>,
  totalINR: number,
): Option[] {
  const chosen = bookings.map((booking) => booking.candidates[0] as Option);

  const spendIn = (category: Category, swapIndex: number, swapTo: Option): number =>
    chosen.reduce((sum, option, index) => {
      const effective = index === swapIndex ? swapTo : option;
      return effective.category === category ? sum + effective.price : sum;
    }, 0);

  const spendTotal = (swapIndex: number, swapTo: Option): number =>
    chosen.reduce(
      (sum, option, index) => sum + (index === swapIndex ? swapTo.price : option.price),
      0,
    );

  bookings.forEach((booking, index) => {
    const cap = categoryCap(allocations[booking.category]);
    // Most expensive first, so the first one that fits is the best one that fits.
    for (const candidate of [...booking.candidates].reverse()) {
      if (
        spendIn(booking.category, index, candidate) <= cap &&
        spendTotal(index, candidate) <= totalCap(totalINR)
      ) {
        chosen[index] = candidate;
        break;
      }
    }
  });

  return chosen;
}

/** The numbers the setup panel and the README table are both built from. */
function buildPlan(
  world: World,
  state: TripState,
  floors: Record<Category, number>,
  requiredCount: number,
): TripPlan {
  const byCategory: CategoryPlan[] = CATEGORIES.map((category) => {
    const ledger = state.budget.byCategory[category];
    return {
      category,
      floor: floors[category],
      allocated: ledger.allocated,
      startingSpend: ledger.spent,
      headroom: ledger.remaining,
    };
  });

  const cheapestPlanINR = CATEGORIES.reduce((sum, category) => sum + floors[category], 0);

  return {
    days: world.tripLengthDays,
    nights: nightsForTripLength(world.tripLengthDays),
    totalINR: state.budget.totalINR,
    byCategory,
    cheapestPlanINR,
    startingSpendINR: state.budget.totalSpent,
    headroomINR: state.budget.totalRemaining,
    headroomPercent: Math.round((state.budget.totalRemaining / state.budget.totalINR) * 100),
    requiredBookings: requiredCount,
  };
}

/** The default the setup form opens on: the trip this project was built around. */
export const DEFAULT_TRIP_DAYS = REFERENCE_DAYS;
export const DEFAULT_TRIP_BUDGET = 15000;

/** Re-exported so the server and the UI read the cap from one place. */
export { MAX_TRIP_DAYS, MIN_TRIP_DAYS };
