/**
 * Agent tool: reallocate_budget
 *
 * Move allocation from one category to another, for example take from stay to
 * afford a better activity. The total budget never changes, only the split.
 *
 * A category can only give away what it has not already spent, so this can never
 * leave a category owing money for bookings it already made.
 */

import { CATEGORIES, type Category, type CategoryLedger, type TripState, type World } from "../data/types.js";
import { formatINR, isValidAmount } from "../world/money.js";
import { budgetFromState, withAllocations } from "../world/state.js";
import { fail, succeed, type ToolResult } from "./types.js";

export interface ReallocateDetails {
  from: Category;
  to: Category;
  amount: number;
  fromBefore: CategoryLedger;
  fromAfter: CategoryLedger;
  toBefore: CategoryLedger;
  toAfter: CategoryLedger;
}

export function reallocateBudget(
  world: World,
  state: TripState,
  from: Category,
  to: Category,
  amount: number,
): ToolResult<ReallocateDetails> {
  if (from === to) {
    return fail(state, "same_category", `Moving budget from ${from} to itself does nothing.`);
  }
  if (!isValidAmount(amount) || amount === 0) {
    return fail(
      state,
      "invalid_amount",
      `Amount must be a positive whole number of rupees, got ${amount}.`,
    );
  }

  const fromBefore = state.budget.byCategory[from];
  const toBefore = state.budget.byCategory[to];

  // A category can only give away allocation it has not spent.
  if (fromBefore.remaining < amount) {
    const shortfall = amount - fromBefore.remaining;
    return fail(
      state,
      "insufficient_allocation",
      `${from} only has ${formatINR(fromBefore.remaining)} unspent, ${formatINR(amount)} is ${formatINR(shortfall)} too much.`,
      { shortfall },
    );
  }

  const allocations = { ...budgetFromState(state).allocations };
  allocations[from] -= amount;
  allocations[to] += amount;

  const next = withAllocations(world, state, allocations);

  // Defensive: the split may move but the pot must not. If this ever fires the
  // bug is in this tool, not in the caller.
  const newTotal = CATEGORIES.reduce((sum, category) => sum + allocations[category], 0);
  if (newTotal !== state.budget.totalINR) {
    throw new Error(
      `reallocate_budget changed the total budget from ${state.budget.totalINR} to ${newTotal}.`,
    );
  }

  return succeed(
    next,
    `Moved ${formatINR(amount)} of allocation from ${from} to ${to}.`,
    {
      from,
      to,
      amount,
      fromBefore,
      fromAfter: next.budget.byCategory[from],
      toBefore,
      toAfter: next.budget.byCategory[to],
    },
  );
}
