/**
 * npm run world
 *
 * Loads the mock Jaipur world, builds the traveller's starting TripState, and
 * prints it. This is the verification script for the world layer: if this looks
 * right, the agent built in later prompts has a sane place to stand.
 *
 * No network, no LLM, no API keys. Everything here reads one local JSON file.
 */

import { buildInitialTripState, loadWorld } from "../src/world/loader.js";
import { formatCatalogue, printTripState } from "../src/world/printer.js";

function main(): void {
  const world = loadWorld();
  const state = buildInitialTripState(world);

  console.log("");
  printTripState(state, world);
  console.log("");
  console.log(formatCatalogue(world, state));
  console.log("");
}

try {
  main();
} catch (error) {
  // A bad world file should fail loudly and readably, not with a stack trace.
  console.error("\nCould not load the world.\n");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
