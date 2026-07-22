/**
 * What the model is told.
 *
 * The system instruction sets the job and the rules of engagement. The context
 * builders turn the live TripState and the disruption that just fired into the
 * text the model reads on the first turn.
 *
 * Nothing here decides anything. There is no "if the budget is short then
 * reallocate" rule in this file, only a description of what the tools can do.
 * The agent has to work out the path itself, which is the point.
 */

import { CATEGORIES, type TripState, type World } from "../data/types.js";
import type { DisruptionOutcome } from "../events/engine.js";
import { getOption, sortItinerary } from "../world/loader.js";
import { formatINR } from "../world/money.js";

export const SYSTEM_INSTRUCTION = `
You are Trip Guardian, an autonomous travel agent. A traveller is mid trip with a
fixed itinerary and a fixed budget. Something has just gone wrong. Your job is to
defend both the plan and the money, by yourself, right now.

You act. You do not ask the traveller for permission, you do not present options
for them to choose between, and you do not wait to be told what to do. You decide,
you book, and afterwards you explain yourself.

HOW YOU WORK

1. Understand the damage before you touch anything. A single disruption can break
   more than one thing: it can empty a slot, push a category over its allocation,
   and remove an option a later choice depended on, all at once. Read the whole
   situation first.
2. Call search_alternatives before you rebook. Never guess an option id, and never
   assume an option is still open. A disruption may have closed the very thing you
   were about to pick.
3. Fix the whole chain, not just the first break. After each change, look at what
   is still wrong. You are not finished because one problem is solved.
4. When you are finished, call notify_user exactly once, as your last action.

THE BUDGET

Money is Indian Rupees, always whole rupees. The total budget is fixed and cannot
grow. Each category (transport, stay, activity) has its own allocation, and the
allocations always add up to the total.

A rebooking that would push a category past its allocation is rejected. That is a
normal part of the job, not a failure. The rejection tells you the exact shortfall.
If the change is worth making, move that much allocation in from a category with
spare room using reallocate_budget, then rebook again. A category can only give
away what it has not already spent.

JUDGEMENT

You will often face options that cannot all win. The cheapest fix may gut the
experience. The best experience may not fit. Something fast may cost more than
something slow. There is no correct answer written down anywhere, so weigh it:
what the traveller loses, what they gain, and what the money allows. Protect the
shape of their trip, not just the bottom line. Coming in under budget by wrecking
the trip is a bad outcome, and so is a lovely trip that breaks the budget.

Sometimes nothing can fill a slot, because every option for it is closed. Say so
plainly and use the freed money well elsewhere. Do not invent a booking that does
not exist.

HOW YOU WRITE

Everything the traveller reads must be plain and honest. Name what they lost, not
only what you saved. Give real figures.

Never use em-dashes or en-dashes in anything you write. Use commas, periods or
parentheses instead. Write money as "Rs 1,350".
`.trim();

/** The catalogue and the rules of the world, written once for the first turn. */
export function describeWorld(world: World): string {
  return [
    `CITY: ${world.city}`,
    `TRIP LENGTH: ${world.tripLengthDays} days`,
    "",
    "The trip runs from Day 1 Morning to Day 2 Afternoon. There is no Day 2 Evening,",
    'the traveller heads home. The slot called "Trip" spans the whole visit and holds',
    "two things at once: the hotel (stay) and the local transport that covers both days.",
    "",
    `There are ${world.options.length} bookable options in total. Use search_alternatives`,
    "to see them, since it also tells you which ones are closed and what each one would",
    "cost you as a swap.",
  ].join("\n");
}

/** The live plan and the live money, as the model sees it on turn one. */
export function describeTripState(world: World, state: TripState): string {
  const lines: string[] = ["CURRENT ITINERARY"];

  const ordered = sortItinerary(state.itinerary);
  if (ordered.length === 0) {
    lines.push("  (nothing booked)");
  }
  for (const item of ordered) {
    const option = getOption(world, item.optionId);
    lines.push(
      `  ${item.timeSlot}: ${option.name} (id ${option.id}, ${option.category}, ${formatINR(option.price)})`,
    );
  }

  lines.push("", "CURRENT BUDGET");
  for (const category of CATEGORIES) {
    const ledger = state.budget.byCategory[category];
    lines.push(
      `  ${category}: allocated ${formatINR(ledger.allocated)}, spent ${formatINR(ledger.spent)}, remaining ${formatINR(ledger.remaining)}`,
    );
  }
  lines.push(
    `  TOTAL: allocated ${formatINR(state.budget.totalINR)}, spent ${formatINR(state.budget.totalSpent)}, remaining ${formatINR(state.budget.totalRemaining)}`,
  );

  // Call out an empty slot explicitly. It is the most common thing to miss.
  const filledSlots = new Set(ordered.map((item) => item.timeSlot));
  const daySlots = ["Day 1 Morning", "Day 1 Afternoon", "Day 1 Evening", "Day 2 Morning", "Day 2 Afternoon"];
  const empty = daySlots.filter((slot) => !filledSlots.has(slot as never));
  if (empty.length > 0) {
    lines.push("", `EMPTY SLOTS RIGHT NOW: ${empty.join(", ")}`);
  }

  const overspent = CATEGORIES.filter((category) => state.budget.byCategory[category].remaining < 0);
  if (overspent.length > 0) {
    lines.push(
      "",
      `OVER ALLOCATION RIGHT NOW: ${overspent
        .map((category) => `${category} by ${formatINR(-state.budget.byCategory[category].remaining)}`)
        .join(", ")}`,
    );
  }

  return lines.join("\n");
}

/** What just happened, built from the real disruption outcomes. */
export function describeDisruptions(outcomes: DisruptionOutcome[]): string {
  const lines: string[] = ["WHAT JUST HAPPENED"];

  for (const outcome of outcomes) {
    lines.push("", `[${outcome.disruption.kind}] ${outcome.disruption.message}`);
    for (const change of outcome.changes) {
      lines.push(`  - ${change}`);
    }
  }

  return lines.join("\n");
}

/** The whole first turn: the world, the plan, the damage, and the ask. */
export function buildOpeningMessage(
  world: World,
  state: TripState,
  outcomes: DisruptionOutcome[],
): string {
  return [
    describeWorld(world),
    "",
    describeDisruptions(outcomes),
    "",
    describeTripState(world, state),
    "",
    "Repair this trip now. Work out everything that is broken, fix all of it, and",
    "finish by calling notify_user with your report.",
  ].join("\n");
}

/** Sent when the model stops calling tools without having reported. */
export const NUDGE_MESSAGE =
  "You have not called notify_user yet. If the trip is repaired and the budget is " +
  "sound, call notify_user now with your final report. If something is still broken, " +
  "keep working on it with the tools.";
