/**
 * Turning tool results into readable console output.
 *
 * The tools themselves never print. This is where a caller (the demo script now,
 * the agent loop in prompt 3) turns a result into something a judge can read.
 */

import { formatINR } from "../world/money.js";
import { WIDTH, clip, rule, spread, wrap } from "../world/printer.js";
import type { SearchDetails } from "./search.js";
import type { ToolResult } from "./types.js";

/** Whether a tool call worked, and what it said, kept inside the frame. */
export function formatToolResult(label: string, result: ToolResult<unknown>): string {
  const status = result.ok ? "OK" : `REJECTED (${result.reason})`;
  const lines: string[] = [];

  // Label and status share a line when they fit, otherwise the status drops
  // to its own right aligned line rather than blowing past the width.
  if (label.length + status.length + 1 <= WIDTH) {
    lines.push(spread(label, status));
  } else {
    lines.push(label);
    lines.push(spread("", status));
  }

  lines.push(...wrap(result.summary, WIDTH, "  "));
  if (!result.ok && result.shortfall !== undefined) {
    lines.push(`  Short by ${formatINR(result.shortfall)}.`);
  }
  return lines.join("\n");
}

/** The alternatives table returned by search_alternatives. */
export function formatAlternatives(details: SearchDetails): string {
  const lines: string[] = [];

  // "current" is only meaningful when the query narrowed to a single booking.
  // A broad query can span several, in which case there is nothing to compare to.
  const current = details.current;
  if (current !== null) {
    lines.push(`  Currently booked here: ${current.name} (${formatINR(current.price)})`);
  } else if (details.excluded.alreadyBooked > 0) {
    lines.push(
      ...wrap(
        `This query spans ${details.excluded.alreadyBooked} existing bookings, so prices are quoted outright, not as a swap.`,
        WIDTH,
        "  ",
      ),
    );
  } else {
    lines.push("  Currently booked here: nothing, the slot is empty.");
  }
  lines.push(rule());

  if (details.alternatives.length === 0) {
    lines.push("  No alternatives passed the filters.");
  } else {
    lines.push("  ID    OPTION                              PRICE      DELTA   FITS");
    for (const alternative of details.alternatives) {
      const { option, priceDelta, fitsRemainingBudget } = alternative;
      // Show the delta with an explicit sign, it is the number that matters.
      const delta = priceDelta === 0 ? "same" : (priceDelta > 0 ? "+" : "-") + formatINR(Math.abs(priceDelta)).replace("Rs ", "");
      lines.push(
        "  " +
          option.id.padEnd(6) +
          clip(option.name, 34).padEnd(36) +
          formatINR(option.price).padStart(9) +
          delta.padStart(9) +
          (fitsRemainingBudget ? "    yes" : "     no"),
      );
    }
  }

  lines.push(rule());
  const { alreadyBooked, unavailable, overMaxPrice, overBudget } = details.excluded;
  lines.push(
    ...wrap(
      `Filtered out: ${alreadyBooked} already booked, ${unavailable} closed, ` +
        `${overMaxPrice} over max price, ${overBudget} over budget.`,
      WIDTH,
      "  ",
    ),
  );
  return lines.join("\n");
}
