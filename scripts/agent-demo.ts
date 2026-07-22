/**
 * npm run agent-demo -- <scenario-id>
 * npm run agent-demo -- --list
 * npm run agent-demo -- --disruptions d1,d4
 *
 * Loads the world, fires a scenario's disruptions, then hands the wreckage to
 * the agent and prints the whole thing: the damage, the agent's reasoning turn
 * by turn, every tool call and result, the final report, and the final budget.
 *
 * The agent is genuinely deciding here. Nothing below tells it what to fix or
 * in what order.
 */

import type { TripState, World } from "../src/data/types.js";
import { activeModelName, hasApiKey, hasGroqApiKey, providerName } from "../src/agent/config.js";
import { explainApiError } from "../src/agent/errors.js";
import { createModel, describeProvider } from "../src/agent/providers.js";
import { runAgent } from "../src/agent/loop.js";
import { createTracePrinter } from "../src/agent/trace.js";
import { applyDisruption, getDisruption, loadDisruptions, type DisruptionOutcome } from "../src/events/engine.js";
import { getScenario, loadScenarios, type Scenario } from "../src/events/scenarios.js";
import { buildInitialTripState, loadWorld } from "../src/world/loader.js";
import { bulletLines, printTripState, rule, spread, wrap } from "../src/world/printer.js";

const DEFAULT_SCENARIO = "transport-squeeze";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const world0 = loadWorld();
  const disruptions = loadDisruptions(world0);
  const scenarios = loadScenarios(disruptions);

  if (argv.includes("--list") || argv.includes("-l")) {
    listScenarios(scenarios);
    return;
  }

  // Either a named scenario, or an ad hoc list of disruption ids.
  const explicitIndex = argv.findIndex((arg) => arg === "--disruptions" || arg === "-d");
  let scenario: Scenario;

  if (explicitIndex !== -1) {
    const raw = argv[explicitIndex + 1];
    if (!raw) throw new Error("--disruptions needs a comma separated list, for example: -d d1,d4");
    const ids = raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
    scenario = {
      id: "ad-hoc",
      title: `Ad hoc: ${ids.join(" then ")}`,
      disruptionIds: ids,
      note: "Disruptions chosen on the command line.",
    };
  } else {
    const requested = argv.find((arg) => !arg.startsWith("-")) ?? DEFAULT_SCENARIO;
    scenario = getScenario(scenarios, requested);
  }

  // Fail before doing any work if the selected provider has no key.
  const provider = providerName();
  if (provider === "groq" && !hasGroqApiKey()) {
    throw new Error(
      [
        "GROQ_API_KEY is not set, so the agent cannot reach the model.",
        "",
        "Fix it in three steps:",
        "  1. Get a free key from https://console.groq.com/keys",
        "  2. Add this line to the .env file in the project root:",
        "       GROQ_API_KEY=your_key_here",
        "  3. Run the command again.",
        "",
        ".env is already gitignored, so the key will not be committed.",
        "",
        "To use Gemini instead, set MODEL_PROVIDER=gemini in .env.",
      ].join("\n"),
    );
  }
  if (provider === "gemini" && !hasApiKey()) {
    throw new Error(
      [
        "GEMINI_API_KEY is not set, so the agent cannot reach the model.",
        "",
        "Fix it in three steps:",
        "  1. Get a key from https://aistudio.google.com/apikey",
        "  2. Add this line to the .env file in the project root:",
        "       GEMINI_API_KEY=your_key_here",
        "  3. Run the command again.",
        "",
        ".env is already gitignored, so the key will not be committed.",
        "",
        "To use Groq instead, set MODEL_PROVIDER=groq in .env.",
      ].join("\n"),
    );
  }

  // ------------------------------------------------------------ the setup
  console.log("");
  console.log(rule("="));
  console.log(`SCENARIO: ${scenario.title}`);
  console.log(spread(`  id: ${scenario.id}`, describeProvider(provider)));
  console.log(rule("="));
  for (const line of wrap(scenario.note, 74, "  ")) console.log(line);
  console.log("");

  console.log("THE TRIP BEFORE ANYTHING GOES WRONG");
  console.log("");
  let world: World = world0;
  let state: TripState = buildInitialTripState(world);
  printTripState(state, world);

  // ------------------------------------------------------- fire the damage
  console.log("");
  console.log(rule("="));
  console.log("DISRUPTIONS FIRING");
  console.log(rule("="));

  const outcomes: DisruptionOutcome[] = [];
  for (const id of scenario.disruptionIds) {
    const outcome = applyDisruption(world, state, getDisruption(disruptions, id));
    world = outcome.world;
    state = outcome.state;
    outcomes.push(outcome);

    console.log("");
    console.log(`[${outcome.disruption.id}] ${outcome.disruption.kind}`);
    for (const line of wrap(`"${outcome.disruption.message}"`, 74, "  ")) console.log(line);
    for (const change of outcome.changes) {
      for (const line of bulletLines(change, "- ", "    ")) console.log(line);
    }
  }

  console.log("");
  console.log("THE TRIP THE AGENT INHERITS");
  console.log("");
  printTripState(state, world);
  console.log("");

  // -------------------------------------------------------- run the agent
  const run = await runAgent({
    model: createModel(provider, {
      // Free tier token ceilings are hit often, so say we are waiting rather
      // than letting the demo look frozen.
      onRateLimit: (waitMs, attempt) => {
        console.log(
          `(rate limited, waiting ${(waitMs / 1000).toFixed(1)}s and retrying, attempt ${attempt})`,
        );
      },
    }),
    world,
    state,
    outcomes,
    observer: createTracePrinter(),
  });

  // ------------------------------------------------------------ the result
  if (run.notification !== null) {
    console.log("");
    console.log(run.notification);
  }

  console.log("");
  console.log("THE TRIP THE AGENT HANDS BACK");
  console.log("");
  printTripState(run.finalState, world);
  console.log("");
}

function listScenarios(scenarios: Scenario[]): void {
  console.log("");
  console.log(rule("="));
  console.log("AVAILABLE SCENARIOS");
  console.log(rule("="));
  for (const scenario of scenarios) {
    console.log("");
    console.log(spread(`  ${scenario.id}`, scenario.disruptionIds.join(", ")));
    console.log(`    ${scenario.title}`);
    for (const line of wrap(scenario.note, 74, "      ")) console.log(line);
  }
  console.log("");
  console.log("  Run one with:  npm run agent-demo -- <id>");
  console.log("");
}

main().catch((error: unknown) => {
  console.error("\nThe agent demo failed.\n");
  // Quota and permission failures get a plain explanation and a fix, rather
  // than a wall of JSON in the middle of a demo.
  const explained = explainApiError(error, activeModelName());
  console.error(explained ?? (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
