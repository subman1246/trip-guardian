/**
 * npm run verify-trips
 *
 * The offline proof for prompt B1. NO AI, NO NETWORK, NO API KEY. Everything
 * below is arithmetic over the local catalogue, so it can be run with the model
 * quota completely exhausted and it will still tell you the truth.
 *
 * It proves five things:
 *
 *   1. SLOT COVERAGE. Every slot a trip of 1, 2, 3 or 4 days uses has at least
 *      two open options in every category it books, so a disruption always
 *      leaves an alternative.
 *   2. TRIPS BUILD. At every length, across several budgets, a trip is
 *      constructed, the allocations sum to the total exactly, and the derived
 *      budget matches a fresh recomputation from the itinerary.
 *   3. HEADROOM. The starting itinerary always fits inside every allocation and
 *      leaves at least the target headroom, both in total and per category.
 *   4. FEASIBILITY. A budget below the minimum is refused with a message that
 *      names the right minimum, and that minimum is exactly right: one rupee
 *      below it fails and the minimum itself succeeds.
 *   5. SCENARIO APPLICABILITY. For every trip shape and every scenario, the
 *      applicability answer matches what actually happens when the scenario is
 *      fired: applicable means it fires cleanly, not applicable means it would
 *      have been meaningless.
 *
 * Exit code is 1 if anything fails, so this is usable as a gate.
 */

import { CATEGORIES, type TripState, type World } from "../src/data/types.js";
import { assessScenario, resolveDisruption } from "../src/events/applicability.js";
import { applyDisruption, getDisruption, loadDisruptions } from "../src/events/engine.js";
import { loadScenarios, type Scenario } from "../src/events/scenarios.js";
import { computeBudgetState, loadWorld } from "../src/world/loader.js";
import { formatINR } from "../src/world/money.js";
import { rule, spread } from "../src/world/printer.js";
import {
  MAX_TRIP_DAYS,
  MIN_TRIP_DAYS,
  nightsForTripLength,
  slotsForTripLength,
} from "../src/world/slots.js";
import {
  CATEGORY_HEADROOM_RATE,
  TOTAL_HEADROOM_RATE,
  assessTripFeasibility,
  buildTrip,
  catalogueForTrip,
  requiredBookings,
} from "../src/world/trip.js";

// ------------------------------------------------------------- the harness

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `   ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `   ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(rule("="));
  console.log(title);
  console.log(rule("="));
}

const DAYS = Array.from(
  { length: MAX_TRIP_DAYS - MIN_TRIP_DAYS + 1 },
  (_, index) => MIN_TRIP_DAYS + index,
);

/** Budgets tried at each length. The minimum is added in as a boundary case. */
const BUDGETS: Record<number, number[]> = {
  1: [6000, 10000],
  2: [12000, 15000, 25000],
  3: [18000, 26000, 40000],
  4: [24000, 34000, 55000],
};

const base: World = loadWorld();
const disruptions = loadDisruptions(base);
const scenarios: Scenario[] = loadScenarios(disruptions);

// ------------------------------------------------- 1. slot coverage
section("1. SLOT COVERAGE: every slot has at least two open options");

for (const days of DAYS) {
  const catalogue = catalogueForTrip(base, days);
  console.log("");
  console.log(`${days} day trip, ${nightsForTripLength(days)} night(s)`);

  for (const slot of slotsForTripLength(days)) {
    const inSlot = catalogue.filter((option) => option.timeSlot === slot);
    const groups = CATEGORIES.filter((category) =>
      inSlot.some((option) => option.category === category),
    );

    for (const category of groups) {
      const open = inSlot.filter(
        (option) => option.category === category && option.available !== false,
      );
      const prices = open
        .slice()
        .sort((a, b) => a.price - b.price)
        .map((option) => `${option.id} ${formatINR(option.price)}`)
        .join(", ");
      check(
        `${slot} / ${category} has ${open.length} open option(s)`,
        open.length >= 2,
        prices,
      );
    }
  }

  // The bookings the trip is required to make must each have a real choice too.
  for (const booking of requiredBookings(catalogue, days)) {
    check(
      `required booking ${booking.timeSlot} / ${booking.category} has a choice`,
      booking.candidates.length >= 2,
      `${booking.candidates.length} candidates`,
    );
  }
}

// ------------------------------------------- 2 and 3. trips build, with headroom
section("2 and 3. TRIPS BUILD AT EVERY LENGTH, AND ALWAYS WITH HEADROOM");

/** Built trips kept for the applicability section below. */
const builtTrips: Array<{ days: number; budget: number; world: World; state: TripState }> = [];

for (const days of DAYS) {
  const minimum = assessTripFeasibility(base, days, 0).minimumINR;
  const budgets = [...new Set([minimum, ...(BUDGETS[days] ?? [])])].sort((a, b) => a - b);

  for (const budget of budgets) {
    const { world, state, plan } = buildTrip(base, days, budget);
    builtTrips.push({ days, budget, world, state });

    console.log("");
    console.log(
      spread(
        `${days} day trip on ${formatINR(budget)}${budget === minimum ? " (the minimum)" : ""}`,
        `${plan.requiredBookings} bookings, spends ${formatINR(plan.startingSpendINR)}`,
      ),
    );
    for (const entry of plan.byCategory) {
      const percent =
        entry.allocated === 0 ? 100 : Math.round((entry.headroom / entry.allocated) * 100);
      console.log(
        `    ${entry.category.padEnd(10)} floor ${formatINR(entry.floor).padStart(9)}   ` +
          `allocated ${formatINR(entry.allocated).padStart(9)}   ` +
          `spends ${formatINR(entry.startingSpend).padStart(9)}   ` +
          `headroom ${formatINR(entry.headroom).padStart(9)} (${String(percent).padStart(3)}%)`,
      );
    }
    console.log(
      `    ITINERARY: ${state.itinerary
        .map((item) => item.optionId)
        .sort()
        .join(" ")}`,
    );

    const label = `${days}d / ${formatINR(budget)}`;

    // The allocations are a split of the total, never a change to it.
    const allocationTotal = CATEGORIES.reduce(
      (sum, category) => sum + state.budget.byCategory[category].allocated,
      0,
    );
    check(`${label} allocations sum to the total`, allocationTotal === budget);

    // Derived money is never written by hand. Recompute from scratch and compare.
    const recomputed = computeBudgetState(world, state.itinerary, world.budget);
    check(
      `${label} budget matches a fresh recomputation`,
      JSON.stringify(recomputed) === JSON.stringify(state.budget),
    );

    // Every required booking is filled exactly once, and nothing else is.
    const required = requiredBookings(catalogueForTrip(base, days), days);
    check(
      `${label} books exactly the ${required.length} required things`,
      state.itinerary.length === required.length,
      `${state.itinerary.length} booked`,
    );
    for (const booking of required) {
      const held = state.itinerary.filter((item) => {
        const option = world.options.find((candidate) => candidate.id === item.optionId);
        return option?.timeSlot === booking.timeSlot && option.category === booking.category;
      });
      check(
        `${label} fills ${booking.timeSlot} / ${booking.category} exactly once`,
        held.length === 1,
      );
    }

    // Headroom, in total and per category.
    const totalHeadroom = state.budget.totalRemaining / budget;
    check(
      `${label} leaves at least ${Math.round(TOTAL_HEADROOM_RATE * 100)}% of the total unspent`,
      totalHeadroom >= TOTAL_HEADROOM_RATE,
      `${(totalHeadroom * 100).toFixed(1)}% left`,
    );

    for (const category of CATEGORIES) {
      const ledger = state.budget.byCategory[category];
      check(`${label} ${category} is inside its allocation`, ledger.remaining >= 0);
      if (ledger.allocated === 0) continue;
      check(
        `${label} ${category} keeps at least ${Math.round(CATEGORY_HEADROOM_RATE * 100)}% headroom`,
        ledger.remaining / ledger.allocated >= CATEGORY_HEADROOM_RATE,
        `${((ledger.remaining / ledger.allocated) * 100).toFixed(1)}% left`,
      );
    }
  }
}

// ------------------------------------------------------- 4. feasibility
section("4. FEASIBILITY: a budget that cannot buy a trip is refused, correctly");

for (const days of DAYS) {
  const probe = assessTripFeasibility(base, days, 0);
  const minimum = probe.minimumINR;

  console.log("");
  console.log(
    spread(
      `${days} day trip`,
      `cheapest plan ${formatINR(probe.cheapestPlanINR)}, minimum ${formatINR(minimum)}`,
    ),
  );

  const below = assessTripFeasibility(base, days, minimum - 1);
  const at = assessTripFeasibility(base, days, minimum);

  check(`${days}d: one rupee below the minimum is refused`, !below.ok);
  check(`${days}d: the minimum itself is accepted`, at.ok);
  check(
    `${days}d: the refusal names the right minimum`,
    below.message.includes(formatINR(minimum)),
  );
  check(
    `${days}d: the refusal names the cheapest plan`,
    below.message.includes(formatINR(probe.cheapestPlanINR)),
  );
  check(`${days}d: a refused budget builds nothing`, buildThrows(days, minimum - 1));
  check(`${days}d: the minimum builds a real trip`, !buildThrows(days, minimum));
}

console.log("");
console.log("THE MESSAGE A TRAVELLER ACTUALLY SEES, for Rs 5,000 over 3 days:");
console.log("");
for (const line of wrapAt(assessTripFeasibility(base, 3, 5000).message, 72)) {
  console.log(`  ${line}`);
}

// A longer trip can never be cheaper than a shorter one.
console.log("");
for (let days = MIN_TRIP_DAYS + 1; days <= MAX_TRIP_DAYS; days += 1) {
  const shorter = assessTripFeasibility(base, days - 1, 0).minimumINR;
  const longer = assessTripFeasibility(base, days, 0).minimumINR;
  check(
    `the ${days} day minimum is above the ${days - 1} day minimum`,
    longer > shorter,
    `${formatINR(shorter)} then ${formatINR(longer)}`,
  );
}

// ------------------------------------------------- 5. scenario applicability
section("5. SCENARIO APPLICABILITY: computed answer matches what firing does");

/**
 * Fire a whole scenario the way the session does. Returns true if every step
 * resolved and applied, false the moment one did not apply.
 */
function fires(world: World, state: TripState, scenario: Scenario): boolean {
  let currentWorld = world;
  let currentState = state;

  for (const id of scenario.disruptionIds) {
    const resolution = resolveDisruption(
      currentWorld,
      currentState,
      getDisruption(disruptions, id),
      base,
    );
    if (!resolution.ok) return false;
    const outcome = applyDisruption(currentWorld, currentState, resolution.disruption);
    currentWorld = outcome.world;
    currentState = outcome.state;
  }
  return true;
}

for (const days of DAYS) {
  // One representative trip per length: the flagship budget for that shape.
  const trip = builtTrips.find((candidate) => candidate.days === days);
  if (trip === undefined) continue;

  console.log("");
  console.log(`${days} day trip on ${formatINR(trip.budget)}`);

  for (const scenario of scenarios) {
    const verdict = assessScenario(trip.world, trip.state, disruptions, scenario, base);
    const actuallyFires = fires(trip.world, trip.state, scenario);

    console.log(
      `    ${verdict.applicable ? "APPLIES     " : "DOES NOT    "}${scenario.id.padEnd(20)}` +
        (verdict.applicable ? "" : verdict.reason),
    );
    check(
      `${days}d / ${scenario.id}: the verdict matches reality`,
      verdict.applicable === actuallyFires,
    );
    check(
      `${days}d / ${scenario.id}: a refusal always gives a reason`,
      verdict.applicable || verdict.reason.length > 0,
    );
  }
}

// The expectations that make the feature worth having, stated outright.
section("5b. THE APPLICABILITY ANSWERS THAT MATTER, ASSERTED OUTRIGHT");

const twoDay = buildTrip(base, 2, 15000);
const oneDay = buildTrip(base, 1, 10000);
const fourDay = buildTrip(base, 4, 34000);

const verdictFor = (trip: typeof twoDay, id: string): boolean =>
  assessScenario(
    trip.world,
    trip.state,
    disruptions,
    scenarios.find((scenario) => scenario.id === id) as Scenario,
    base,
  ).applicable;

check(
  "the flagship 2 day / Rs 15,000 trip supports every scenario",
  scenarios.every((scenario) => verdictFor(twoDay, scenario.id)),
);
check(
  "no-donor-left does not apply to a 1 day trip (it needs Day 2 Morning)",
  !verdictFor(oneDay, "no-donor-left"),
);
check(
  "any-price-shock does not apply to a 1 day trip (no room is booked)",
  !verdictFor(oneDay, "any-price-shock"),
);
check(
  "any-cancelled-plan applies at every length, it targets a slot not an id",
  verdictFor(oneDay, "any-cancelled-plan") &&
    verdictFor(twoDay, "any-cancelled-plan") &&
    verdictFor(fourDay, "any-cancelled-plan"),
);
check(
  "any-price-shock applies to a 4 day trip, where a room is booked",
  verdictFor(fourDay, "any-price-shock"),
);

// A targeted disruption must land on the booking in its own slot, never
// somewhere else. This is the "do not silently retarget" rule, checked.
for (const trip of [oneDay, twoDay, fourDay]) {
  const resolved = resolveDisruption(
    trip.world,
    trip.state,
    getDisruption(disruptions, "g1"),
    base,
  );
  const landedOn = resolved.ok
    ? trip.world.options.find((option) => option.id === resolved.disruption.optionId)
    : undefined;
  check(
    `g1 on a ${trip.world.tripLengthDays} day trip lands on the booked Day 1 Afternoon activity`,
    landedOn !== undefined &&
      landedOn.timeSlot === "Day 1 Afternoon" &&
      landedOn.category === "activity" &&
      trip.state.itinerary.some((item) => item.optionId === landedOn.id),
    landedOn === undefined ? "" : `${landedOn.id} ${landedOn.name}`,
  );
}

// ------------------------------------------- 5c. the headline scenario still bites
section("5c. THE HEADLINE SCENARIO STILL FORCES A REFUSAL ON THE BUILT TRIP");

/*
 * no-donor-left is the scenario the whole demo is pointed at, and it only works
 * if the arithmetic is tight: the one option left for the empty slot must cost
 * more than its category has, and every other category together must be unable
 * to lend the difference. That used to depend on the hand written 4,000 / 5,000
 * / 6,000 split. It now depends on what the split rule computes, so it is
 * checked here rather than assumed.
 */
{
  let world = twoDay.world;
  let state = twoDay.state;

  for (const id of (scenarios.find((s) => s.id === "no-donor-left") as Scenario).disruptionIds) {
    const resolution = resolveDisruption(world, state, getDisruption(disruptions, id), base);
    if (!resolution.ok) throw new Error(`no-donor-left did not resolve: ${resolution.reason}`);
    const outcome = applyDisruption(world, state, resolution.disruption);
    world = outcome.world;
    state = outcome.state;
  }

  const balloon = world.options.find((option) => option.id === "a6");
  const activitySpare = state.budget.byCategory.activity.remaining;
  const shortfall = (balloon?.price ?? 0) - activitySpare;
  const donorPool = CATEGORIES.filter((category) => category !== "activity").reduce(
    (sum, category) => sum + Math.max(0, state.budget.byCategory[category].remaining),
    0,
  );

  console.log("");
  console.log(`  Day 2 Morning is empty, and only the balloon (${formatINR(balloon?.price ?? 0)}) is left for it.`);
  for (const category of CATEGORIES) {
    const ledger = state.budget.byCategory[category];
    console.log(
      `    ${category.padEnd(10)} ${formatINR(ledger.spent).padStart(9)} of ${formatINR(ledger.allocated).padStart(9)}, ` +
        `${formatINR(ledger.remaining).padStart(9)} spare`,
    );
  }
  console.log(
    `  Shortfall ${formatINR(shortfall)}, and every donor emptied gives only ${formatINR(donorPool)}.`,
  );
  console.log("");

  check("the only replacement is short of its category", shortfall > 0, `short by ${formatINR(shortfall)}`);
  check(
    "no reallocation can cover it, so a refusal is forced",
    donorPool < shortfall,
    `${formatINR(donorPool)} against ${formatINR(shortfall)}`,
  );
}

// -------------------------------------------------------------- the verdict
section("RESULT");
console.log(`  ${passed} passed, ${failed} failed.`);
console.log("");
console.log("  No model was called. No network request was made. No API key was read.");
console.log(rule("="));
console.log("");

if (failed > 0) process.exitCode = 1;

// ------------------------------------------------------------------ helpers

function buildThrows(days: number, budget: number): boolean {
  try {
    buildTrip(base, days, budget);
    return false;
  } catch {
    return true;
  }
}

function wrapAt(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}
