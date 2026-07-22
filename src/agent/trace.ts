/**
 * The visible reasoning trace.
 *
 * This is what a judge watches. It has to read like a narrative: here is what
 * broke, here is what the agent thought, here is the tool it reached for, here
 * is what came back, here is the money now. Everything prints as it happens, so
 * the run unfolds live rather than appearing all at once at the end.
 */

import { CATEGORIES, type BudgetState, type Category } from "../data/types.js";
import { formatINR } from "../world/money.js";
import { WIDTH, bulletLines, clip, rule, spread, wrap } from "../world/printer.js";
import type { AgentObserver, AgentRun, RecordedCall } from "./loop.js";

/** Build an observer that prints the run as it happens. */
export function createTracePrinter(): AgentObserver {
  return {
    onStart({ modelName, maxTurns }) {
      console.log(rule("="));
      console.log("AGENT RUN");
      console.log(spread(`model: ${modelName}`, `turn cap: ${maxTurns}`));
      console.log(rule("="));
    },

    onTurnStart(index) {
      console.log("");
      console.log(rule("-"));
      console.log(`TURN ${index}`);
      console.log(rule("-"));
    },

    onReasoning(_index, text) {
      console.log("REASONING");
      for (const paragraph of text.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (trimmed.length === 0) continue;
        for (const line of wrap(trimmed, WIDTH, "  ")) console.log(line);
        console.log("");
      }
    },

    onToolCall(name, args) {
      console.log(`CALLS  ${name}`);
      for (const line of formatArgs(args)) console.log(line);
    },

    onToolResult(call) {
      console.log(formatCallResult(call));
      console.log("");
    },

    onNudge(index) {
      console.log(`(no tool calls on turn ${index}, reminding the agent to finish)`);
      console.log("");
    },

    onFinish(run) {
      console.log(formatRunSummary(run));
    },
  };
}

/** The arguments the model chose, one per line, so they are easy to scan. */
function formatArgs(args: Record<string, unknown>): string[] {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return ["    (no arguments)"];

  return entries.map(([key, value]) => {
    // Long strings (the notify_user report) are summarised, not dumped.
    const rendered =
      typeof value === "string"
        ? `"${clip(value, 44)}"`
        : Array.isArray(value)
          ? `[${value.length} item(s)]`
          : JSON.stringify(value);
    return `    ${key}: ${rendered}`;
  });
}

/** The result line, plus the money movement when there was any. */
function formatCallResult(call: RecordedCall): string {
  const { outcome, budgetBefore, budgetAfter } = call;
  const status = outcome.ok ? "OK" : `REJECTED (${outcome.reason})`;
  const lines: string[] = [];

  lines.push(spread("RESULT", status));
  lines.push(...wrap(outcome.summary, WIDTH, "  "));

  if (outcome.shortfall !== undefined) {
    lines.push(`    short by ${formatINR(outcome.shortfall)}`);
  }

  // Show exactly which categories moved, rather than reprinting the whole table.
  if (outcome.changedState) {
    const moved = describeBudgetChange(budgetBefore, budgetAfter);
    if (moved.length > 0) {
      lines.push("  budget:");
      for (const line of moved) lines.push(`    ${line}`);
    }
  }

  return lines.join("\n");
}

/** One line per category that actually changed, before and after. */
function describeBudgetChange(before: BudgetState, after: BudgetState): string[] {
  const lines: string[] = [];

  for (const category of CATEGORIES) {
    const a = before.byCategory[category];
    const b = after.byCategory[category];
    if (a.allocated === b.allocated && a.spent === b.spent) continue;

    lines.push(
      `${category.padEnd(10)} ${ledgerLine(a)}  ->  ${ledgerLine(b)}${flagOverspend(b.remaining)}`,
    );
  }

  return lines;
}

function ledgerLine(ledger: { allocated: number; spent: number; remaining: number }): string {
  return `${formatINR(ledger.spent)} of ${formatINR(ledger.allocated)} (${formatINR(ledger.remaining)} left)`;
}

function flagOverspend(remaining: number): string {
  return remaining < 0 ? "  OVER" : "";
}

/** The closing block: how it ended, and whether the money is sound. */
export function formatRunSummary(run: AgentRun): string {
  const lines: string[] = [];

  lines.push(rule("="));
  lines.push("RUN COMPLETE");
  lines.push(rule("="));

  const ending: Record<AgentRun["stopped"], string> = {
    reported: "The agent finished and reported to the traveller.",
    max_turns: "The agent hit the turn cap before reporting. The trip may be unrepaired.",
    gave_up: "The agent stopped calling tools without reporting.",
  };
  lines.push(...wrap(ending[run.stopped], WIDTH, "  "));

  lines.push("");
  lines.push(spread("  model turns", String(run.turns.length)));
  lines.push(spread("  tool calls", String(run.toolCallCount)));
  lines.push(spread("  refused by the tools", String(run.rejectionCount)));

  // What actually changed across the whole run.
  const before = run.initialState.budget;
  const after = run.finalState.budget;
  lines.push("");
  lines.push("  NET EFFECT ON THE BUDGET");
  for (const category of CATEGORIES) {
    lines.push(`    ${category.padEnd(10)} ${ledgerLine(before.byCategory[category])}`);
    lines.push(`    ${" ".repeat(10)} ${ledgerLine(after.byCategory[category])}`);
  }
  lines.push(
    spread(
      "    TOTAL SPENT",
      `${formatINR(before.totalSpent)}  ->  ${formatINR(after.totalSpent)} of ${formatINR(after.totalINR)}`,
    ),
  );

  // The promise of the product, checked rather than claimed.
  const overspent = CATEGORIES.filter(
    (category: Category) => after.byCategory[category].remaining < 0,
  );
  lines.push("");
  if (overspent.length === 0 && after.totalRemaining >= 0) {
    lines.push("  BUDGET HELD. Every category is within its allocation.");
  } else {
    lines.push(`  BUDGET BROKEN in: ${overspent.join(", ")}`);
  }

  lines.push(rule("="));
  return lines.join("\n");
}

/** Print the itinerary gaps, if the agent left any. Used by the demo script. */
export function formatOpenSlots(slots: string[]): string {
  if (slots.length === 0) return "";
  const lines = [rule("-"), "SLOTS LEFT EMPTY"];
  for (const slot of slots) lines.push(...bulletLines(slot));
  lines.push(rule("-"));
  return lines.join("\n");
}
