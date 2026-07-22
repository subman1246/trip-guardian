/**
 * npm run verify-scenario -- <scenario-id>
 *
 * Offline arithmetic check on a scenario. No AI, no network. It fires the
 * scenario's disruptions against the real world.json and then drives the real
 * tools by hand to answer two questions a demo scenario has to get right:
 *
 *   1. Is it SOLVABLE? Does a sequence of legal tool calls exist that ends with
 *      every slot filled and no category over its allocation?
 *   2. Does it FORCE A REJECTION? Can the agent get there with one straight
 *      rebooking, or with a single reallocation? If it can, the reject-and-adapt
 *      path never fires on camera.
 *
 * This exists because both properties are pure arithmetic over world.json, and
 * arithmetic should be checked rather than believed.
 */

import { CATEGORIES, type TripState, type World } from "../src/data/types.js";
import { resolveDisruption } from "../src/events/applicability.js";
import { applyDisruption, getDisruption, loadDisruptions } from "../src/events/engine.js";
import { getScenario, loadScenarios } from "../src/events/scenarios.js";
import { reallocateBudget, rebookSlot } from "../src/tools/index.js";
import { buildInitialTripState, loadWorld, optionsForSlot } from "../src/world/loader.js";
import { formatINR } from "../src/world/money.js";
import { rule } from "../src/world/printer.js";

const DEFAULT_SCENARIO = "no-donor-left";

/** One line of money, compact enough to sit under every step. */
function money(state: TripState): string {
  return CATEGORIES.map((category) => {
    const ledger = state.budget.byCategory[category];
    return `${category} ${ledger.spent}/${ledger.allocated} (${ledger.remaining} spare)`;
  }).join("   ");
}

function main(): void {
  const requested = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? DEFAULT_SCENARIO;

  let world: World = loadWorld();
  let state: TripState = buildInitialTripState(world);
  const disruptions = loadDisruptions(world);
  const scenario = getScenario(loadScenarios(disruptions), requested);

  console.log("");
  console.log(rule("="));
  console.log(`VERIFY: ${scenario.id}`);
  console.log(rule("="));
  console.log(`  before        ${money(state)}`);

  for (const id of scenario.disruptionIds) {
    // Resolve before applying. A disruption written against a slot and category
    // rather than an option id has no optionId until it is matched to what this
    // trip actually booked, and the engine only ever handles a concrete one.
    const resolution = resolveDisruption(world, state, getDisruption(disruptions, id), world);
    if (!resolution.ok) {
      console.log(`  ${id.padEnd(14)}does not apply to this trip: ${resolution.reason}`);
      continue;
    }

    const outcome = applyDisruption(world, state, resolution.disruption);
    world = outcome.world;
    state = outcome.state;
    console.log(`  after ${id.padEnd(8)}${money(state)}`);
  }

  // The state every check below starts from.
  const damaged = state;

  // Which day slots the disruptions emptied, and what is left to fill them.
  const filled = new Set(damaged.itinerary.map((item) => item.timeSlot));
  const emptySlots = ["Day 1 Morning", "Day 1 Afternoon", "Day 1 Evening", "Day 2 Morning", "Day 2 Afternoon"]
    .filter((slot) => !filled.has(slot as never));

  console.log("");
  console.log("EMPTY SLOTS AND WHAT COULD FILL THEM");
  if (emptySlots.length === 0) console.log("  (none)");
  for (const slot of emptySlots) {
    console.log(`  ${slot}`);
    for (const option of optionsForSlot(world, slot)) {
      const open = option.available !== false;
      console.log(`    ${option.id}  ${formatINR(option.price).padStart(9)}  ${open ? "open  " : "CLOSED"}  ${option.name}`);
    }
  }

  // ------------------------------------------------ can it be done the easy way
  console.log("");
  console.log("IS THERE A STRAIGHTFORWARD FIRST MOVE (would mean no rejection fires)");

  let straightforward = false;

  for (const slot of emptySlots) {
    for (const option of optionsForSlot(world, slot)) {
      if (option.available === false) continue;
      const result = rebookSlot(world, damaged, null, option.id);
      const verdict = result.ok ? "ACCEPTED" : `refused (${result.reason})`;
      console.log(`  rebook ${option.id} straight into ${slot}: ${verdict}`);
      if (result.ok) straightforward = true;
      if (result.ok || result.shortfall === undefined) continue;

      // With one reallocation in front of it, from each donor in turn.
      const shortfall = result.shortfall;
      for (const donor of CATEGORIES) {
        if (donor === option.category) continue;
        const moved = reallocateBudget(world, damaged, donor, option.category, shortfall);
        console.log(
          `    reallocate ${formatINR(shortfall)} ${donor} -> ${option.category} first: ${moved.ok ? "ACCEPTED" : `refused (${moved.reason})`}`,
        );
        if (moved.ok) straightforward = true;
      }

      // The strongest version of reallocating alone: every other category hands
      // over every rupee it has not already spent. If even that falls short, no
      // sequence of reallocations can pay for this booking and the agent has to
      // reduce spend somewhere before the money exists.
      const donorPool = CATEGORIES.filter((category) => category !== option.category).reduce(
        (sum, category) => sum + Math.max(0, damaged.budget.byCategory[category].remaining),
        0,
      );
      console.log(
        `    every donor emptied gives ${formatINR(donorPool)} against a ${formatINR(shortfall)} shortfall: ${donorPool >= shortfall ? "ENOUGH" : "still short"}`,
      );
      if (donorPool >= shortfall) straightforward = true;
    }
  }

  console.log("");
  console.log(
    straightforward
      ? "  VERDICT: a rejection is NOT forced, the agent can succeed on a first attempt."
      : "  VERDICT: a rejection IS forced, no single rebooking or reallocation gets there.",
  );

  // Categories already over their allocation have to be repaired too, and a
  // category in that state cannot lend anything to anybody.
  const overspent = CATEGORIES.filter((category) => damaged.budget.byCategory[category].remaining < 0);
  if (overspent.length > 0) {
    console.log("");
    console.log("CATEGORIES ALREADY OVER (cannot lend, and need lending themselves)");
    for (const category of overspent) {
      const ledger = damaged.budget.byCategory[category];
      console.log(`  ${category} is ${formatINR(-ledger.remaining)} over ${formatINR(ledger.allocated)}`);
      // Every swap available to this category, from each booking it currently holds.
      const booked = damaged.itinerary
        .map((item) => world.options.find((option) => option.id === item.optionId))
        .filter((option): option is NonNullable<typeof option> => option !== undefined && option.category === category);

      let anySwap = false;
      for (const current of booked) {
        for (const option of optionsForSlot(world, current.timeSlot)) {
          if (option.category !== category || option.id === current.id || option.available === false) continue;
          anySwap = true;
          const swap = rebookSlot(world, damaged, current.id, option.id);
          console.log(
            `    swap ${current.id} -> ${option.id} (${formatINR(option.price)}): ${swap.ok ? "ACCEPTED" : `refused (${swap.reason})`}`,
          );
        }
      }
      if (!anySwap) console.log("    no open alternative exists, this category cannot be cut at all");
    }
  }

  // -------------------------------------------------------- is it recoverable
  console.log("");
  console.log("RECOVERY PATH (spend less first, then reallocate, then rebook)");

  state = damaged;
  const path: Array<[string, () => ReturnType<typeof rebookSlot> | ReturnType<typeof reallocateBudget>]> = [
    ["rebook t3 -> t4 (private cab down to the auto pass)", () => rebookSlot(world, state, "t3", "t4")],
    ["reallocate Rs 700 transport -> activity", () => reallocateBudget(world, state, "transport", "activity", 700)],
    ["rebook the empty Day 2 Morning to a6", () => rebookSlot(world, state, null, "a6")],
  ];

  for (const [label, run] of path) {
    const result = run();
    console.log(`  ${result.ok ? "OK      " : "REFUSED "} ${label}`);
    console.log(`           ${result.summary}`);
    state = result.state;
    console.log(`           ${money(state)}`);
  }

  const over = CATEGORIES.filter((category) => state.budget.byCategory[category].remaining < 0);
  const stillEmpty = ["Day 1 Morning", "Day 1 Afternoon", "Day 1 Evening", "Day 2 Morning", "Day 2 Afternoon"]
    .filter((slot) => !new Set(state.itinerary.map((item) => item.timeSlot)).has(slot as never));

  console.log("");
  console.log(
    over.length === 0 && stillEmpty.length === 0
      ? "  VERDICT: SOLVABLE, every slot filled and every category inside its allocation."
      : `  VERDICT: NOT SOLVABLE by this path. over: [${over.join(", ")}] empty: [${stillEmpty.join(", ")}]`,
  );
  console.log(rule("="));
  console.log("");
}

try {
  main();
} catch (error) {
  console.error("\nThe scenario check failed.\n");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
