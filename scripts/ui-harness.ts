/**
 * npm run ui-harness
 *
 * An OFFLINE harness for driving the UI end to end with no model, no network and
 * no API key. It exists so the page can be built and checked while the provider
 * quota is exhausted.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING ANYTHING IT PRINTS.
 *
 * The reasoning text this emits is NOT model output. It is fixed narration I
 * wrote, whose only job is to put text of a realistic length into the trace so
 * the layout, the streaming rhythm and the thinking state can be checked. It is
 * not a record of any agent run and must never be presented as one. The harness
 * reports itself as "offline stub" in the provider chip precisely so a
 * screenshot taken against it is self labelling.
 *
 * What IS real here: every tool call goes through the actual prompt 2 tools, so
 * every ACCEPTED and every REJECTED verdict, every shortfall, every summary
 * string and every resulting trip view is genuinely computed. The disruptions
 * are the real engine. The trip, the budget and the scenario applicability come
 * from the real Session. Only the prose between the calls is canned.
 * ---------------------------------------------------------------------------
 *
 * It never touches src/server/server.ts, so the production server and the SSE
 * event contract stay exactly as they were. It speaks the same event names, in
 * the same order, with the same payload shapes and the same pacing, because the
 * whole point is to exercise the real page.
 */

import type { Content, Part } from "@google/genai";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentModel, ModelToolCall, ModelTurn } from "../src/agent/model.js";
import { runChatTurn } from "../src/agent/chatLoop.js";
import { CATEGORIES, type Category, type Option, type TripState, type World } from "../src/data/types.js";
import { Session } from "../src/server/session.js";
import { toDisruptionView, toSetupView, toTripView } from "../src/server/views.js";
import type { Scenario } from "../src/events/scenarios.js";
import {
  notifyUser,
  reallocateBudget,
  rebookSlot,
  searchAlternatives,
} from "../src/tools/index.js";
import { optionsForSlot } from "../src/world/loader.js";
import { formatINR } from "../src/world/money.js";
import { daySlotsForTripLength } from "../src/world/slots.js";
import { isAvailable } from "../src/world/state.js";
import { isSupportedTripLength, MAX_TRIP_DAYS, MIN_TRIP_DAYS } from "../src/world/slots.js";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

/** The production pacing, copied so the streaming rhythm is the one being shipped. */
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
let running = false;

// ------------------------------------------------------------------ routing

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/api/scenarios") {
    sendJson(response, 200, {
      // Named so any screenshot taken against the harness says so on its face.
      provider: "offline stub",
      model: "no model called",
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
    session.reset();
    sendJson(response, 200, tripPayload());
    return;
  }

  if (path === "/api/run") {
    await streamScriptedRun(
      url.searchParams.get("scenario") ?? "",
      url.searchParams.get("discrepancy") === "1",
      response,
    );
    return;
  }

  if (path === "/api/chat") {
    await streamScriptedChat(url.searchParams.get("message") ?? "", response);
    return;
  }

  await serveStatic(path, response);
}

function tripPayload(): Record<string, unknown> {
  return { ...toTripView(session.world, session.state), setup: toSetupView(session.plan) };
}

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

// ------------------------------------------------------------ the scripted run

/**
 * Fire the real disruptions, then walk a fixed repair script through the REAL
 * tools, emitting the production event sequence at the production pacing.
 *
 * The script is written to reach every state the page has to draw:
 *   - a day slot going empty, and being filled again
 *   - a category going over its allocation, and being brought back
 *   - a rebooking that the tools genuinely REFUSE, with a real shortfall
 *   - a reallocation that moves two bars at once
 *   - the final report card
 *   - optionally, the discrepancy warning
 */
async function streamScriptedRun(
  scenarioId: string,
  forceDiscrepancy: boolean,
  response: ServerResponse,
): Promise<void> {
  const scenario = session.findScenario(scenarioId);
  if (scenario === undefined) {
    sendJson(response, 404, { error: `Unknown scenario "${scenarioId}".` });
    return;
  }
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
    "X-Accel-Buffering": "no",
  });

  let open = true;
  response.on("close", () => {
    open = false;
  });

  const emit = async (type: string, data: unknown): Promise<void> => {
    if (!open) return;
    response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    await sleep(PACING_MS[type] ?? DEFAULT_PACING_MS);
  };

  try {
    await runScript(scenario, forceDiscrepancy, emit, () => open);
  } catch (error: unknown) {
    await emit("failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
    if (open) response.end();
  }
}

async function runScript(
  scenario: Scenario,
  forceDiscrepancy: boolean,
  emit: (type: string, data: unknown) => Promise<void>,
  isOpen: () => boolean,
): Promise<void> {
  session.reset();
  await emit("reset", tripPayload());
  await emit("scenario", { id: scenario.id, title: scenario.title, note: scenario.note });

  // Real engine, real disruptions.
  const outcomes = session.fire(scenario);
  for (const outcome of outcomes) {
    await emit("disruption", {
      ...toDisruptionView(outcome),
      trip: toTripView(outcome.world, outcome.state),
    });
  }

  const world: World = session.world;
  let state: TripState = session.state;
  let turn = 0;
  let toolCalls = 0;
  let rejections = 0;

  await emit("agent_start", { model: "offline stub, no model called", maxTurns: 8 });

  /** Open a turn. The page shows a thinking state until the reasoning lands. */
  const think = async (text: string): Promise<void> => {
    turn += 1;
    await emit("turn", { index: turn });
    await emit("reasoning", { index: turn, text });
  };

  /** Run a real tool, emit the real call and the real verdict. */
  const call = async (
    name: string,
    args: Record<string, unknown>,
    run: () => { ok: boolean; reason?: string; shortfall?: number; summary: string; state: TripState; changedState?: boolean },
  ): Promise<{ ok: boolean; shortfall: number | undefined }> => {
    toolCalls += 1;
    await emit("tool_call", { name, args });

    const result = run();
    if (!result.ok) rejections += 1;
    state = result.state;

    await emit("tool_result", {
      name,
      ok: result.ok,
      reason: result.reason ?? null,
      shortfall: result.shortfall ?? null,
      summary: result.summary,
      changedState: result.changedState ?? false,
      trip: toTripView(world, state),
    });
    return { ok: result.ok, shortfall: result.shortfall };
  };

  const daySlots = daySlotsForTripLength(state.tripLengthDays);
  const emptyDaySlots = (): string[] => {
    const filled = new Set(state.itinerary.map((item) => item.timeSlot));
    return daySlots.filter((slot) => !filled.has(slot));
  };
  const overCategories = (): Category[] =>
    CATEGORIES.filter((category) => state.budget.byCategory[category].remaining < 0);
  const bookedIn = (category: Category): Option[] =>
    state.itinerary
      .map((item) => world.options.find((option) => option.id === item.optionId))
      .filter((option): option is Option => option !== undefined && option.category === category);

  const actions: string[] = [];
  /** Anything the script deliberately swapped away from, so it cannot buy it
      straight back on the upgrade step and undo its own repair. */
  const soldOff = new Set<string>();

  // ---------------------------------------------------------------- survey
  const gaps = emptyDaySlots();
  const over = overCategories();
  await think(
    `Taking stock before touching anything. ${
      gaps.length > 0 ? `${gaps.join(" and ")} ${gaps.length === 1 ? "is" : "are"} empty. ` : ""
    }${
      over.length > 0
        ? `${over.join(" and ")} ${over.length === 1 ? "is" : "are"} over ${
            over.length === 1 ? "its" : "their"
          } allocation. `
        : ""
    }I want the whole picture before I spend anything, because a single event can break more than one thing at once.`,
  );

  for (const slot of gaps) {
    if (!isOpen()) return;
    await call("search_alternatives", { timeSlot: slot }, () =>
      searchAlternatives(world, state, { timeSlot: slot as never }),
    );
  }

  // --------------------------------------------------------- fill the gaps
  for (const slot of gaps) {
    if (!isOpen()) return;
    const candidates = optionsForSlot(world, slot).filter(
      (option) => isAvailable(option) && !state.itinerary.some((item) => item.optionId === option.id),
    );
    const pick = candidates[0];
    if (pick === undefined) {
      await think(
        `Nothing is left open for ${slot}. That slot stays empty, and I will say so plainly rather than invent a booking.`,
      );
      continue;
    }

    await think(
      `${slot} needs filling. ${pick.name} is the cheapest thing still open there at ${formatINR(pick.price)}, and it keeps the shape of the day. Booking it.`,
    );
    const outcome = await call("rebook_slot", { oldOptionId: null, newOptionId: pick.id }, () =>
      rebookSlot(world, state, null, pick.id),
    );
    if (outcome.ok) actions.push(`Booked ${pick.name} for ${slot}, ${formatINR(pick.price)}.`);
  }

  // ------------------------------------------------- bring overspends back
  for (const category of overCategories()) {
    if (!isOpen()) return;
    const ledger = state.budget.byCategory[category];
    await think(
      `${category} is ${formatINR(-ledger.remaining)} over its allocation of ${formatINR(ledger.allocated)}. Cutting spend inside the category is always legal, so I will look there first rather than reach for another category's money.`,
    );

    await call("search_alternatives", { category }, () =>
      searchAlternatives(world, state, { category }),
    );

    // The cheapest legal swap available to this category, from anything it holds.
    let best: { from: Option; to: Option } | null = null;
    for (const current of bookedIn(category)) {
      for (const option of optionsForSlot(world, current.timeSlot)) {
        if (option.category !== category || option.id === current.id || !isAvailable(option)) continue;
        if (option.price >= current.price) continue;
        if (best === null || option.price - current.price < best.to.price - best.from.price) {
          best = { from: current, to: option };
        }
      }
    }

    if (best === null) continue;
    const swap = best;
    const saved = swap.from.price - swap.to.price;
    await think(
      `Swapping ${swap.from.name} down to ${swap.to.name} frees ${formatINR(saved)} inside ${category}, which is real allocation rather than borrowed allocation. That is the move.`,
    );
    const outcome = await call(
      "rebook_slot",
      { oldOptionId: swap.from.id, newOptionId: swap.to.id },
      () => rebookSlot(world, state, swap.from.id, swap.to.id),
    );
    if (outcome.ok) {
      soldOff.add(swap.from.id);
      actions.push(
        `Replaced ${swap.from.name} with ${swap.to.name}, saving ${formatINR(saved)}.`,
      );
    }
  }

  // ------------------------------------------------- a deliberate stretch
  //
  // The reject and adapt path is the most interesting thing the tools do, so the
  // script always attempts one upgrade it probably cannot afford. The refusal
  // that comes back is a genuine tool refusal with a genuine shortfall.
  const stretch = findStretch(world, state, soldOff);
  if (stretch !== null && isOpen()) {
    await think(
      `There is room to make this better rather than merely correct. ${stretch.to.name} is the best thing open for ${stretch.to.timeSlot} at ${formatINR(stretch.to.price)}. I do not think ${stretch.to.category} can cover it yet, but the tool will tell me exactly how short I am, and that number is worth having.`,
    );
    const attempt = await call(
      "rebook_slot",
      { oldOptionId: stretch.from.id, newOptionId: stretch.to.id },
      () => rebookSlot(world, state, stretch.from.id, stretch.to.id),
    );

    if (!attempt.ok && typeof attempt.shortfall === "number") {
      const shortfall = attempt.shortfall;
      const donor = richestDonor(state, stretch.to.category, shortfall);

      if (donor === null) {
        await think(
          `Refused, and short by ${formatINR(shortfall)}. No category has that much unspent, so this upgrade is not available at this budget. I am leaving the trip as it stands rather than breaking it to buy a nicer room.`,
        );
      } else {
        await think(
          `Refused, and short by exactly ${formatINR(shortfall)}. ${donor} is holding ${formatINR(state.budget.byCategory[donor].remaining)} it has not committed, which is enough. Moving the allocation across, then trying the same booking again.`,
        );
        const moved = await call(
          "reallocate_budget",
          { from: donor, to: stretch.to.category, amount: shortfall },
          () => reallocateBudget(world, state, donor, stretch.to.category, shortfall),
        );

        if (moved.ok) {
          actions.push(
            `Moved ${formatINR(shortfall)} of allocation from ${donor} to ${stretch.to.category}.`,
          );
          const retry = await call(
            "rebook_slot",
            { oldOptionId: stretch.from.id, newOptionId: stretch.to.id },
            () => rebookSlot(world, state, stretch.from.id, stretch.to.id),
          );
          if (retry.ok) {
            actions.push(`Upgraded to ${stretch.to.name}, ${formatINR(stretch.to.price)}.`);
          }
        }
      }
    } else if (attempt.ok) {
      actions.push(`Upgraded to ${stretch.to.name}, ${formatINR(stretch.to.price)}.`);
    }
  }

  if (!isOpen()) return;

  // ------------------------------------------------------------ the report
  const stillEmpty = emptyDaySlots();
  const stillOver = overCategories();

  await think(
    `That is everything I can see. ${
      stillEmpty.length === 0 ? "Every day slot is filled" : `${stillEmpty.join(" and ")} could not be filled`
    }, and ${
      stillOver.length === 0 ? "every category is inside its allocation" : `${stillOver.join(" and ")} is still over`
    }. Writing it up for the traveller now, including what they lost, not only what I saved.`,
  );

  toolCalls += 1;
  const report = notifyUser(world, state, {
    headline:
      stillOver.length === 0
        ? "Your Jaipur trip took a hit and it is handled. You are still inside your budget."
        : "Your Jaipur trip took a hit and I could not fully absorb it. Here is exactly where it stands.",
    whatHappened: outcomes.map((outcome) => outcome.disruption.message).join(" "),
    reasoning:
      "I cut spend inside a category before borrowing from another one, because a swap you can afford is always safer than a transfer you have to justify. Where a slot had nothing open left, I left it empty rather than book something that does not exist.",
    actions:
      actions.length > 0
        ? actions
        : ["Nothing needed changing, the plan absorbed the disruption as it stood."],
    tradeoff:
      stillEmpty.length === 0
        ? "You lose some of the comfort of the original plan. In exchange the trip is still full and the budget still holds."
        : `You lose ${stillEmpty.join(" and ")} entirely, because everything for that slot is closed. The money it freed is still yours.`,
  });
  // notify_user is read only and cannot fail, but the result is still a union,
  // so it is narrowed rather than asserted.
  if (!report.ok) throw new Error(`notify_user was refused: ${report.reason}`);

  await emit("tool_call", { name: "notify_user", args: { headline: report.details.input.headline } });
  await emit("tool_result", {
    name: "notify_user",
    ok: true,
    reason: null,
    shortfall: null,
    summary: report.summary,
    changedState: false,
    trip: toTripView(world, state),
  });
  await emit("notification", { message: report.details.message });

  // -------------------------------------------------------------- the end
  const unresolved = stillEmpty.map(
    (slot) => `${slot} is empty in the trip handed back.`,
  );
  if (forceDiscrepancy) {
    // Injected on request, so the discrepancy warning can be checked without
    // waiting for an agent to actually misreport. Labelled as what it is.
    unresolved.push(
      "HARNESS INJECTED: the report claims a booking for Day 1 Evening that the itinerary does not contain.",
    );
  }

  await emit("done", {
    stopped: "reported",
    turns: turn,
    toolCalls,
    rejections,
    unresolved,
    trip: toTripView(world, state),
  });
}

/**
 * The best upgrade worth attempting: the priciest open option in a booked slot,
 * skipping anything the script already downgraded away from, so it cannot spend
 * the run undoing its own repair.
 */
function findStretch(
  world: World,
  state: TripState,
  soldOff: Set<string>,
): { from: Option; to: Option } | null {
  let best: { from: Option; to: Option } | null = null;

  for (const item of state.itinerary) {
    const current = world.options.find((option) => option.id === item.optionId);
    if (current === undefined) continue;

    for (const option of world.options) {
      if (
        option.timeSlot !== current.timeSlot ||
        option.category !== current.category ||
        option.id === current.id ||
        !isAvailable(option) ||
        soldOff.has(option.id) ||
        option.price <= current.price
      ) {
        continue;
      }
      if (best === null || option.price - current.price > best.to.price - best.from.price) {
        best = { from: current, to: option };
      }
    }
  }

  return best;
}

/** The category with the most unspent allocation that could cover the shortfall. */
function richestDonor(state: TripState, to: Category, amount: number): Category | null {
  let best: Category | null = null;
  for (const category of CATEGORIES) {
    if (category === to) continue;
    const spare = state.budget.byCategory[category].remaining;
    if (spare < amount) continue;
    if (best === null || spare > state.budget.byCategory[best].remaining) best = category;
  }
  return best;
}

// -------------------------------------------------------------- the scripted chat

/**
 * The offline stand in for chat: same rules as the scripted scenario runner
 * above. NOT model output, but every tool call it makes goes through the exact
 * SAME runChatTurn and executeChatToolCall the real server uses, so every
 * ACCEPTED, every REJECTED and every world mutation (including apply_disruption
 * actually closing a venue or repricing an option) is genuinely computed. Only
 * the DECISION of what to try, normally the model's job, is scripted here by
 * matching a few keywords, so the whole chat plumbing (bounded history, the
 * SSE events, the browser's rendering) can be proven with zero API calls.
 *
 * Reuses the SAME session the scenario runner uses, so a chat message and a
 * fired scenario share one live TripState, exactly like the real server.
 */
async function streamScriptedChat(message: string, response: ServerResponse): Promise<void> {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    sendJson(response, 400, { error: "Type something first." });
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
    "X-Accel-Buffering": "no",
  });

  let open = true;
  response.on("close", () => {
    open = false;
  });

  const emit = async (type: string, data: unknown): Promise<void> => {
    if (!open) return;
    response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    await sleep(PACING_MS[type] ?? DEFAULT_PACING_MS);
  };

  try {
    const world = session.world;
    const state = session.state;

    const result = await runChatTurn({
      model: createScriptedChatModel(),
      world,
      state,
      baseWorld: session.catalogue,
      history: session.chatHistory,
      userMessage: trimmed,
      observer: {
        onTurnStart: (index) => void emit("turn", { index }),
        onReasoning: (index, text) => void emit("reasoning", { index, text }),
        onToolCall: (name, args) => void emit("tool_call", { name, args }),
        onToolResult: (call) =>
          void emit("tool_result", {
            name: call.name,
            ok: call.outcome.ok,
            reason: call.outcome.reason ?? null,
            shortfall: call.outcome.shortfall ?? null,
            summary: call.outcome.summary,
            changedState: call.outcome.changedState,
            trip: toTripView(call.outcome.world, call.outcome.state),
          }),
        onNotification: (text) => void emit("notification", { message: text }),
      },
    });

    session.world = result.world;
    session.state = result.state;
    session.chatHistory = result.history;

    // Printed so the trimming rule can be checked by eye: this must stay flat
    // however many messages are sent, never grow with the conversation.
    console.log(`  [chat] history entries after this exchange: ${result.history.length}`);

    await emit("chat_reply", { text: result.reply, trip: toTripView(session.world, session.state) });
    await emit("chat_done", { toolCalls: result.toolCallCount, rejections: result.rejectionCount });
  } catch (error: unknown) {
    await emit("failed", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
    if (open) response.end();
  }
}

/**
 * A handful of keyword triggers, just enough to walk the real tools through a
 * disruption, a search plus rebook, and a refusal. Everything past the
 * decision of WHICH tool to call next is the real executor, the real engine,
 * the real budget maths.
 */
function createScriptedChatModel(): AgentModel {
  let counter = 0;

  return {
    name: "offline stub, no model called",

    async generate(contents: Content[]): Promise<ModelTurn> {
      const last = contents[contents.length - 1];
      const priorToolName = lastFunctionResponseName(last);

      const scripted: ScriptedTurn = priorToolName
        ? followUpFor(priorToolName, last)
        : scriptFor(collectUserText(last));

      const toolCalls: ModelToolCall[] = (scripted.toolCalls ?? []).map((call) => {
        counter += 1;
        return { id: `stub_${counter}`, name: call.name, args: call.args };
      });

      const parts: Part[] = [];
      if (scripted.text.length > 0) parts.push({ text: scripted.text });
      for (const call of toolCalls) {
        // Always set above, just re-typed as optional by ModelToolCall's own shape.
        parts.push({ functionCall: { id: call.id as string, name: call.name, args: call.args } });
      }

      return { text: scripted.text, toolCalls, content: { role: "model", parts } };
    },
  };
}

interface ScriptedTurn {
  text: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

function collectUserText(content?: Content): string {
  return (content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join(" ")
    .trim();
}

function lastFunctionResponseName(content?: Content): string | undefined {
  for (const part of content?.parts ?? []) {
    if (part.functionResponse?.name !== undefined) return part.functionResponse.name;
  }
  return undefined;
}

function lastFunctionResponsePayload(content?: Content): Record<string, unknown> | undefined {
  for (const part of content?.parts ?? []) {
    if (part.functionResponse?.response !== undefined) {
      return part.functionResponse.response as Record<string, unknown>;
    }
  }
  return undefined;
}

/** What the traveller said, turned into exactly one scripted decision. */
function scriptFor(userText: string): ScriptedTurn {
  const text = userText.toLowerCase();

  if (/(hotel|stay|room)/.test(text) && /(cancel|closed|shut|no longer)/.test(text)) {
    return {
      text:
        "You are telling me the room just fell through. I will make that real the same way a " +
        "scripted disruption would, by closing whatever this trip has actually booked for the stay.",
      toolCalls: [
        {
          name: "apply_disruption",
          args: {
            kind: "venue_closed",
            timeSlot: "Trip",
            category: "stay",
            message: "{option} has shut its doors for emergency repairs, with no notice.",
          },
        },
      ],
    };
  }

  const slotMatch = /day\s*(\d)\s*(morning|afternoon|evening)/i.exec(userText);
  const mentionsCancel = /(cancel|closed|shut|no longer|fell through)/.test(text);

  // A named day slot plus a cancellation word means the traveller is
  // describing damage to THAT slot, so it is made real with apply_disruption
  // rather than searched, exactly the same distinction the live agent has to
  // draw between "something just broke" and "please look at what is open."
  if (slotMatch && mentionsCancel) {
    const timeSlot = `Day ${slotMatch[1]} ${capitalize(slotMatch[2] ?? "")}`;
    return {
      text: `You are telling me ${timeSlot} just fell through. Making that real, the same way a scripted disruption would.`,
      toolCalls: [
        {
          name: "apply_disruption",
          args: {
            kind: "activity_cancelled",
            timeSlot,
            category: "activity",
            message: "{option} has been called off, with no notice.",
          },
        },
      ],
    };
  }

  if (/(empty|unfilled|nothing booked|fix it)/.test(text) || slotMatch) {
    const timeSlot = slotMatch ? `Day ${slotMatch[1]} ${capitalize(slotMatch[2] ?? "")}` : undefined;
    return {
      text: timeSlot
        ? `Looking at what is still open for ${timeSlot}.`
        : "Let me see what is still open for the empty slot on this trip.",
      toolCalls: [{ name: "search_alternatives", args: timeSlot ? { timeSlot } : {} }],
    };
  }

  if (/(upgrade|suite|heritage|nicer room|best room)/.test(text)) {
    return {
      text: "You want the nicer room. Let me try booking it directly and see what the tool says.",
      toolCalls: [{ name: "rebook_slot", args: { oldOptionId: "s2", newOptionId: "s3" } }],
    };
  }

  return {
    text:
      "This offline stub only scripts a few phrasings (a cancelled room, an empty slot, an " +
      "upgrade). Try one of those, or run the real server for genuine free form chat.",
  };
}

/** After a tool call comes back, decide the next step from what actually happened. */
function followUpFor(toolName: string, last?: Content): ScriptedTurn {
  if (toolName === "apply_disruption") {
    return { text: "Done. That is real now, the itinerary and the budget above both reflect it." };
  }

  if (toolName === "search_alternatives") {
    const payload = lastFunctionResponsePayload(last);
    const alternatives = (payload?.alternatives as Array<{ id: string; name: string }> | undefined) ?? [];
    const pick = alternatives[0];
    if (pick === undefined) {
      return { text: "Nothing is open there. That slot has to stay empty, and I am telling you so rather than inventing a booking." };
    }
    return {
      text: `${pick.name} is open and affordable. Booking it now.`,
      toolCalls: [{ name: "rebook_slot", args: { oldOptionId: null, newOptionId: pick.id } }],
    };
  }

  if (toolName === "rebook_slot") {
    const payload = lastFunctionResponsePayload(last);
    if (payload?.ok === false) {
      return {
        text: `That was refused: ${String(payload.summary ?? "the tool would not allow it")}. I am not going to force it, the budget is holding for a reason.`,
      };
    }
    return { text: "Booked. The itinerary above reflects it." };
  }

  return { text: "Done, using the real tools." };
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

// ------------------------------------------------------------------- plumbing

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

async function serveStatic(path: string, response: ServerResponse): Promise<void> {
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
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
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const port = Number(process.env.PORT ?? 5174);

server.listen(port, () => {
  console.log("");
  console.log("  TRIP GUARDIAN, OFFLINE UI HARNESS");
  console.log(`  http://localhost:${port}`);
  console.log("");
  console.log("  No model is called. No network request is made. No API key is read.");
  console.log("  Tool verdicts, budgets and disruptions are REAL.");
  console.log("  The reasoning prose is FIXED NARRATION, not model output.");
  console.log("  Add &discrepancy=1 to /api/run to exercise the discrepancy warning.");
  console.log("");
});
