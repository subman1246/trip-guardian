/**
 * The demo server.
 *
 * Plain node:http, no framework, no new dependencies. It does three things:
 * serve the static page, list the scenarios, and stream one agent run to the
 * browser over Server Sent Events.
 *
 * WHERE THE KEY LIVES. The agent runs here, in this process. The API key is read
 * from the environment by src/agent/config.ts, is used to build the model client,
 * and is never put into a response, a stream event, or a served file. The browser
 * talks only to this server and never to Groq or Gemini. The page it is sent has
 * no key in it and no way to obtain one.
 *
 * WHY SSE. The agent already reports through AgentObserver, which is a stream of
 * one way events with no request from the browser in between. That is exactly
 * what SSE is, and it costs no dependency and no protocol upgrade.
 *
 * PACING. Observer hooks are synchronous, so they cannot wait. They push onto a
 * queue and a separate pump drains it with a small gap between events, so a
 * viewer can read a turn before the next one lands.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { activeModelName, hasApiKey, hasGroqApiKey, providerName } from "../agent/config.js";
import { explainApiError } from "../agent/errors.js";
import { runAgent, type AgentObserver } from "../agent/loop.js";
import { createModel } from "../agent/providers.js";
import { MAX_TRIP_DAYS, MIN_TRIP_DAYS, isSupportedTripLength } from "../world/slots.js";
import { Session } from "./session.js";
import { toDisruptionView, toSetupView, toTripView } from "./views.js";

/** Where the static page lives. */
const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));

/** How long to hold each kind of event on screen before sending the next. */
const PACING_MS: Record<string, number> = {
  disruption: 1100,
  turn: 600,
  reasoning: 700,
  tool_call: 550,
  tool_result: 800,
  notice: 300,
  notification: 500,
};
const DEFAULT_PACING_MS = 200;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const session = new Session();

/** Only one run at a time, so two viewers cannot fight over one itinerary. */
let running = false;

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/api/scenarios") {
    // The provider name and model id are safe to show. The key is not sent, and
    // is not reachable from anything below.
    //
    // Applicability is computed here, against the trip as currently configured,
    // so the page can grey out the buttons that would be meaningless instead of
    // letting a viewer fire one and watch nothing happen.
    const provider = providerName();
    sendJson(response, 200, {
      provider,
      model: activeModelName(provider),
      scenarios: session.scenarios.map((scenario) => {
        const applicability = session.applicability(scenario);
        return {
          id: scenario.id,
          title: scenario.title,
          note: scenario.note,
          disruptionIds: scenario.disruptionIds,
          applicable: applicability.applicable,
          reason: applicability.reason,
        };
      }),
    });
    return;
  }

  if (path === "/api/trip") {
    sendJson(response, 200, tripPayload());
    return;
  }

  if (path === "/api/setup") {
    if (running) {
      sendJson(response, 409, { error: "A run is in progress, wait for it to finish." });
      return;
    }
    await handleSetup(request, url, response);
    return;
  }

  if (path === "/api/reset") {
    if (running) {
      sendJson(response, 409, { error: "A run is in progress, wait for it to finish." });
      return;
    }
    // Back to the trip the traveller configured, not to any hardcoded one.
    session.reset();
    sendJson(response, 200, tripPayload());
    return;
  }

  if (path === "/api/run") {
    await streamRun(url.searchParams.get("scenario") ?? "", response);
    return;
  }

  await serveStatic(path, response);
}

// ---------------------------------------------------------------- the setup

/** The trip plus how it was constructed, which is what the page draws. */
function tripPayload(): Record<string, unknown> {
  return { ...toTripView(session.world, session.state), setup: toSetupView(session.plan) };
}

/**
 * TASKS 2 AND 3: take a length and a budget, and either build that trip or
 * explain why it cannot be built.
 *
 * The feasibility answer is pure arithmetic over the local catalogue. No model
 * is contacted, and nothing is constructed until it is known to work, so a
 * broken trip never exists even briefly.
 */
async function handleSetup(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const days = Number(body.days ?? url.searchParams.get("days"));
  const budget = Number(body.budget ?? url.searchParams.get("budget"));

  if (!isSupportedTripLength(days)) {
    sendJson(response, 400, {
      error: `Pick a whole number of days between ${MIN_TRIP_DAYS} and ${MAX_TRIP_DAYS}. Trips are capped at ${MAX_TRIP_DAYS} days.`,
    });
    return;
  }
  if (!Number.isInteger(budget) || budget <= 0) {
    sendJson(response, 400, { error: "The budget must be a whole number of rupees above zero." });
    return;
  }

  const feasibility = session.check(days, budget);
  if (!feasibility.ok) {
    // 422: the request was understood and is simply not affordable. The page
    // shows the message and the minimum, and nothing is rebuilt.
    sendJson(response, 422, {
      error: feasibility.message,
      days: feasibility.days,
      totalINR: feasibility.totalINR,
      cheapestPlanINR: feasibility.cheapestPlanINR,
      minimumINR: feasibility.minimumINR,
    });
    return;
  }

  session.configure(days, budget);
  sendJson(response, 200, tripPayload());
}

/** Read a JSON body if there is one. An empty or unparseable body is just {}. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ the run

async function streamRun(scenarioId: string, response: ServerResponse): Promise<void> {
  const scenario = session.findScenario(scenarioId);
  if (scenario === undefined) {
    sendJson(response, 404, { error: `Unknown scenario "${scenarioId}".` });
    return;
  }

  // The page greys these out, but a scenario that does not apply to the current
  // trip must be refused here too, so a stale page cannot half fire one.
  const applicability = session.applicability(scenario);
  if (!applicability.applicable) {
    sendJson(response, 409, {
      error: `"${scenario.title}" does not apply to this trip. ${applicability.reason}`,
    });
    return;
  }

  if (running) {
    sendJson(response, 409, { error: "A run is already in progress." });
    return;
  }
  running = true;

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Tells any proxy in front of us not to buffer, which would kill the pacing.
    "X-Accel-Buffering": "no",
  });

  const queue: Array<{ type: string; data: unknown }> = [];
  let producing = true;
  let open = true;

  response.on("close", () => {
    open = false;
  });

  const emit = (type: string, data: unknown): void => {
    queue.push({ type, data });
  };

  // The pump. Drains the queue at a readable pace, independent of how fast the
  // model produces turns.
  const pump = (async () => {
    while (open && (producing || queue.length > 0)) {
      const next = queue.shift();
      if (next === undefined) {
        await sleep(40);
        continue;
      }
      response.write(`event: ${next.type}\ndata: ${JSON.stringify(next.data)}\n\n`);
      await sleep(PACING_MS[next.type] ?? DEFAULT_PACING_MS);
    }
  })();

  try {
    // Every run starts from the trip as booked, so a scenario behaves the same
    // on the tenth demo as on the first.
    session.reset();
    emit("reset", tripPayload());
    emit("scenario", { id: scenario.id, title: scenario.title, note: scenario.note });

    const provider = providerName();
    const missingKey =
      (provider === "groq" && !hasGroqApiKey()) || (provider === "gemini" && !hasApiKey());
    if (missingKey) {
      const variable = provider === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY";
      throw new Error(
        `${variable} is not set on the server, so the agent cannot reach the model. Add it to .env in the project root and restart.`,
      );
    }

    // ------------------------------------------------------ fire the damage
    // The trip view is taken against the world as it stands after each event, so
    // a price spike shows the new price the moment it lands.
    const outcomes = session.fire(scenario);
    for (const outcome of outcomes) {
      emit("disruption", {
        ...toDisruptionView(outcome),
        trip: toTripView(outcome.world, outcome.state),
      });
    }

    // ------------------------------------------------------- run the agent
    const world = session.world;
    const observer: AgentObserver = {
      onStart: (info) => emit("agent_start", { model: info.modelName, maxTurns: info.maxTurns }),
      onTurnStart: (index) => emit("turn", { index }),
      onReasoning: (index, text) => emit("reasoning", { index, text }),
      onToolCall: (name, args) => emit("tool_call", { name, args }),
      onToolResult: (call) =>
        emit("tool_result", {
          name: call.name,
          ok: call.outcome.ok,
          reason: call.outcome.reason ?? null,
          shortfall: call.outcome.shortfall ?? null,
          summary: call.outcome.summary,
          changedState: call.outcome.changedState,
          trip: toTripView(world, call.outcome.state),
        }),
      onNudge: (index, reason) =>
        emit("notice", {
          text: `Sent back on turn ${index}: ${reason ?? "reminding the agent to finish"}`,
        }),
      onFinish: (run) => {
        if (run.notification !== null) emit("notification", { message: run.notification });
        emit("done", {
          stopped: run.stopped,
          turns: run.turns.length,
          toolCalls: run.toolCallCount,
          rejections: run.rejectionCount,
          unresolved: run.unresolved,
          trip: toTripView(world, run.finalState),
        });
      },
    };

    const run = await runAgent({
      model: createModel(provider, {
        onRateLimit: (waitMs, attempt) =>
          emit("notice", {
            text: `Rate limited by the provider, waiting ${(waitMs / 1000).toFixed(1)}s and retrying (attempt ${attempt}).`,
          }),
      }),
      world,
      state: session.state,
      outcomes,
      observer,
    });

    session.state = run.finalState;
  } catch (error: unknown) {
    const explained = explainApiError(error, activeModelName());
    emit("failed", {
      message: explained ?? (error instanceof Error ? error.message : String(error)),
    });
  } finally {
    producing = false;
    await pump;
    running = false;
    if (open) response.end();
  }
}

// --------------------------------------------------------------- the static page

async function serveStatic(path: string, response: ServerResponse): Promise<void> {
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");

  // Refuse anything that climbs out of web/, so the server cannot be talked into
  // serving .env or any other file on the machine.
  const resolved = normalize(join(WEB_ROOT, relative));
  if (!resolved.startsWith(normalize(WEB_ROOT + sep))) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }

  try {
    const body = await readFile(resolved);
    response.writeHead(200, {
      "Content-Type": MIME[extname(resolved)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startServer(port: number): void {
  server.listen(port, () => {
    const provider = providerName();
    console.log("");
    console.log("Trip Guardian demo UI");
    console.log(`  http://localhost:${port}`);
    console.log(`  model: ${provider} / ${activeModelName(provider)}`);
    console.log(`  scenarios: ${session.scenarios.map((scenario) => scenario.id).join(", ")}`);
    console.log("");
    console.log("The agent runs in this process. The API key never leaves it.");
    console.log("");
  });
}
