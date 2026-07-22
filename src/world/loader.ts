/**
 * Loads the mock world from JSON, checks it is internally consistent, and
 * builds the initial TripState the agent will later defend.
 *
 * Nothing here touches the network. The world is a local JSON file, on purpose.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CATEGORIES,
  TIME_SLOTS,
  type Budget,
  type BudgetState,
  type Category,
  type CategoryLedger,
  type ItineraryItem,
  type Option,
  type TripState,
  type World,
} from "../data/types.js";
import { isValidAmount } from "./money.js";
import {
  MAX_TRIP_DAYS,
  MIN_TRIP_DAYS,
  isSupportedTripLength,
  nightsForTripLength,
} from "./slots.js";

/** Absolute path to the world file, resolved relative to this module. */
const WORLD_JSON_PATH = fileURLToPath(new URL("../data/world.json", import.meta.url));

/** Read and validate the mock world. Throws a readable error if the data is bad. */
export function loadWorld(path: string = WORLD_JSON_PATH): World {
  const raw = readFileSync(path, "utf8");
  const world = JSON.parse(raw) as World;
  validateWorld(world);
  return world;
}

/** Look up an option by id. Throws rather than returning undefined, ids are data we control. */
export function getOption(world: World, optionId: string): Option {
  const found = world.options.find((option) => option.id === optionId);
  if (!found) {
    throw new Error(`Unknown option id "${optionId}".`);
  }
  return found;
}

/** All options that could fill a given time slot, cheapest first. Used by the agent later. */
export function optionsForSlot(world: World, timeSlot: string): Option[] {
  return world.options
    .filter((option) => option.timeSlot === timeSlot)
    .sort((a, b) => a.price - b.price);
}

/**
 * Recompute the budget from an itinerary. This is the only place spent and
 * remaining are produced, so the derived numbers can never drift from the plan.
 */
export function computeBudgetState(
  world: World,
  itinerary: ItineraryItem[],
  budget: Budget = world.budget,
): BudgetState {
  const spent: Record<Category, number> = { transport: 0, stay: 0, activity: 0 };

  for (const item of itinerary) {
    const option = getOption(world, item.optionId);
    spent[option.category] += option.price;
  }

  const byCategory = {} as Record<Category, CategoryLedger>;
  let totalSpent = 0;

  for (const category of CATEGORIES) {
    const allocated = budget.allocations[category];
    const categorySpent = spent[category];
    byCategory[category] = {
      allocated,
      spent: categorySpent,
      remaining: allocated - categorySpent,
    };
    totalSpent += categorySpent;
  }

  return {
    totalINR: budget.totalINR,
    totalSpent,
    totalRemaining: budget.totalINR - totalSpent,
    byCategory,
  };
}

/** Build the live state the traveller starts the trip with. */
export function buildInitialTripState(world: World): TripState {
  // Copy the itinerary so mutating the state never edits the loaded world.
  const itinerary = world.startingItinerary.map((item) => ({ ...item }));

  return {
    city: world.city,
    tripLengthDays: world.tripLengthDays,
    itinerary,
    budget: computeBudgetState(world, itinerary),
  };
}

/** Sort itinerary items into the order they happen, spanning items last. */
export function sortItinerary(itinerary: ItineraryItem[]): ItineraryItem[] {
  return [...itinerary].sort(
    (a, b) => TIME_SLOTS.indexOf(a.timeSlot) - TIME_SLOTS.indexOf(b.timeSlot),
  );
}

/**
 * Check every invariant the rest of the project relies on. Failing loudly here
 * beats a wrong number quietly showing up in the demo.
 *
 * Exported so a trip constructed from user input (src/world/trip.ts) is put
 * through exactly the same checks as a trip read off disk. A constructed world
 * is not trusted more than a hand written one.
 */
export function validateWorld(world: World): void {
  const problems: string[] = [];

  if (!world.city) problems.push("city is missing.");
  if (world.currency !== "INR") problems.push('currency must be "INR".');
  if (!isSupportedTripLength(world.tripLengthDays)) {
    problems.push(
      `tripLengthDays must be a whole number between ${MIN_TRIP_DAYS} and ${MAX_TRIP_DAYS}, got ${world.tripLengthDays}.`,
    );
  }

  // Options: unique ids, integer prices, known slots and categories.
  const seenIds = new Set<string>();
  for (const option of world.options) {
    const label = option.id || option.name || "(unnamed option)";
    if (seenIds.has(option.id)) problems.push(`duplicate option id "${option.id}".`);
    seenIds.add(option.id);

    if (!CATEGORIES.includes(option.category)) {
      problems.push(`option ${label} has unknown category "${option.category}".`);
    }
    if (!TIME_SLOTS.includes(option.timeSlot)) {
      problems.push(`option ${label} has unknown timeSlot "${option.timeSlot}".`);
    }
    if (!isValidAmount(option.price)) {
      problems.push(`option ${label} price must be a whole number of rupees.`);
    }

    // Options priced by the night or by the day carry the rate they are built
    // from, and the stored price has to be that rate times however many nights
    // or days THIS world runs for. If those two ever disagree, a trip would be
    // charging a number nobody checked.
    if (option.scalesPer !== undefined) {
      if (option.scalesPer !== "night" && option.scalesPer !== "day") {
        problems.push(`option ${label} has unknown scalesPer "${option.scalesPer}".`);
      } else if (option.timeSlot !== "Trip") {
        problems.push(`option ${label} has a scalesPer rate but is not a "Trip" slot option.`);
      } else if (!isValidAmount(option.unitPrice) || option.unitPrice === 0) {
        problems.push(`option ${label} needs a unitPrice as a positive whole number of rupees.`);
      } else {
        const units =
          option.scalesPer === "night"
            ? nightsForTripLength(world.tripLengthDays)
            : world.tripLengthDays;
        if (option.unitPrice * units !== option.price) {
          problems.push(
            `option ${label} is ${option.unitPrice} per ${option.scalesPer}, which over a ` +
              `${world.tripLengthDays} day trip is ${option.unitPrice * units}, but price says ${option.price}.`,
          );
        }
      }
    } else if (option.unitPrice !== undefined) {
      problems.push(`option ${label} has a unitPrice but no scalesPer to say what it is a rate for.`);
    }

    if (option.nameTemplate !== undefined && !option.nameTemplate.includes("{n}")) {
      problems.push(`option ${label} has a nameTemplate with no "{n}" placeholder in it.`);
    }
  }

  // Budget: allocations must be whole rupees and must sum to the total.
  const allocationTotal = CATEGORIES.reduce(
    (sum, category) => sum + (world.budget.allocations[category] ?? 0),
    0,
  );
  for (const category of CATEGORIES) {
    if (!isValidAmount(world.budget.allocations[category])) {
      problems.push(`budget allocation for ${category} must be a whole number of rupees.`);
    }
  }
  if (allocationTotal !== world.budget.totalINR) {
    problems.push(
      `budget allocations sum to ${allocationTotal} but the total is ${world.budget.totalINR}.`,
    );
  }

  // Starting itinerary: real options, and each option sits in its own slot.
  for (const item of world.startingItinerary) {
    const option = world.options.find((candidate) => candidate.id === item.optionId);
    if (!option) {
      problems.push(`starting itinerary references unknown option "${item.optionId}".`);
      continue;
    }
    if (option.timeSlot !== item.timeSlot) {
      problems.push(
        `starting itinerary puts "${option.name}" in ${item.timeSlot} but it belongs to ${option.timeSlot}.`,
      );
    }
  }

  // The starting plan has to actually fit inside the budget, per category.
  if (problems.length === 0) {
    const budget = computeBudgetState(world, world.startingItinerary);
    for (const category of CATEGORIES) {
      const ledger = budget.byCategory[category];
      if (ledger.remaining < 0) {
        problems.push(
          `starting itinerary overspends ${category}: ${ledger.spent} of ${ledger.allocated}.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid world data:\n  - ${problems.join("\n  - ")}`);
  }
}
