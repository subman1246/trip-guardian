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
import { Session } from "./session.js";
import { toDisruptionView, toTripView } from "./views.js";

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
    const provider = providerName();
    sendJson(response, 200, {
      provider,
      model: activeModelName(provider),
      scenarios: session.scenarios.map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        note: scenario.note,
        disruptionIds: scenario.disruptionIds,
      })),
    });
    return;
  }

  if (path === "/api/trip") {
    sendJson(response, 200, toTripView(session.world, session.state));
    return;
  }

  if (path === "/api/reset") {
    if (running) {
      sendJson(response, 409, { error: "A run is in progress, wait for it to finish." });
      return;
    }
    session.reset();
    sendJson(response, 200, toTripView(session.world, session.state));
    return;
  }

  if (path === "/api/run") {
    await streamRun(url.searchParams.get("scenario") ?? "", response);
    return;
  }

  await serveStatic(path, response);
}

// ------------------------------------------------------------------ the run

async function streamRun(scenarioId: string, response: ServerResponse): Promise<void> {
  const scenario = session.findScenario(scenarioId);
  if (scenario === undefined) {
    sendJson(response, 404, { error: `Unknown scenario "${scenarioId}".` });
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
    emit("reset", toTripView(session.world, session.state));
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
      onNudge: (index) =>
        emit("notice", { text: `No tool calls on turn ${index}, reminding the agent to finish.` }),
      onFinish: (run) => {
        if (run.notification !== null) emit("notification", { message: run.notification });
        emit("done", {
          stopped: run.stopped,
          turns: run.turns.length,
          toolCalls: run.toolCallCount,
          rejections: run.rejectionCount,
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
