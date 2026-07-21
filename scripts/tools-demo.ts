/**
 * npm run tools-demo
 *
 * Proves the four agent tools and the disruption engine work, by driving them
 * through a fixed script and printing the world before and after each step.
 *
 * There is NO AI here. Every call below is hand written, in order. Prompt 3
 * replaces this fixed sequence with a model deciding the same calls for itself.
 *
 * Note how the state is threaded: every tool returns a new TripState and we
 * rebind. Nothing is ever edited in place.
 */

import type { Disruption, TripState, World } from "../src/data/types.js";
import { applyDisruption, getDisruption, loadDisruptions } from "../src/events/engine.js";
import {
  formatAlternatives,
  formatToolResult,
  notifyUser,
  reallocateBudget,
  rebookSlot,
  searchAlternatives,
} from "../src/tools/index.js";
import { buildInitialTripState, loadWorld } from "../src/world/loader.js";
import {
  bulletLines,
  formatBudget,
  formatCatalogue,
  printTripState,
  rule,
  wrap,
} from "../src/world/printer.js";

/** A numbered banner so the steps are easy to follow in a recording. */
let stepNumber = 0;
function step(title: string): void {
  console.log("");
  console.log(rule("="));
  console.log(`STEP ${++stepNumber}: ${title.toUpperCase()}`);
  console.log(rule("="));
}

/** Print what a disruption did to the world. */
function reportDisruption(disruption: Disruption, changes: string[]): void {
  console.log(`DISRUPTION ${disruption.id} (${disruption.kind})`);
  console.log("");
  for (const line of wrap(`"${disruption.message}"`, 74, "  ")) console.log(line);
  console.log("");
  console.log("  Effect on the world:");
  for (const change of changes) {
    for (const line of bulletLines(change, "- ", "    ")) console.log(line);
  }
  console.log("");
}

function main(): void {
  // Both world and state get rebound as the demo goes. That is the whole point
  // of the immutable rule: the old values stay valid if you kept a reference.
  let world: World = loadWorld();
  let state: TripState = buildInitialTripState(world);
  const disruptions = loadDisruptions(world);

  // ---------------------------------------------------------------- step 1
  step("the trip as booked");
  printTripState(state, world);

  // ---------------------------------------------------------------- step 2
  step("fire a disruption, the Amber Fort tour is cancelled");
  {
    const outcome = applyDisruption(world, state, getDisruption(disruptions, "d1"));
    world = outcome.world;
    state = outcome.state;
    reportDisruption(outcome.disruption, outcome.changes);
    printTripState(state, world);
  }

  // ---------------------------------------------------------------- step 3
  step("search_alternatives for the empty slot");
  {
    const result = searchAlternatives(world, state, { timeSlot: "Day 1 Afternoon" });
    console.log(formatToolResult("search_alternatives(Day 1 Afternoon)", result));
    console.log("");
    if (result.ok) console.log(formatAlternatives(result.details));

    // Again with constraints, to show the filters actually bite.
    console.log("");
    const filtered = searchAlternatives(world, state, {
      category: "activity",
      constraints: { maxPrice: 1000, mustFitRemainingBudget: true },
    });
    console.log(formatToolResult("search_alternatives(activity, max Rs 1,000)", filtered));
    console.log("");
    if (filtered.ok) console.log(formatAlternatives(filtered.details));
  }

  // ---------------------------------------------------------------- step 4
  step("rebook_slot, fill the empty afternoon with the City Palace");
  {
    const result = rebookSlot(world, state, null, "a2");
    console.log(formatToolResult("rebook_slot(null -> a2)", result));
    state = result.state;
    console.log("");
    printTripState(state, world);
  }

  // ---------------------------------------------------------------- step 5
  step("reallocate_budget, move Rs 1,000 from stay to activity");
  {
    const result = reallocateBudget(world, state, "stay", "activity", 1000);
    console.log(formatToolResult("reallocate_budget(stay -> activity, 1000)", result));
    state = result.state;
    console.log("");
    // Only money moved, so the itinerary is unchanged and the budget is the story.
    console.log(formatBudget(state));
  }

  // ---------------------------------------------------------------- step 6
  step("fire a price spike, the cab is repriced mid trip");
  {
    const outcome = applyDisruption(world, state, getDisruption(disruptions, "d2"));
    world = outcome.world;
    state = outcome.state;
    reportDisruption(outcome.disruption, outcome.changes);
    if (outcome.overBudgetCategory) {
      console.log(`  Category now over budget: ${outcome.overBudgetCategory}`);
      console.log("");
    }
    console.log(formatBudget(state));
  }

  // ---------------------------------------------------------------- step 7
  step("rebook_slot to absorb the spike, cab down to the auto pass");
  {
    const result = rebookSlot(world, state, "t3", "t4");
    console.log(formatToolResult("rebook_slot(t3 -> t4)", result));
    state = result.state;
    console.log("");
    printTripState(state, world);
  }

  // ---------------------------------------------------------------- step 8
  step("the guard rails, four calls that must be refused");
  {
    // a. The cancelled tour is closed, it cannot come back.
    const closed = rebookSlot(world, state, null, "a1");
    console.log(formatToolResult("rebook_slot(null -> a1, a closed option)", closed));
    console.log("");

    // b. A hotel cannot replace a cab, even though both sit in the Trip slot.
    const wrongCategory = rebookSlot(world, state, "s2", "t3");
    console.log(formatToolResult("rebook_slot(s2 -> t3, stay replaced by transport)", wrongCategory));
    console.log("");

    // c. The heritage suite is wanted, but stay cannot cover it yet.
    const tooExpensive = rebookSlot(world, state, "s2", "s3");
    console.log(formatToolResult("rebook_slot(s2 -> s3, busts the stay budget)", tooExpensive));
    console.log("");

    // d. And activity cannot hand over more than it has spare.
    const tooGreedy = reallocateBudget(world, state, "activity", "stay", 5000);
    console.log(formatToolResult("reallocate_budget(activity -> stay, 5000)", tooGreedy));
    console.log("");

    console.log("  All four were refused and the trip is untouched:");
    console.log(
      `  itinerary still has ${state.itinerary.length} items, total spent unchanged.`,
    );
  }

  // ---------------------------------------------------------------- step 9
  step("the legal route to the same upgrade, reallocate then rebook");
  {
    const moved = reallocateBudget(world, state, "activity", "stay", 1400);
    console.log(formatToolResult("reallocate_budget(activity -> stay, 1400)", moved));
    state = moved.state;
    console.log("");

    const upgraded = rebookSlot(world, state, "s2", "s3");
    console.log(formatToolResult("rebook_slot(s2 -> s3, retried after reallocation)", upgraded));
    state = upgraded.state;
    console.log("");
    printTripState(state, world);
  }

  // --------------------------------------------------------------- step 10
  step("notify_user, the traveller facing report");
  {
    const result = notifyUser(world, state, {
      headline: "Two problems hit your Jaipur trip. Both are handled, and you are still under budget.",
      whatHappened:
        "Amber Fort closed for a state ceremony, which cancelled your guided tour. Then a fuel surcharge repriced your two day private cab from Rs 2,200 to Rs 3,600, which put transport over its allocation.",
      reasoning:
        "The City Palace fills the same afternoon for Rs 500 less than the fort tour, so the day stays full. On the cab, the auto rickshaw pass covers the same two days for Rs 800, and the Pink City is compact enough that you lose comfort rather than access. That freed enough to move you into the heritage suite.",
      actions: [
        "Rebooked Day 1 Afternoon to the City Palace and Museum, Rs 700.",
        "Replaced the private cab with the auto rickshaw day pass, saving Rs 2,800.",
        "Moved Rs 1,400 of allocation from activity to stay.",
        "Upgraded your room to the Alsisar Haveli heritage suite, Rs 5,400.",
      ],
      tradeoff:
        "You lose the guided fort tour and the private car. In exchange you gain a heritage suite with a courtyard pool, and you are still holding money back.",
    });

    console.log(formatToolResult("notify_user(summary)", result));
    console.log("");
    if (result.ok) console.log(result.details.message);
  }

  // ---------------------------------------------------------------- wrap up
  step("final catalogue, showing what is still bookable");
  console.log(formatCatalogue(world, state));
  console.log("");
}

try {
  main();
} catch (error) {
  console.error("\nThe tools demo failed.\n");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
