/**
 * The one trip the demo server is looking after.
 *
 * The whole point of the UI is to watch one itinerary get damaged and repaired,
 * so there is exactly one session, held in memory.
 *
 * WHAT CHANGED IN PROMPT B1. The session no longer holds "the world file's
 * trip". It holds THE TRAVELLER'S TRIP: a length and a total budget they chose,
 * built by src/world/trip.ts out of the same catalogue. It opens on the default
 * (2 days, Rs 15,000) so the page always has something to draw, and configure()
 * replaces it. Reset goes back to the configured trip, not to the world file's
 * hardcoded one.
 *
 * The pristine pair is kept per configuration, which is why a scenario can be
 * fired over and over in a demo without restarting the process.
 *
 * The same immutability rule as everywhere else: nothing here edits a World or a
 * TripState, it swaps which immutable pair the session is pointing at.
 */

import type { Disruption, TripState, World } from "../data/types.js";
import { assessScenario, resolveDisruption, type ScenarioApplicability } from "../events/applicability.js";
import { applyDisruption, getDisruption, loadDisruptions, type DisruptionOutcome } from "../events/engine.js";
import { loadScenarios, type Scenario } from "../events/scenarios.js";
import { loadWorld } from "../world/loader.js";
import {
  DEFAULT_TRIP_BUDGET,
  DEFAULT_TRIP_DAYS,
  assessTripFeasibility,
  buildTrip,
  type FeasibilityReport,
  type TripPlan,
} from "../world/trip.js";

export class Session {
  /** The full handmade catalogue, every option at every length. Never mutated. */
  private readonly baseWorld: World;

  /** The trip as the traveller configured it, before any disruption. */
  private pristineWorld: World;
  private pristineState: TripState;

  readonly disruptions: Disruption[];
  readonly scenarios: Scenario[];

  world: World;
  state: TripState;
  plan: TripPlan;

  constructor() {
    this.baseWorld = loadWorld();
    // Disruptions and scenarios are validated against the FULL catalogue, so a
    // pinned option id is still checked for existing even when the current trip
    // is too short to carry it. Whether it applies to the current trip is a
    // separate question, answered by applicability().
    this.disruptions = loadDisruptions(this.baseWorld);
    this.scenarios = loadScenarios(this.disruptions);

    const blueprint = buildTrip(this.baseWorld, DEFAULT_TRIP_DAYS, DEFAULT_TRIP_BUDGET);
    this.pristineWorld = blueprint.world;
    this.pristineState = blueprint.state;
    this.world = blueprint.world;
    this.state = blueprint.state;
    this.plan = blueprint.plan;
  }

  /** The catalogue every option is named from, whatever the current trip length. */
  get catalogue(): World {
    return this.baseWorld;
  }

  /** Pure arithmetic, no trip built, no model involved. */
  check(days: number, totalINR: number): FeasibilityReport {
    return assessTripFeasibility(this.baseWorld, days, totalINR);
  }

  /**
   * Build the traveller's trip and make it the one the session defends.
   *
   * Throws if the budget cannot cover the days. Callers are expected to have
   * called check() first and shown its message, so a broken trip never exists.
   */
  configure(days: number, totalINR: number): void {
    const blueprint = buildTrip(this.baseWorld, days, totalINR);
    this.pristineWorld = blueprint.world;
    this.pristineState = blueprint.state;
    this.plan = blueprint.plan;
    this.reset();
  }

  /** Back to the configured trip, with every price and closure undone. */
  reset(): void {
    this.world = this.pristineWorld;
    this.state = this.pristineState;
  }

  /**
   * Fire a scenario's disruptions in order, each applied to the result of the
   * last. Returns what each one did, which is what the trace opens with.
   *
   * Every step is resolved first, so a disruption written against a slot lands
   * on whatever this trip booked there. A scenario that does not apply throws
   * rather than half firing.
   */
  fire(scenario: Scenario): DisruptionOutcome[] {
    const outcomes: DisruptionOutcome[] = [];

    for (const id of scenario.disruptionIds) {
      const resolution = resolveDisruption(
        this.world,
        this.state,
        getDisruption(this.disruptions, id),
        this.baseWorld,
      );
      if (!resolution.ok) {
        throw new Error(
          `Scenario "${scenario.id}" does not apply to this trip: ${resolution.reason}`,
        );
      }

      const outcome = applyDisruption(this.world, this.state, resolution.disruption);
      this.world = outcome.world;
      this.state = outcome.state;
      outcomes.push(outcome);
    }

    return outcomes;
  }

  /** Whether a scenario means anything on the trip as currently configured. */
  applicability(scenario: Scenario): ScenarioApplicability {
    return assessScenario(
      this.pristineWorld,
      this.pristineState,
      this.disruptions,
      scenario,
      this.baseWorld,
    );
  }

  findScenario(id: string): Scenario | undefined {
    return this.scenarios.find((scenario) => scenario.id === id);
  }
}
