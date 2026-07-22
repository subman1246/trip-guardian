/**
 * The bridge between what the model asks for and what actually happens.
 *
 * The model can only ask. Every request lands here, gets its arguments checked,
 * and is then handed to the REAL prompt-2 tool. Nothing in this file does its
 * own budget maths or edits state directly, so every invariant the tools enforce
 * still holds no matter what the model sends.
 *
 * Bad arguments are not a crash. They come back to the model as an ordinary
 * rejection with an explanation, and the model gets to try again.
 */

import { CATEGORIES, TIME_SLOTS, type Category, type TimeSlot, type TripState, type World } from "../data/types.js";
import {
  notifyUser,
  reallocateBudget,
  rebookSlot,
  searchAlternatives,
  type NotificationInput,
  type SearchQuery,
} from "../tools/index.js";

/** What the loop needs to know after a tool ran. */
export interface ExecutionOutcome {
  /** State after the call. Unchanged for read only tools and for every rejection. */
  state: TripState;
  /** The compact JSON handed back to the model. */
  payload: Record<string, unknown>;
  ok: boolean;
  summary: string;
  /** Machine readable reason, present only on a rejection. */
  reason?: string;
  shortfall?: number;
  /** True when the itinerary or the allocations actually moved. */
  changedState: boolean;
  /** Set when this call was the final report, so the loop knows it can stop. */
  notificationMessage?: string;
}

/** Thrown internally when the model sends arguments we cannot use. */
class ArgumentError extends Error {}

export function executeToolCall(
  world: World,
  state: TripState,
  name: string,
  args: Record<string, unknown>,
): ExecutionOutcome {
  try {
    switch (name) {
      case "search_alternatives":
        return runSearch(world, state, args);
      case "rebook_slot":
        return runRebook(world, state, args);
      case "reallocate_budget":
        return runReallocate(world, state, args);
      case "notify_user":
        return runNotify(world, state, args);
      default:
        return rejected(
          state,
          "unknown_tool",
          `There is no tool called "${name}". Use one of: search_alternatives, rebook_slot, reallocate_budget, notify_user.`,
        );
    }
  } catch (error) {
    // Malformed arguments come back as a normal rejection so the model can fix
    // them, rather than taking the whole run down.
    if (error instanceof ArgumentError) {
      return rejected(state, "invalid_arguments", error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------- the tools

function runSearch(world: World, state: TripState, args: Record<string, unknown>): ExecutionOutcome {
  const timeSlot = optionalEnum<TimeSlot>(args, "timeSlot", TIME_SLOTS);
  const category = optionalEnum<Category>(args, "category", CATEGORIES);
  const maxPrice = optionalInteger(args, "maxPrice");
  const mustFit = optionalBoolean(args, "mustFitRemainingBudget");
  const sortBy = optionalEnum<"cheapest" | "closest_price">(args, "sortBy", [
    "cheapest",
    "closest_price",
  ]);

  if (timeSlot === undefined && category === undefined) {
    throw new ArgumentError(
      "search_alternatives needs at least a timeSlot or a category, otherwise it returns the whole catalogue.",
    );
  }

  const query: SearchQuery = {
    ...(timeSlot !== undefined ? { timeSlot } : {}),
    ...(category !== undefined ? { category } : {}),
    constraints: {
      ...(maxPrice !== undefined ? { maxPrice } : {}),
      ...(mustFit !== undefined ? { mustFitRemainingBudget: mustFit } : {}),
      ...(sortBy !== undefined ? { sortBy } : {}),
    },
  };

  const result = searchAlternatives(world, state, query);
  if (!result.ok) return fromFailure(result.state, result.reason, result.summary);

  const { current, alternatives, excluded, shortOfBudget } = result.details;

  return {
    state: result.state,
    ok: true,
    summary: result.summary,
    changedState: false,
    payload: {
      ok: true,
      summary: result.summary,
      currentlyBooked:
        current === null ? null : { id: current.id, name: current.name, price: current.price },
      alternatives: alternatives.map((alternative) => ({
        id: alternative.option.id,
        name: alternative.option.name,
        price: alternative.option.price,
        timeSlot: alternative.option.timeSlot,
        category: alternative.option.category,
        description: alternative.option.description,
        priceDelta: alternative.priceDelta,
        fitsRemainingBudget: alternative.fitsRemainingBudget,
        shortfallINR: alternative.shortfall,
      })),
      // Everything listed above exists and is open. This counts how many of them
      // need money moved before they can be booked, which is a task, not a wall.
      needMoreBudget: shortOfBudget,
      filteredOut: excluded,
      ...(shortOfBudget > 0 && shortOfBudget === alternatives.length
        ? {
            hint:
              "Every option for this slot exists but is short of budget. Spend less somewhere " +
              "else first (rebook_slot down to a cheaper option), which frees allocation, then " +
              "reallocate_budget into this category, then rebook here. Leaving the slot empty " +
              "is a last resort, not the answer to a shortfall.",
          }
        : {}),
    },
  };
}

function runRebook(world: World, state: TripState, args: Record<string, unknown>): ExecutionOutcome {
  const newOptionId = requiredString(args, "newOptionId");
  // An absent, empty or literal "null" old id all mean "the slot is empty".
  const rawOld = optionalString(args, "oldOptionId");
  const oldOptionId = rawOld === undefined || rawOld === "" || rawOld === "null" ? null : rawOld;

  const result = rebookSlot(world, state, oldOptionId, newOptionId);

  if (!result.ok) {
    return {
      ...fromFailure(result.state, result.reason, result.summary, result.shortfall),
      payload: {
        ok: false,
        reason: result.reason,
        summary: result.summary,
        ...(result.shortfall !== undefined ? { shortfallINR: result.shortfall } : {}),
        hint:
          result.reason === "category_would_go_negative"
            ? "Call reallocate_budget to move at least the shortfall into this category from one with spare allocation, then call rebook_slot again."
            : undefined,
        budget: budgetSnapshot(result.state),
      },
    };
  }

  const { removed, added, priceDelta } = result.details;

  return {
    state: result.state,
    ok: true,
    summary: result.summary,
    changedState: true,
    payload: {
      ok: true,
      summary: result.summary,
      removed: removed === null ? null : { id: removed.id, name: removed.name, price: removed.price },
      added: { id: added.id, name: added.name, price: added.price },
      priceDelta,
      budget: budgetSnapshot(result.state),
    },
  };
}

function runReallocate(
  world: World,
  state: TripState,
  args: Record<string, unknown>,
): ExecutionOutcome {
  const fromCategory = requiredEnum<Category>(args, "fromCategory", CATEGORIES);
  const toCategory = requiredEnum<Category>(args, "toCategory", CATEGORIES);
  const amount = requiredInteger(args, "amount");

  const result = reallocateBudget(world, state, fromCategory, toCategory, amount);

  if (!result.ok) {
    return {
      ...fromFailure(result.state, result.reason, result.summary, result.shortfall),
      payload: {
        ok: false,
        reason: result.reason,
        summary: result.summary,
        ...(result.shortfall !== undefined ? { shortfallINR: result.shortfall } : {}),
        budget: budgetSnapshot(result.state),
      },
    };
  }

  return {
    state: result.state,
    ok: true,
    summary: result.summary,
    changedState: true,
    payload: { ok: true, summary: result.summary, budget: budgetSnapshot(result.state) },
  };
}

function runNotify(world: World, state: TripState, args: Record<string, unknown>): ExecutionOutcome {
  const input: NotificationInput = {
    headline: requiredString(args, "headline"),
    ...(optionalString(args, "whatHappened") !== undefined
      ? { whatHappened: optionalString(args, "whatHappened") as string }
      : {}),
    ...(optionalString(args, "reasoning") !== undefined
      ? { reasoning: optionalString(args, "reasoning") as string }
      : {}),
    ...(optionalString(args, "tradeoff") !== undefined
      ? { tradeoff: optionalString(args, "tradeoff") as string }
      : {}),
    ...(optionalStringArray(args, "actions") !== undefined
      ? { actions: optionalStringArray(args, "actions") as string[] }
      : {}),
  };

  const result = notifyUser(world, state, input);
  if (!result.ok) return fromFailure(result.state, result.reason, result.summary);

  return {
    state: result.state,
    ok: true,
    summary: result.summary,
    changedState: false,
    notificationMessage: result.details.message,
    payload: {
      ok: true,
      summary: "Report delivered to the traveller. The job is done, stop here.",
    },
  };
}

// ------------------------------------------------------------------ helpers

/** The per category money picture, small enough to send every turn. */
function budgetSnapshot(state: TripState): Record<string, unknown> {
  const byCategory: Record<string, unknown> = {};
  for (const category of CATEGORIES) {
    const ledger = state.budget.byCategory[category];
    byCategory[category] = {
      allocated: ledger.allocated,
      spent: ledger.spent,
      remaining: ledger.remaining,
    };
  }
  return {
    totalINR: state.budget.totalINR,
    totalSpent: state.budget.totalSpent,
    totalRemaining: state.budget.totalRemaining,
    byCategory,
  };
}

function rejected(state: TripState, reason: string, summary: string): ExecutionOutcome {
  return {
    state,
    ok: false,
    reason,
    summary,
    changedState: false,
    payload: { ok: false, reason, summary },
  };
}

function fromFailure(
  state: TripState,
  reason: string,
  summary: string,
  shortfall?: number,
): ExecutionOutcome {
  return {
    state,
    ok: false,
    reason,
    summary,
    changedState: false,
    ...(shortfall !== undefined ? { shortfall } : {}),
    payload: { ok: false, reason, summary },
  };
}

// Argument readers. Each one fails with a sentence the model can act on.

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArgumentError(`"${key}" is required and must be a non empty string.`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ArgumentError(`"${key}" must be a string.`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ArgumentError(`"${key}" must be an array of strings.`);
  }
  return value as string[];
}

function requiredInteger(args: Record<string, unknown>, key: string): number {
  const value = optionalInteger(args, key);
  if (value === undefined) throw new ArgumentError(`"${key}" is required.`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;

  // Models sometimes send numbers as strings. Accept that, reject real nonsense.
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    throw new ArgumentError(`"${key}" must be a number of whole rupees.`);
  }
  if (!Number.isInteger(numeric)) {
    throw new ArgumentError(`"${key}" must be a whole number of rupees, got ${numeric}.`);
  }
  return numeric;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ArgumentError(`"${key}" must be true or false.`);
}

function requiredEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): T {
  const value = optionalEnum<T>(args, key, allowed);
  if (value === undefined) {
    throw new ArgumentError(`"${key}" is required and must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): T | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ArgumentError(`"${key}" must be one of: ${allowed.join(", ")}. Got "${String(value)}".`);
  }
  return value as T;
}
