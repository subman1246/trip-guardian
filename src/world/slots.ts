/**
 * The shape of a trip: how many days it can run for, and which time slots that
 * many days actually uses.
 *
 * This is the single place the rule lives, so the dataset, the trip builder, the
 * views, the prompts and the verification script cannot drift apart on what a
 * "3 day trip" means.
 *
 * THE RULE. Every day has a Morning and an Afternoon. Every day except the last
 * also has an Evening, because on the last day the traveller heads home after
 * lunch. Anything that spans the whole visit (the hotel, the local transport)
 * sits in the "Trip" slot, which every trip has.
 *
 * Nights are one fewer than days: a 2 day trip is one night, a 4 day trip is
 * three. A 1 day trip is a day trip out of Delhi and has no stay at all.
 */

import { TIME_SLOTS, type TimeSlot } from "../data/types.js";

/** Shortest supported trip. One day out and back. */
export const MIN_TRIP_DAYS = 1;

/**
 * Longest supported trip. The cap is real: the dataset is handmade and only
 * carries curated Jaipur options out to Day 4, so anything longer would have to
 * invent filler. The UI states the cap and refuses anything above it.
 */
export const MAX_TRIP_DAYS = 4;

/**
 * The trip world.json is written for. Options priced by the day or by the night
 * store the price they come to on THIS trip, so the file stays readable and the
 * reference trip is rebuilt byte identical.
 */
export const REFERENCE_DAYS = 2;
export const REFERENCE_NIGHTS = REFERENCE_DAYS - 1;

/** True for a whole number of days inside the supported range. */
export function isSupportedTripLength(days: unknown): days is number {
  return (
    typeof days === "number" &&
    Number.isInteger(days) &&
    days >= MIN_TRIP_DAYS &&
    days <= MAX_TRIP_DAYS
  );
}

/** Nights slept on a trip of this many days. Zero for a day trip. */
export function nightsForTripLength(days: number): number {
  return Math.max(0, days - 1);
}

/** The day slots this trip uses, in the order they happen. */
export function daySlotsForTripLength(days: number): TimeSlot[] {
  assertSupported(days);

  const slots: TimeSlot[] = [];
  for (let day = 1; day <= days; day += 1) {
    slots.push(`Day ${day} Morning` as TimeSlot);
    slots.push(`Day ${day} Afternoon` as TimeSlot);
    // The last day ends after lunch, so it has no evening.
    if (day < days) slots.push(`Day ${day} Evening` as TimeSlot);
  }

  // Cheap insurance against the loop inventing a slot the type does not have.
  for (const slot of slots) {
    if (!TIME_SLOTS.includes(slot)) {
      throw new Error(`Trip length ${days} produced unknown time slot "${slot}".`);
    }
  }

  return slots;
}

/** Every slot this trip uses, day slots first and the spanning slot last. */
export function slotsForTripLength(days: number): TimeSlot[] {
  return [...daySlotsForTripLength(days), "Trip"];
}

/** Reject an unsupported length loudly rather than building a broken trip. */
export function assertSupported(days: number): void {
  if (!isSupportedTripLength(days)) {
    throw new Error(
      `Trip length must be a whole number of days between ${MIN_TRIP_DAYS} and ${MAX_TRIP_DAYS}, got ${days}.`,
    );
  }
}
