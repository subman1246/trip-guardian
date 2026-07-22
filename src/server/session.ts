/**
 * The one trip the demo server is looking after.
 *
 * The whole point of the UI is to watch one itinerary get damaged and repaired,
 * so there is exactly one session, held in memory. Reset rebuilds it from the
 * world file, which is why a scenario can be fired over and over in a demo
 * without restarting the process.
 *
 * The same immutability rule as everywhere else: nothing here edits a World or a
 * TripState, it swaps which immutable pair the session is pointing at.
 */

import type { Disruption, TripState, World } from "../data/types.js";
import { applyDisruption, getDisruption, loadDisruptions, type DisruptionOutcome } from "../events/engine.js";
import { loadScenarios, type Scenario } from "../events/scenarios.js";
import { buildInitialTripState, loadWorld } from "../world/loader.js";

export class Session {
  /** The pristine catalogue, reloaded on every reset. */
  private readonly pristineWorld: World;
  readonly disruptions: Disruption[];
  readonly scenarios: Scenario[];

  world: World;
  state: TripState;

  constructor() {
    this.pristineWorld = loadWorld();
    this.disruptions = loadDisruptions(this.pristineWorld);
    this.scenarios = loadScenarios(this.disruptions);
    this.world = this.pristineWorld;
    this.state = buildInitialTripState(this.pristineWorld);
  }

  /** Back to the trip as booked, with every price and closure undone. */
  reset(): void {
    this.world = this.pristineWorld;
    this.state = buildInitialTripState(this.pristineWorld);
  }

  /**
   * Fire a scenario's disruptions in order, each applied to the result of the
   * last. Returns what each one did, which is what the trace opens with.
   */
  fire(scenario: Scenario): DisruptionOutcome[] {
    const outcomes: DisruptionOutcome[] = [];

    for (const id of scenario.disruptionIds) {
      const outcome = applyDisruption(this.world, this.state, getDisruption(this.disruptions, id));
      this.world = outcome.world;
      this.state = outcome.state;
      outcomes.push(outcome);
    }

    return outcomes;
  }

  findScenario(id: string): Scenario | undefined {
    return this.scenarios.find((scenario) => scenario.id === id);
  }
}
