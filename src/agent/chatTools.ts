/**
 * The chat dispatcher: the real four tools, plus apply_disruption.
 *
 * For every name except apply_disruption, this hands straight off to the REAL
 * executor.ts, completely unmodified, so search_alternatives, rebook_slot,
 * reallocate_budget and notify_user behave in chat exactly as they do in a
 * scripted run. Nothing about their validation or their invariants is touched.
 *
 * apply_disruption is new, and it is deliberately thin. It does not know how to
 * cancel an activity or reprice a hotel, it only knows how to turn the model's
 * arguments into a Disruption and hand that to the SAME resolver and the SAME
 * engine the scripted scenarios use (src/events/applicability.ts,
 * src/events/engine.ts). If those arguments do not name a real option, or a
 * real slot and category this trip actually booked, resolution fails and the
 * call comes back as an ordinary rejection, the same as a malformed rebook_slot
 * call would. The model can only ask for one of the four disruption KINDS the
 * dataset already defines, never anything else.
 *
 * ONE DIFFERENCE FROM executor.ts's shape: apply_disruption can change the
 * WORLD (an option's price or availability), which none of the four budget
 * tools ever do, so ChatExecutionOutcome carries a world alongside the state.
 * Every other tool passes its input world back unchanged.
 */

import {
  CATEGORIES,
  TIME_SLOTS,
  type Category,
  type Disruption,
  type DisruptionKind,
  type TimeSlot,
  type TripState,
  type World,
} from "../data/types.js";
import { resolveDisruption } from "../events/applicability.js";
import { applyDisruption } from "../events/engine.js";
import { isValidAmount } from "../world/money.js";
import { executeToolCall, type ExecutionOutcome } from "./executor.js";

export interface ChatExecutionOutcome extends ExecutionOutcome {
  /** Only apply_disruption ever changes this. Every other tool echoes it back. */
  world: World;
}

const DISRUPTION_KINDS: readonly DisruptionKind[] = [
  "activity_cancelled",
  "price_spike",
  "venue_closed",
  "price_drop",
];

class ArgumentError extends Error {}

export function executeChatToolCall(
  world: World,
  state: TripState,
  name: string,
  args: Record<string, unknown>,
  baseWorld: World,
): ChatExecutionOutcome {
  if (name !== "apply_disruption") {
    // The real four tools, untouched. World never moves under them.
    return { world, ...executeToolCall(world, state, name, args) };
  }

  try {
    return runApplyDisruption(world, state, args, baseWorld);
  } catch (error) {
    if (error instanceof ArgumentError) {
      return rejectedOutcome(world, state, "invalid_arguments", error.message);
    }
    throw error;
  }
}

// --------------------------------------------------------- apply_disruption

function runApplyDisruption(
  world: World,
  state: TripState,
  args: Record<string, unknown>,
  baseWorld: World,
): ChatExecutionOutcome {
  const kind = requiredEnum<DisruptionKind>(args, "kind", DISRUPTION_KINDS);
  const message = requiredString(args, "message");
  const optionId = optionalString(args, "optionId");
  const timeSlot = optionalEnum<TimeSlot>(args, "timeSlot", TIME_SLOTS);
  const category = optionalEnum<Category>(args, "category", CATEGORIES);
  const newPrice = optionalNumber(args, "newPrice");
  const priceFactor = optionalNumber(args, "priceFactor");

  const pinned = optionId !== undefined;
  const targeted = timeSlot !== undefined || category !== undefined;

  if (pinned === targeted) {
    throw new ArgumentError(
      "apply_disruption needs EITHER optionId (when you know exactly what it is) OR both " +
        "timeSlot and category (when you only know where), never both and never neither.",
    );
  }
  if (targeted && (timeSlot === undefined || category === undefined)) {
    throw new ArgumentError("A targeted apply_disruption needs both timeSlot and category, not just one.");
  }

  const isPriceKind = kind === "price_spike" || kind === "price_drop";

  // A pinned price event states its own new price, since resolveDisruption
  // passes a pinned disruption through unchanged, it does no price maths for
  // one. That has to be checked here, the same way validateDisruptions checks
  // it for the scripted catalogue.
  if (pinned && isPriceKind) {
    const existing = world.options.find((option) => option.id === optionId);
    if (existing === undefined) {
      return rejectedOutcome(world, state, "unknown_option", `There is no option with id "${optionId}" on this trip.`);
    }
    if (newPrice === undefined || !isValidAmount(newPrice)) {
      throw new ArgumentError(`${kind} on a named option needs newPrice as a whole number of rupees.`);
    }
    if (kind === "price_spike" && newPrice <= existing.price) {
      throw new ArgumentError(
        `price_spike must raise the price. "${existing.name}" is currently ${existing.price}, ${newPrice} is not above that.`,
      );
    }
    if (kind === "price_drop" && newPrice >= existing.price) {
      throw new ArgumentError(
        `price_drop must lower the price. "${existing.name}" is currently ${existing.price}, ${newPrice} is not below that.`,
      );
    }
  } else if (targeted && isPriceKind) {
    if (priceFactor === undefined || !Number.isFinite(priceFactor) || priceFactor <= 0) {
      throw new ArgumentError(`${kind} on a slot and category needs a positive priceFactor.`);
    }
    if (kind === "price_spike" && priceFactor <= 1) {
      throw new ArgumentError(`price_spike needs a priceFactor above 1, got ${priceFactor}.`);
    }
    if (kind === "price_drop" && priceFactor >= 1) {
      throw new ArgumentError(`price_drop needs a priceFactor below 1, got ${priceFactor}.`);
    }
  }

  const candidate: Disruption = {
    // Not a catalogue id, this disruption is ad hoc and never looked up by id.
    id: "chat",
    kind,
    message,
    ...(pinned ? { optionId: optionId as string } : {}),
    ...(targeted ? { target: { timeSlot: timeSlot as TimeSlot, category: category as Category } } : {}),
    // Validated above: a pinned price kind always has newPrice by this point,
    // and a targeted price kind always has priceFactor.
    ...(pinned && isPriceKind ? { newPrice: newPrice as number } : {}),
    ...(targeted && isPriceKind ? { priceFactor: priceFactor as number } : {}),
  };

  // The SAME resolver every scripted scenario goes through. A targeted
  // disruption is matched against what this trip actually booked, a pinned one
  // is checked for existing and, for the kinds that need it, for being booked.
  // Nothing here decides where the disruption lands, resolveDisruption does.
  const resolution = resolveDisruption(world, state, candidate, baseWorld);
  if (!resolution.ok) {
    return rejectedOutcome(world, state, "not_applicable", resolution.reason);
  }

  // The SAME engine every scripted scenario goes through. No mutation logic is
  // duplicated here.
  const outcome = applyDisruption(world, state, resolution.disruption);

  return {
    world: outcome.world,
    state: outcome.state,
    ok: true,
    summary: outcome.disruption.message,
    changedState: outcome.itineraryAffected || outcome.overBudgetCategory !== undefined,
    payload: {
      ok: true,
      summary: outcome.disruption.message,
      hitOption: outcome.option.name,
      changes: outcome.changes,
      emptiedSlot: outcome.emptiedSlot ?? null,
      overBudgetCategory: outcome.overBudgetCategory ?? null,
      budget: budgetSnapshot(outcome.state),
    },
  };
}

// ------------------------------------------------------------------ helpers

/** Mirrors executor.ts's own budgetSnapshot, kept local since that one is private. */
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

function rejectedOutcome(
  world: World,
  state: TripState,
  reason: string,
  summary: string,
): ChatExecutionOutcome {
  return {
    world,
    state,
    ok: false,
    reason,
    summary,
    changedState: false,
    payload: { ok: false, reason, summary },
  };
}

// Argument readers, matching executor.ts's conventions so a rejection here
// reads the same way a rejection from one of the four real tools does.

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

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    throw new ArgumentError(`"${key}" must be a number.`);
  }
  return numeric;
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
