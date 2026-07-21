/**
 * Agent tool: notify_user
 *
 * The traveller facing report channel. It does not send anywhere, it formats a
 * clear message and returns it, and the caller decides what to do with it.
 *
 * In prompt 3 the agent fills these fields with its own reasoning, so the shape
 * is deliberately close to how a person would explain a change: what broke,
 * what I did, what it cost you, what you gave up.
 */

import { CATEGORIES, type TripState, type World } from "../data/types.js";
import { formatINR } from "../world/money.js";
import { bulletLines, rule, spread, wrap } from "../world/printer.js";
import { succeed, type ToolResult } from "./types.js";

export interface NotificationInput {
  /** One line, the thing to read if you read nothing else. */
  headline: string;
  /** The disruption in plain words. */
  whatHappened?: string;
  /** Why the agent chose this repair over the others. Filled by the LLM later. */
  reasoning?: string;
  /** The concrete steps taken, in order. */
  actions?: string[];
  /** What the traveller gave up, stated honestly. */
  tradeoff?: string;
}

export interface NotificationDetails {
  /** The formatted, ready to display message. */
  message: string;
  input: NotificationInput;
}

export function notifyUser(
  world: World,
  state: TripState,
  input: NotificationInput,
): ToolResult<NotificationDetails> {
  const message = formatNotification(state, input);
  // Read only: reporting never changes the trip.
  return succeed(state, input.headline, { message, input });
}

/** Render the notification as a bordered block that matches the rest of the output. */
export function formatNotification(state: TripState, input: NotificationInput): string {
  const lines: string[] = [];

  lines.push(rule("="));
  lines.push("MESSAGE TO TRAVELLER");
  lines.push(rule("="));
  lines.push(...wrap(input.headline));

  if (input.whatHappened) {
    lines.push("");
    lines.push("What happened");
    lines.push(...wrap(input.whatHappened, WIDTH_INNER, "  "));
  }

  if (input.reasoning) {
    lines.push("");
    lines.push("Why this call");
    lines.push(...wrap(input.reasoning, WIDTH_INNER, "  "));
  }

  if (input.actions && input.actions.length > 0) {
    lines.push("");
    lines.push("What I did");
    for (const action of input.actions) {
      lines.push(...bulletLines(action));
    }
  }

  if (input.tradeoff) {
    lines.push("");
    lines.push("The tradeoff");
    lines.push(...wrap(input.tradeoff, WIDTH_INNER, "  "));
  }

  // Always close with where the money stands, that is the promise of the product.
  lines.push("");
  lines.push("Budget now");
  for (const category of CATEGORIES) {
    const ledger = state.budget.byCategory[category];
    lines.push(
      spread(
        `  ${category}`,
        `${formatINR(ledger.spent)} of ${formatINR(ledger.allocated)}, ${formatINR(ledger.remaining)} left`,
      ),
    );
  }
  lines.push(
    spread(
      "  TOTAL",
      `${formatINR(state.budget.totalSpent)} of ${formatINR(state.budget.totalINR)}, ${formatINR(state.budget.totalRemaining)} left`,
    ),
  );
  lines.push(rule("="));

  return lines.join("\n");
}

/** Indented body text gets a slightly narrower measure. */
const WIDTH_INNER = 72;
