/**
 * Does this scenario mean anything on THIS trip?
 *
 * Scenarios were written against one hardcoded 2 day trip, so several of them
 * name specific option ids: no-donor-left needs a5, s2 and s1 to be exactly
 * where they were. Once the traveller picks the length and the budget, those
 * options may not be booked, may not even exist at that length, and firing the
 * scenario would either error or quietly do nothing.
 *
 * Two things live here, and they are deliberately separate.
 *
 * RESOLUTION turns a disruption into a concrete one the engine can apply. A
 * disruption pinned to an option id resolves to itself. A disruption written
 * against a TARGET (a slot and a category) resolves to whatever this trip has
 * booked there. That is how a scenario stays meaningful across trip shapes
 * without ever being retargeted onto something unrelated: a target only ever
 * matches a booking in the same slot playing the same role, and if there is no
 * such booking the scenario is reported as not applicable rather than moved.
 *
 * APPLICABILITY replays a whole scenario against the current trip, in order,
 * resolving each step against the state the previous step left behind. It
 * mutates nothing. The UI uses it to disable the buttons that would be
 * meaningless, and the server uses it to refuse a run of one.
 */

import type { Disruption, TripState, World } from "../data/types.js";
import { nightsForTripLength, slotsForTripLength } from "../world/slots.js";
import { isBooked } from "../world/state.js";
import { applyDisruption, getDisruption } from "./engine.js";
import type { Scenario } from "./scenarios.js";

/** A resolved disruption, or the reason it does not apply to this trip. */
export type DisruptionResolution =
  | { ok: true; disruption: Disruption }
  | { ok: false; reason: string };

/** Whether a whole scenario can be fired, and why not when it cannot. */
export interface ScenarioApplicability {
  applicable: boolean;
  /** One short sentence, written to sit in a tooltip. Empty when applicable. */
  reason: string;
}

/**
 * Kinds that only mean something when the option is actually in the plan.
 *
 * A cancellation empties a slot, and a price spike changes what the trip owes.
 * Neither does anything to an option nobody booked. Closures and price drops are
 * different: they act on the pool of fallbacks the agent might reach for, so
 * they only need the option to exist.
 */
const NEEDS_BOOKING = new Set(["activity_cancelled", "price_spike"]);

/**
 * Turn one disruption into something the engine can apply to this world.
 *
 * `base` is the pristine catalogue, used only to name an option that this trip
 * does not carry, so the reason can say "the Hawa Mahal walk" rather than "a5".
 */
export function resolveDisruption(
  world: World,
  state: TripState,
  disruption: Disruption,
  base?: World,
): DisruptionResolution {
  if (disruption.target !== undefined) return resolveTargeted(world, state, disruption);

  const option = world.options.find((candidate) => candidate.id === disruption.optionId);
  if (option === undefined) {
    return { ok: false, reason: explainMissing(state, disruption.optionId, base) };
  }

  if (NEEDS_BOOKING.has(disruption.kind) && !isBooked(state, option.id)) {
    return {
      ok: false,
      reason: `"${option.name}" is not booked on this trip, so this would change nothing.`,
    };
  }

  // Pinned disruptions are handed to the engine exactly as written.
  return { ok: true, disruption };
}

/**
 * Say why an option this disruption names is not in the trip's catalogue.
 *
 * There are two different reasons and they must not be muddled. Either the slot
 * itself does not exist at this length (a Day 3 activity on a 2 day trip), or
 * the slot exists but this trip does not book that category in it (a room on a
 * day trip, which sleeps nowhere).
 */
function explainMissing(state: TripState, optionId: string | undefined, base?: World): string {
  const known = base?.options.find((candidate) => candidate.id === optionId);
  const days = state.tripLengthDays;

  if (known === undefined) {
    return `Option "${optionId}" is not in this trip's catalogue.`;
  }
  if (!slotsForTripLength(days).includes(known.timeSlot)) {
    return `${known.timeSlot} is not part of a ${days} day trip, so "${known.name}" cannot be booked.`;
  }
  if (known.category === "stay" && nightsForTripLength(days) === 0) {
    return `A ${days} day trip sleeps nowhere, so "${known.name}" is not offered on it.`;
  }
  return `"${known.name}" is not offered on a ${days} day trip.`;
}

/** Resolve a slot and category target against what the trip actually booked. */
function resolveTargeted(
  world: World,
  state: TripState,
  disruption: Disruption,
): DisruptionResolution {
  const target = disruption.target as NonNullable<Disruption["target"]>;

  const booked = state.itinerary
    .map((item) => world.options.find((option) => option.id === item.optionId))
    .find(
      (option) =>
        option !== undefined &&
        option.timeSlot === target.timeSlot &&
        option.category === target.category,
    );

  if (booked === undefined) {
    const where = target.timeSlot === "Trip" ? "the whole trip" : target.timeSlot;
    return {
      ok: false,
      reason: `This trip has no ${target.category} booked for ${where}.`,
    };
  }

  const resolved: Disruption = {
    ...disruption,
    optionId: booked.id,
    timeSlot: booked.timeSlot,
    message: disruption.message.replace(/\{option\}/g, booked.name),
  };

  if (disruption.kind === "price_spike" || disruption.kind === "price_drop") {
    resolved.newPrice = applyFactor(booked.price, disruption.priceFactor ?? 1, disruption.kind);
  }

  return { ok: true, disruption: resolved };
}

/**
 * The new price a factor gives, in whole rupees.
 *
 * The engine refuses a spike that does not rise and a drop that does not fall,
 * so nudge by a rupee in the rare case rounding lands exactly on the old price.
 * A drop can never go below zero.
 */
function applyFactor(price: number, factor: number, kind: string): number {
  const scaled = Math.round(price * factor);
  if (kind === "price_spike") return Math.max(scaled, price + 1);
  return Math.max(0, Math.min(scaled, price - 1));
}

/**
 * Replay a scenario against the current trip without keeping any of it.
 *
 * Each step is resolved against the state the step before it produced, because a
 * scenario's later disruptions can depend on what the earlier ones did.
 */
export function assessScenario(
  world: World,
  state: TripState,
  disruptions: Disruption[],
  scenario: Scenario,
  base?: World,
): ScenarioApplicability {
  let currentWorld = world;
  let currentState = state;

  for (const id of scenario.disruptionIds) {
    const resolution = resolveDisruption(
      currentWorld,
      currentState,
      getDisruption(disruptions, id),
      base,
    );
    if (!resolution.ok) return { applicable: false, reason: resolution.reason };

    const outcome = applyDisruption(currentWorld, currentState, resolution.disruption);
    currentWorld = outcome.world;
    currentState = outcome.state;
  }

  return { applicable: true, reason: "" };
}
