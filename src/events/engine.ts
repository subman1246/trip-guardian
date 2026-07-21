/**
 * The disruption engine.
 *
 * A disruption is the world changing under the traveller's feet. It can change
 * the catalogue (a price, an option's availability) and the plan (a booking that
 * no longer stands). It never repairs anything, repairing is the agent's job.
 *
 * Same immutability rule as the tools: a new World and a new TripState come out,
 * the ones passed in are untouched.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Category, Disruption, Option, TimeSlot, TripState, World } from "../data/types.js";
import { formatINR, isValidAmount } from "../world/money.js";
import { patchOption, withItinerary, withWorld } from "../world/state.js";

/** Where the demo disruptions live. Config, not logic, so they are easy to change. */
const DISRUPTIONS_JSON_PATH = fileURLToPath(new URL("../data/disruptions.json", import.meta.url));

/** What a disruption did, once applied. */
export interface DisruptionOutcome {
  /** The catalogue after the event (prices, availability). */
  world: World;
  /** The plan after the event, with the budget recomputed. */
  state: TripState;
  disruption: Disruption;
  /** The option the event hit. */
  option: Option;
  /** Line by line, what actually changed. For printing. */
  changes: string[];
  /** True if the event knocked something out of the plan. */
  itineraryAffected: boolean;
  /** The slot the event left empty, if it emptied one. */
  emptiedSlot?: TimeSlot;
  /** Set when a price change pushed a category past its allocation. */
  overBudgetCategory?: Category;
}

/** Read the disruption catalogue and check every entry against the world. */
export function loadDisruptions(world: World, path: string = DISRUPTIONS_JSON_PATH): Disruption[] {
  const disruptions = JSON.parse(readFileSync(path, "utf8")) as Disruption[];
  validateDisruptions(world, disruptions);
  return disruptions;
}

/** Pick one disruption by id. Throws, since the ids are ours. */
export function getDisruption(disruptions: Disruption[], id: string): Disruption {
  const found = disruptions.find((disruption) => disruption.id === id);
  if (!found) {
    throw new Error(`Unknown disruption id "${id}".`);
  }
  return found;
}

/**
 * Apply one disruption. Returns the new world, the new state, and a description
 * of what changed, which is what the agent will read in prompt 3.
 */
export function applyDisruption(
  world: World,
  state: TripState,
  disruption: Disruption,
): DisruptionOutcome {
  const option = world.options.find((candidate) => candidate.id === disruption.optionId);
  if (!option) {
    throw new Error(`Disruption "${disruption.id}" targets unknown option "${disruption.optionId}".`);
  }

  const wasBooked = state.itinerary.some((item) => item.optionId === option.id);
  const changes: string[] = [];

  switch (disruption.kind) {
    case "activity_cancelled":
    case "venue_closed": {
      // Close the option in the catalogue so nothing can rebook it.
      const nextWorld = patchOption(world, option.id, { available: false });
      changes.push(`"${option.name}" is now closed and cannot be booked.`);

      if (!wasBooked) {
        // It was only ever a fallback. The plan stands, the agent has fewer moves.
        changes.push("It was not in the itinerary, so the plan is unchanged.");
        return {
          world: nextWorld,
          state: withWorld(nextWorld, state),
          disruption,
          option,
          changes,
          itineraryAffected: false,
        };
      }

      // It was booked, so it comes out and the slot goes empty.
      const itinerary = state.itinerary.filter((item) => item.optionId !== option.id);
      const nextState = withItinerary(nextWorld, state, itinerary);
      const refunded = nextState.budget.byCategory[option.category];

      changes.push(
        `Removed from ${option.timeSlot}, that slot is now empty.`,
        `${formatINR(option.price)} released back to ${option.category}, which now has ${formatINR(refunded.remaining)} free.`,
      );

      return {
        world: nextWorld,
        state: nextState,
        disruption,
        option,
        changes,
        itineraryAffected: true,
        emptiedSlot: option.timeSlot,
      };
    }

    case "price_spike":
    case "price_drop": {
      const newPrice = disruption.newPrice as number; // validated at load time
      const delta = newPrice - option.price;
      const nextWorld = patchOption(world, option.id, { price: newPrice });
      // The plan is untouched, but what it costs is not, so recompute against
      // the new catalogue.
      const nextState = withWorld(nextWorld, state);

      changes.push(
        `"${option.name}" moved from ${formatINR(option.price)} to ${formatINR(newPrice)} ` +
          `(${delta >= 0 ? "up" : "down"} ${formatINR(Math.abs(delta))}).`,
      );

      if (!wasBooked) {
        changes.push("It is not in the itinerary, so nothing is owed differently.");
        return { world: nextWorld, state: nextState, disruption, option, changes, itineraryAffected: false };
      }

      const ledger = nextState.budget.byCategory[option.category];
      changes.push(
        `It is booked, so ${option.category} now shows ${formatINR(ledger.spent)} spent of ${formatINR(ledger.allocated)}.`,
      );

      if (ledger.remaining < 0) {
        changes.push(
          `${option.category} is ${formatINR(-ledger.remaining)} OVER its allocation. This needs fixing.`,
        );
        return {
          world: nextWorld,
          state: nextState,
          disruption,
          option,
          changes,
          itineraryAffected: true,
          overBudgetCategory: option.category,
        };
      }

      return { world: nextWorld, state: nextState, disruption, option, changes, itineraryAffected: true };
    }
  }
}

/** Config data gets the same loud validation the world file gets. */
function validateDisruptions(world: World, disruptions: Disruption[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  const kinds = ["activity_cancelled", "price_spike", "venue_closed", "price_drop"];

  for (const disruption of disruptions) {
    const label = disruption.id || "(unnamed disruption)";
    if (seen.has(disruption.id)) problems.push(`duplicate disruption id "${disruption.id}".`);
    seen.add(disruption.id);

    if (!kinds.includes(disruption.kind)) {
      problems.push(`${label} has unknown kind "${disruption.kind}".`);
    }
    if (!world.options.some((option) => option.id === disruption.optionId)) {
      problems.push(`${label} targets unknown option "${disruption.optionId}".`);
    }
    if (!disruption.message) {
      problems.push(`${label} has no message.`);
    }

    // Price events must carry a sane new price, and must actually move it.
    if (disruption.kind === "price_spike" || disruption.kind === "price_drop") {
      const target = world.options.find((option) => option.id === disruption.optionId);
      if (!isValidAmount(disruption.newPrice)) {
        problems.push(`${label} needs a newPrice as a whole number of rupees.`);
      } else if (target) {
        if (disruption.kind === "price_spike" && disruption.newPrice <= target.price) {
          problems.push(`${label} is a price_spike but ${disruption.newPrice} is not above ${target.price}.`);
        }
        if (disruption.kind === "price_drop" && disruption.newPrice >= target.price) {
          problems.push(`${label} is a price_drop but ${disruption.newPrice} is not below ${target.price}.`);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid disruption data:\n  - ${problems.join("\n  - ")}`);
  }
}
