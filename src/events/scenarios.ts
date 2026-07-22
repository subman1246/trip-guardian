/**
 * Named scenarios: an ordered list of disruptions to fire before the agent runs.
 *
 * Keeping these in config means a new demo case is a JSON edit, not a code
 * change, and the demo script can point at any of them by id.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Disruption } from "../data/types.js";

const SCENARIOS_JSON_PATH = fileURLToPath(new URL("../data/scenarios.json", import.meta.url));

export interface Scenario {
  id: string;
  title: string;
  /** Fired in this order, each one applied to the result of the last. */
  disruptionIds: string[];
  /** What this scenario is meant to prove. Printed at the start of a run. */
  note: string;
}

/** Read the scenarios and check every disruption they name actually exists. */
export function loadScenarios(
  disruptions: Disruption[],
  path: string = SCENARIOS_JSON_PATH,
): Scenario[] {
  const scenarios = JSON.parse(readFileSync(path, "utf8")) as Scenario[];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) problems.push(`duplicate scenario id "${scenario.id}".`);
    seen.add(scenario.id);

    if (scenario.disruptionIds.length === 0) {
      problems.push(`scenario "${scenario.id}" fires no disruptions.`);
    }
    for (const id of scenario.disruptionIds) {
      if (!disruptions.some((disruption) => disruption.id === id)) {
        problems.push(`scenario "${scenario.id}" names unknown disruption "${id}".`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid scenario data:\n  - ${problems.join("\n  - ")}`);
  }

  return scenarios;
}

export function getScenario(scenarios: Scenario[], id: string): Scenario {
  const found = scenarios.find((scenario) => scenario.id === id);
  if (!found) {
    const known = scenarios.map((scenario) => scenario.id).join(", ");
    throw new Error(`Unknown scenario "${id}". Known scenarios: ${known}.`);
  }
  return found;
}
