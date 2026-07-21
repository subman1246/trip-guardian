/**
 * Pretty printer for the live trip state.
 *
 * This output is the backbone of the demo: it is what the judge sees before a
 * disruption and after the agent has repaired the plan. Keep it calm and aligned.
 */

import {
  CATEGORIES,
  TIME_SLOTS,
  type ItineraryItem,
  type TimeSlot,
  type TripState,
  type World,
} from "../data/types.js";
import { getOption, sortItinerary } from "./loader.js";
import { formatINR } from "./money.js";

/** Total width of the printed block. */
const WIDTH = 74;

/** Left indent used for an itinerary item's category tag. */
const TAG_WIDTH = 12;

/** Keep long text inside the frame so the layout never wraps in a terminal. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
}

/** Friendlier label for the spanning slot. */
function slotLabel(slot: TimeSlot): string {
  return slot === "Trip" ? "Whole Trip (spans both days)" : slot;
}

/** Left text, right text, dots of space in between, padded to WIDTH. */
function spread(left: string, right: string, width = WIDTH): string {
  const gap = Math.max(1, width - left.length - right.length);
  return left + " ".repeat(gap) + right;
}

function rule(char = "-"): string {
  return char.repeat(WIDTH);
}

/** Build the whole report as a string, so callers can print it or reuse it. */
export function formatTripState(state: TripState, world: World): string {
  const lines: string[] = [];

  // Header.
  lines.push(rule("="));
  lines.push("TRIP GUARDIAN");
  lines.push(
    spread(
      `${state.city}  |  ${state.tripLengthDays} day trip`,
      `Budget ${formatINR(state.budget.totalINR)}`,
    ),
  );
  lines.push(rule("="));
  lines.push("");

  // Itinerary, grouped by time slot in the order the trip happens.
  lines.push("ITINERARY");
  lines.push(rule());

  const ordered = sortItinerary(state.itinerary);
  for (const slot of TIME_SLOTS) {
    const itemsInSlot = ordered.filter((item) => item.timeSlot === slot);
    if (itemsInSlot.length === 0) continue;

    lines.push(slotLabel(slot));
    for (const item of itemsInSlot) {
      lines.push(...formatItem(item, world));
    }
    lines.push("");
  }

  lines.push(rule());
  lines.push(spread("ITINERARY TOTAL", formatINR(state.budget.totalSpent)));
  lines.push("");

  // Budget table.
  lines.push("BUDGET");
  lines.push(rule());
  lines.push(budgetRow("CATEGORY", "ALLOCATED", "SPENT", "REMAINING"));
  lines.push(rule());

  for (const category of CATEGORIES) {
    const ledger = state.budget.byCategory[category];
    lines.push(
      budgetRow(
        category,
        formatINR(ledger.allocated),
        formatINR(ledger.spent),
        formatINR(ledger.remaining),
      ),
    );
  }

  lines.push(rule());
  lines.push(
    budgetRow(
      "TOTAL",
      formatINR(state.budget.totalINR),
      formatINR(state.budget.totalSpent),
      formatINR(state.budget.totalRemaining),
    ),
  );
  lines.push(rule("="));

  return lines.join("\n");
}

/** Two lines per itinerary item: the booking, then its one line description. */
function formatItem(item: ItineraryItem, world: World): string[] {
  const option = getOption(world, item.optionId);
  const indent = 2 + TAG_WIDTH;
  const price = formatINR(option.price);
  const tag = `[${option.category}]`.padEnd(TAG_WIDTH);

  // The name shares its line with the price, the description gets the full width.
  const name = clip(option.name, WIDTH - indent - price.length - 2);
  const head = spread(`  ${tag}${name}`, price);
  const note = " ".repeat(indent) + clip(option.description, WIDTH - indent);
  return [head, note];
}

/** One aligned row of the budget table. */
function budgetRow(label: string, allocated: string, spent: string, remaining: string): string {
  return (
    label.padEnd(20) + allocated.padStart(18) + spent.padStart(18) + remaining.padStart(18)
  );
}

/** Print the report to the console. */
export function printTripState(state: TripState, world: World): void {
  console.log(formatTripState(state, world));
}

/**
 * The full catalogue of everything bookable, grouped by category. This is the
 * pool the agent gets to choose from when it repairs a broken plan, so it is
 * worth seeing next to the itinerary.
 */
export function formatCatalogue(world: World, state: TripState): string {
  const chosen = new Set(state.itinerary.map((item) => item.optionId));
  const lines: string[] = [];

  lines.push(rule("="));
  lines.push(spread(`AVAILABLE OPTIONS IN ${world.city.toUpperCase()}`, `${world.options.length} total`));
  lines.push(rule("="));

  for (const category of CATEGORIES) {
    const inCategory = world.options.filter((option) => option.category === category);
    lines.push("");
    lines.push(`${category.toUpperCase()} (${inCategory.length})`);
    lines.push(rule());

    for (const option of inCategory) {
      // A marker so it is obvious which options are already in the plan.
      const marker = chosen.has(option.id) ? "*" : " ";
      const name = `${marker} ${option.id.padEnd(4)}${option.name}`;
      const slot = option.timeSlot === "Trip" ? "Whole Trip" : option.timeSlot;
      // 46 + 10 + 3 + 15 lands exactly on WIDTH.
      lines.push(clip(name, 46).padEnd(46) + formatINR(option.price).padStart(10) + "   " + slot);
    }
  }

  lines.push("");
  lines.push("* = currently in the itinerary");
  lines.push(rule("="));

  return lines.join("\n");
}
