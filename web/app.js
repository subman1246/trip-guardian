/*
 * Trip Guardian, the page.
 *
 * Plain browser JavaScript. No build step, no framework, no dependencies.
 *
 * It does no reasoning and no money maths. The server sends an already resolved
 * view of the trip with every event and this file draws it. There is no model
 * client here and no API key here, by construction: the only origin this page
 * can talk to is its own.
 *
 * TWO PAGES, ONE DOCUMENT. Plan and Studio are both in the DOM the whole time,
 * so moving between them is a transition rather than a reload and the Studio
 * never re-fetches a trip it is already holding.
 *
 * WHY THE RENDERERS ARE KEYED. Budget bars and itinerary rows are built once and
 * then UPDATED IN PLACE. Replacing the nodes would restart every CSS transition
 * from nothing, so a bar would jump instead of sliding and a rebooked row would
 * never flash. Keeping the nodes is what makes the agent's work visible.
 */

const els = {
  stage: document.getElementById("stage"),
  pagePlan: document.getElementById("page-plan"),
  pageStudio: document.getElementById("page-studio"),

  setupForm: document.getElementById("setup-form"),
  setupDays: document.getElementById("setup-days"),
  setupBudget: document.getElementById("setup-budget"),
  setupSubmit: document.getElementById("setup-submit"),
  setupError: document.getElementById("setup-error"),
  setupErrorText: document.getElementById("setup-error-text"),
  setupErrorFigures: document.getElementById("setup-error-figures"),

  planFigures: document.getElementById("plan-figures"),
  planDays: document.getElementById("plan-days"),
  planAlloc: document.getElementById("plan-alloc"),
  planRule: document.getElementById("plan-rule"),
  enterStudio: document.getElementById("enter-studio"),
  backToPlan: document.getElementById("back-to-plan"),

  providerChip: document.getElementById("provider-chip"),
  tripChip: document.getElementById("trip-chip"),
  scenarioButtons: document.getElementById("scenario-buttons"),
  scenarioNote: document.getElementById("scenario-note"),
  resetButton: document.getElementById("reset-button"),

  itinerary: document.getElementById("itinerary"),
  itineraryTotal: document.getElementById("itinerary-total"),
  budget: document.getElementById("budget"),
  budgetTotal: document.getElementById("budget-total"),
  trace: document.getElementById("trace"),
  traceStatus: document.getElementById("trace-status"),
};

/** The scenario written to be refused. Flagged in the button row. */
const HEADLINE_SCENARIO = "no-donor-left";

let stream = null;
let running = false;
let scenariosLoaded = false;

/** Keyed nodes, so an update can animate instead of replacing. */
const slotNodes = new Map();
let itineraryShape = "";
const catNodes = new Map();
/** Last drawn values, so only genuine changes flash. */
const lastSlotSignature = new Map();
const lastLedger = new Map();
let firstPaintDone = false;

/** Where trace entries are appended: the current turn, or the trace root. */
let currentTurn = null;

// --------------------------------------------------------------- formatting

function rupees(amount) {
  const sign = amount < 0 ? "-" : "";
  return `${sign}Rs ${Math.abs(amount).toLocaleString("en-IN")}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "Day 2 Morning" becomes { day: 2, part: "morning" }. "Trip" spans them all. */
function splitSlot(timeSlot) {
  const match = /^Day (\d+) (.+)$/.exec(timeSlot);
  if (match === null) return { day: null, part: "whole trip" };
  return { day: Number(match[1]), part: match[2].toLowerCase() };
}

/** Group a trip's slots into days, with the spanning slot last. */
function groupByDay(slots) {
  const days = new Map();
  const spanning = [];

  for (const slot of slots) {
    const { day, part } = splitSlot(slot.timeSlot);
    if (day === null) {
      spanning.push({ ...slot, part });
      continue;
    }
    if (!days.has(day)) days.set(day, []);
    days.get(day).push({ ...slot, part });
  }

  const groups = [...days.entries()].map(([day, rows]) => ({ label: `Day ${day}`, rows }));
  if (spanning.length > 0) groups.push({ label: "Whole trip", rows: spanning });
  return groups;
}

/** Restart a one shot animation on a node that may already be carrying it. */
function replay(node, className, ms) {
  node.classList.remove(className);
  // Reading offsetWidth forces the style flush, so re-adding the class restarts
  // the animation rather than being coalesced into a no-op.
  void node.offsetWidth;
  node.classList.add(className);
  window.setTimeout(() => node.classList.remove(className), ms);
}

// ============================================================== the trip

/**
 * One trip view in, every panel that cares updated.
 *
 * Called on the first load, on a rebuild, on a reset, after each disruption and
 * after every tool result, which is what makes the panels move as the agent
 * works.
 */
function applyTrip(trip) {
  renderItinerary(trip);
  renderBudget(trip.budget);

  els.itineraryTotal.textContent = rupees(trip.itineraryTotal);
  els.budgetTotal.textContent = `${rupees(trip.budget.totalSpent)} of ${rupees(trip.budget.totalINR)}`;

  // Only the endpoints that build a trip carry the setup block. A tool result
  // mid run does not, and must not blank the Plan page.
  if (trip.setup) renderPlan(trip, trip.setup);

  firstPaintDone = true;
}

// ------------------------------------------------------------- itinerary

function renderItinerary(trip) {
  const shape = trip.slots.map((slot) => slot.timeSlot).join("|");

  // The set of slots only changes when the trip itself does, so the rows are
  // rebuilt then and only then. Everything else updates in place.
  if (shape !== itineraryShape) {
    buildItineraryShell(trip);
    itineraryShape = shape;
  }

  for (const slot of trip.slots) updateSlot(slot);
}

function buildItineraryShell(trip) {
  els.itinerary.replaceChildren();
  slotNodes.clear();
  lastSlotSignature.clear();

  for (const group of groupByDay(trip.slots)) {
    const wrap = el("div", "day-group");
    wrap.append(el("div", "day-label", group.label));

    for (const slot of group.rows) {
      const row = el("div", "slot");
      row.append(el("div", "slot-when", slot.part));
      const body = el("div", "slot-body");
      row.append(body);
      wrap.append(row);
      slotNodes.set(slot.timeSlot, { row, body, isDaySlot: slot.isDaySlot });
    }

    els.itinerary.append(wrap);
  }
}

function updateSlot(slot) {
  const node = slotNodes.get(slot.timeSlot);
  if (node === undefined) return;

  const signature = slot.bookings.map((b) => `${b.optionId}:${b.price}`).join(",");
  const previous = lastSlotSignature.get(slot.timeSlot);
  if (previous === signature) return;
  lastSlotSignature.set(slot.timeSlot, signature);

  node.body.replaceChildren();

  if (slot.bookings.length === 0) {
    // A day slot with nothing in it is a hole in the trip, and it must read as
    // one. The spanning slot merely being empty is not an alarm.
    const empty = el("div", `slot-empty${slot.isDaySlot ? "" : " is-quiet"}`,
      slot.isDaySlot ? "EMPTY, nothing booked" : "nothing booked");
    node.body.append(empty);
  }

  for (const booking of slot.bookings) {
    const wrap = el("div", "booking");
    const name = el("div", "booking-name");
    name.append(el("span", `booking-cat ${booking.category}`, booking.category));
    name.append(el("b", null, booking.name));
    wrap.append(name, el("div", "booking-price", rupees(booking.price)));
    node.body.append(wrap);
  }

  node.row.classList.toggle("is-gap", slot.isDaySlot && slot.bookings.length === 0);

  // Never flash the first paint, only a genuine change the agent made.
  if (previous !== undefined && firstPaintDone) replay(node.row, "changed", 1500);
}

// ---------------------------------------------------------------- budget

function renderBudget(budget) {
  if (catNodes.size === 0) buildBudgetShell(budget);
  for (const ledger of budget.byCategory) updateCategory(ledger);

  els.budget.querySelector(".cat-totals").replaceChildren(
    el("span", null, `total spent ${rupees(budget.totalSpent)}`),
    el("span", null, `${rupees(budget.totalRemaining)} of ${rupees(budget.totalINR)} unspent`),
  );
}

function buildBudgetShell(budget) {
  els.budget.replaceChildren();

  for (const ledger of budget.byCategory) {
    const cat = el("div", `cat ${ledger.category}`);

    const head = el("div", "cat-head");
    const name = el("div", "cat-name", ledger.category);
    const flag = el("span", "cat-flag", "OVER");
    const figures = el("div", "cat-figures");
    head.append(name, flag, figures);

    const bar = el("div", "bar");
    const fill = el("div", "bar-fill");
    const tick = el("div", "bar-tick");
    bar.append(fill, tick);

    const legend = el("div", "cat-legend");
    const legendLeft = el("span", null, "spent");
    const legendRight = el("span");
    legend.append(legendLeft, legendRight);

    cat.append(head, bar, legend);
    els.budget.append(cat);

    catNodes.set(ledger.category, { cat, figures, fill, tick, legendRight });
  }

  els.budget.append(el("div", "cat-totals"));
}

function updateCategory(ledger) {
  const node = catNodes.get(ledger.category);
  if (node === undefined) return;

  const previous = lastLedger.get(ledger.category);
  const over = ledger.remaining < 0;
  const changed =
    previous === undefined ||
    previous.spent !== ledger.spent ||
    previous.allocated !== ledger.allocated;

  node.figures.replaceChildren(
    document.createTextNode(`${rupees(ledger.spent)} of ${rupees(ledger.allocated)}, `),
    el("span", over ? "over" : null,
      over ? `${rupees(-ledger.remaining)} OVER` : `${rupees(ledger.remaining)} left`),
  );

  // The bar is scaled to whichever is larger, the allocation or the spend, so an
  // overspend visibly runs PAST the allocation tick instead of clipping. Both
  // the fill and the tick are transitioned, so a reallocation reads as the
  // allocation moving rather than as a redraw.
  const scale = Math.max(ledger.allocated, ledger.spent, 1);
  node.fill.style.width = `${(Math.max(0, ledger.spent) / scale) * 100}%`;
  node.tick.style.left = `${(ledger.allocated / scale) * 100}%`;
  node.legendRight.textContent = `allocated ${rupees(ledger.allocated)}`;

  const wasOver = previous !== undefined && previous.remaining < 0;
  node.cat.classList.toggle("is-over", over);

  if (firstPaintDone && changed) replay(node.figures, "lit", 900);
  // The moment it tips negative, once. After that it stays red and still, so the
  // alarm does not become wallpaper.
  if (firstPaintDone && over && !wasOver) replay(node.cat, "just-broke", 620);

  lastLedger.set(ledger.category, { ...ledger });
}

// ============================================================ page: PLAN

function renderPlan(trip, setup) {
  els.setupDays.value = String(setup.days);
  els.setupBudget.value = String(setup.totalINR);
  els.setupDays.min = String(setup.minDays);
  els.setupDays.max = String(setup.maxDays);

  els.tripChip.textContent = `${setup.days} days, ${rupees(setup.totalINR)}`;

  /*
   * The money shown here is taken from the LIVE budget, not from the plan the
   * trip was built with. Before a run the two are identical. After one they are
   * not, and a panel whose totals disagreed with the rows listed under them
   * would be worse than useless. Only the floors, which are a property of the
   * catalogue rather than of the current plan, come from the setup block.
   */
  const live = trip.budget;
  const headroomPercent = Math.round((live.totalRemaining / live.totalINR) * 100);

  // ----------------------------------------------------- the headline figures
  const figure = (label, value, className) => {
    const box = el("div", className);
    box.append(el("span", "fig-label", label), el("span", "fig-value", value));
    return box;
  };

  els.planFigures.replaceChildren(
    figure("length", `${setup.days} days, ${setup.nights} night${setup.nights === 1 ? "" : "s"}`),
    figure("bookings", String(setup.requiredBookings)),
    figure("committed", rupees(live.totalSpent)),
    figure("held back", `${rupees(live.totalRemaining)} (${headroomPercent}%)`, "is-held"),
  );

  // ------------------------------------------------------ the day by day plan
  els.planDays.replaceChildren();
  for (const group of groupByDay(trip.slots)) {
    const box = el("div", "plan-day");
    box.append(el("div", "plan-day-label", group.label));

    for (const slot of group.rows) {
      if (slot.bookings.length === 0) {
        const line = el("div", "plan-line is-empty");
        line.append(
          el("div", "plan-when", slot.part),
          el("div", "plan-what", "nothing booked"),
          el("div", "plan-price", ""),
        );
        box.append(line);
        continue;
      }
      for (const booking of slot.bookings) {
        const line = el("div", "plan-line");
        line.append(
          el("div", "plan-when", slot.part),
          el("div", "plan-what", booking.name),
          el("div", "plan-price", rupees(booking.price)),
        );
        box.append(line);
      }
    }
    els.planDays.append(box);
  }

  // ------------------------------------------------------ the allocation table
  els.planAlloc.replaceChildren(
    el("span", "alloc-th", "category"),
    el("span", "alloc-th alloc-num", "cheapest possible"),
    el("span", "alloc-th alloc-num", "allocated"),
    el("span", "alloc-th alloc-num", "starts at"),
    el("span", "alloc-th alloc-num", "headroom"),
  );
  for (const row of setup.byCategory) {
    // Allocation, spend and headroom come from the live ledger for the same
    // reason the headline figures do. The floor is a fact about the catalogue.
    const ledger = live.byCategory.find((entry) => entry.category === row.category) ?? row;
    els.planAlloc.append(
      el("span", `alloc-name ${row.category}`, row.category),
      el("span", "alloc-num", rupees(row.floor)),
      el("span", "alloc-num", rupees(ledger.allocated)),
      el("span", "alloc-num", rupees(ledger.spent ?? row.startingSpend)),
      el("span", ledger.remaining < 0 ? "alloc-num alloc-over" : "alloc-room",
        rupees(ledger.remaining ?? row.headroom)),
    );
  }

  // ------------------------------------------------------- the split rule prose
  els.planRule.replaceChildren();
  for (const line of setup.rule) els.planRule.append(el("li", null, line));
}

/**
 * The feasibility answer.
 *
 * Not an error dump. The useful content is the minimum budget that WOULD work,
 * so that number is set large next to the cheapest plan it was derived from.
 */
function showFeasibility(body) {
  if (body === null) {
    els.setupError.hidden = true;
    return;
  }

  els.setupErrorText.textContent = body.error;
  els.setupErrorFigures.replaceChildren();

  if (typeof body.minimumINR === "number") {
    const figure = (label, value, className) => {
      const box = el("div", className);
      box.append(el("dt", null, label), el("dd", null, value));
      return box;
    };
    els.setupErrorFigures.append(
      figure("you asked for", `${body.days} days`),
      figure("cheapest bookable plan", rupees(body.cheapestPlanINR)),
      figure("minimum that works", rupees(body.minimumINR), "is-key"),
    );
  }

  els.setupError.hidden = false;
}

async function submitSetup(event) {
  event.preventDefault();
  if (running) return;

  const days = Number(els.setupDays.value);
  const budget = Number(els.setupBudget.value);

  els.setupSubmit.disabled = true;
  showFeasibility(null);

  try {
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days, budget }),
    });
    const body = await response.json();

    if (!response.ok) {
      // 422 is the feasibility refusal: the request made sense and the money
      // does not stretch. The trip already built is left exactly as it was.
      showFeasibility(body);
      return;
    }

    // A new trip means new slots and new applicability, so both are rebuilt.
    itineraryShape = "";
    lastLedger.clear();
    firstPaintDone = false;
    applyTrip(body);
    scenariosLoaded = false;
    resetTrace("Trip built. Fire a scenario to watch the agent defend it.");
  } catch (error) {
    showFeasibility({ error: `Could not reach the server: ${error.message}` });
  } finally {
    els.setupSubmit.disabled = false;
  }
}

// ================================================== the page transition

/**
 * Plan and Studio are both mounted, so this is a transition, not a navigation.
 * Plan lifts away as Studio rises, which reads as one movement rather than two.
 */
async function showPage(which) {
  const entering = which === "studio" ? els.pageStudio : els.pagePlan;
  const leaving = which === "studio" ? els.pagePlan : els.pageStudio;

  if (which === "studio" && !scenariosLoaded) await loadScenarios();

  leaving.classList.remove("is-active");
  leaving.setAttribute("aria-hidden", "true");
  entering.classList.add("is-active");
  entering.removeAttribute("aria-hidden");

  // Focus the region that just arrived, so the keyboard follows the eye.
  entering.scrollTop = 0;
  window.setTimeout(() => {
    const target = which === "studio" ? els.resetButton : els.setupDays;
    if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
  }, 420);
}

// ============================================================= scenarios

/**
 * Draw the scenario row. A scenario whose options are not booked on this trip is
 * drawn disabled with the reason NEXT TO IT, not hidden, so it is obvious that
 * it exists and why it cannot run right now.
 */
async function loadScenarios() {
  const meta = await fetch("/api/scenarios").then((response) => response.json());
  els.providerChip.textContent = `${meta.provider} / ${meta.model}`;
  els.scenarioButtons.replaceChildren();

  for (const scenario of meta.scenarios) {
    const cell = el("div", "scenario-cell");

    const button = el("button", "btn", scenario.title);
    button.type = "button";
    if (scenario.id === HEADLINE_SCENARIO) button.classList.add("btn-headline");
    // Remembered so a finished run re-enables only the ones that can run.
    button.dataset.applicable = scenario.applicable ? "yes" : "no";
    cell.append(button);

    if (scenario.applicable) {
      button.title = scenario.note;
      button.addEventListener("click", () => runScenario(scenario, button));
    } else {
      button.classList.add("btn-off");
      button.disabled = true;
      button.title = `Does not apply to this trip. ${scenario.reason}`;
      cell.append(el("span", "scenario-reason", scenario.reason));
    }

    els.scenarioButtons.append(cell);
  }

  scenariosLoaded = true;
}

// ================================================================= trace

function resetTrace(message) {
  currentTurn = null;
  els.trace.replaceChildren(el("p", "trace-empty", message));
  els.scenarioNote.textContent = "";
  els.traceStatus.textContent = "idle";
  els.traceStatus.classList.remove("live");
}

/** Append to the current turn if there is one, otherwise to the trace itself. */
function addEntry(node, { toRoot = false } = {}) {
  const empty = els.trace.querySelector(".trace-empty");
  if (empty !== null) empty.remove();

  const host = toRoot || currentTurn === null ? els.trace : currentTurn.box;
  host.append(node);
  els.trace.scrollTop = els.trace.scrollHeight;
  return node;
}

/**
 * A turn opens in a thinking state: the agent has been asked and has not
 * answered yet. That wait IS the content here, so it is shown rather than
 * covered with a spinner. The first thing that arrives for the turn resolves it.
 */
function traceTurn(index) {
  const box = el("div", "turn is-thinking");
  const head = el("div", "turn-head");
  head.append(el("span", "turn-badge", `Turn ${index}`));

  const thinking = el("div", "thinking");
  const dots = el("span", "thinking-dots");
  dots.append(el("i"), el("i"), el("i"));
  thinking.append(dots, el("span", null, "thinking"));
  head.append(thinking);

  box.append(head);
  addEntry(box, { toRoot: true });
  currentTurn = { box, thinking };
}

/** The wait is over: whatever arrived first for this turn ends the thinking. */
function settleTurn() {
  if (currentTurn === null) return;
  currentTurn.thinking.classList.add("is-done");
  currentTurn.box.classList.remove("is-thinking");
}

function traceDisruption(data) {
  const box = el("div", "entry entry-disruption");
  box.append(el("div", "kind", `${data.id} ${data.kind.replace(/_/g, " ")}`));
  box.append(el("p", null, data.message));
  const list = el("ul");
  for (const change of data.changes) list.append(el("li", null, change));
  box.append(list);
  addEntry(box, { toRoot: true });
}

function traceReasoning(text) {
  settleTurn();
  addEntry(el("div", "entry entry-reasoning", text.trim()));
}

function traceCall(name, args) {
  settleTurn();

  const box = el("div", "entry entry-call");
  const line = el("div");
  line.append(el("span", "tool", name), document.createTextNode("("));
  box.append(line);

  const entries = Object.entries(args ?? {}).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  for (const [key, value] of entries) {
    const arg = el("span", "arg");
    arg.append(el("em", null, `${key}: `));
    // Long strings (the final report) are clipped, the report gets its own card.
    const rendered =
      typeof value === "string"
        ? JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}...` : value)
        : Array.isArray(value)
          ? `[${value.length} item${value.length === 1 ? "" : "s"}]`
          : JSON.stringify(value);
    arg.append(document.createTextNode(rendered));
    box.append(arg);
  }

  box.append(el("div", null, ")"));
  addEntry(box);
}

function traceResult(data) {
  settleTurn();

  const box = el("div", `entry entry-result ${data.ok ? "ok" : "rejected"}`);
  const line = el("div");
  line.append(el("span", "verdict", data.ok ? "ACCEPTED" : "REJECTED"));
  line.append(document.createTextNode(data.summary));
  box.append(line);

  if (!data.ok) {
    const detail =
      data.shortfall === null
        ? `reason: ${data.reason}`
        : `reason: ${data.reason}, short by ${rupees(data.shortfall)}`;
    box.append(el("span", "reason", detail));
  }

  addEntry(box);
  // The panels move here. This is the payoff of keeping the nodes keyed.
  if (data.trip) applyTrip(data.trip);
}

function traceNotice(text) {
  settleTurn();
  addEntry(el("div", "entry entry-notice", text));
}

/** The end of the run, and the thing the traveller would actually receive. */
function traceReport(message) {
  settleTurn();
  currentTurn = null;

  const box = el("div", "entry entry-report");
  box.append(el("div", "report-eyebrow", "notify_user"));
  box.append(el("h3", null, "Report to the traveller"));
  box.append(el("pre", null, message));
  addEntry(box, { toRoot: true });
}

function traceSummary(data) {
  settleTurn();
  currentTurn = null;

  const box = el("div", "entry entry-summary");
  const broken = data.trip.overspentCategories.length > 0;
  box.append(
    labelled("ended", data.stopped.replace(/_/g, " ")),
    labelled("turns", String(data.turns)),
    labelled("tool calls", String(data.toolCalls)),
    labelled("refused by the tools", String(data.rejections)),
  );
  box.append(
    el(
      "span",
      broken ? "broken" : "held",
      broken
        ? `BUDGET BROKEN in ${data.trip.overspentCategories.join(", ")}`
        : "BUDGET HELD",
    ),
  );
  addEntry(box, { toRoot: true });

  // The budget holding is not the same as the report being true. An agent can
  // claim a booking it never made, so never let the green line stand alone.
  const unresolved = data.unresolved ?? [];
  if (unresolved.length > 0) {
    const warning = el("div", "entry entry-discrepancy");
    warning.append(el("h3", null, "The report does not match the trip handed back"));
    const list = el("ul");
    for (const problem of unresolved) list.append(el("li", null, problem));
    warning.append(list);
    addEntry(warning, { toRoot: true });
  }

  applyTrip(data.trip);
}

function labelled(label, value) {
  const span = el("span");
  span.append(document.createTextNode(`${label} `), el("b", null, value));
  return span;
}

// =============================================================== the run

function setRunning(isRunning, label) {
  running = isRunning;
  els.resetButton.disabled = isRunning;
  els.backToPlan.disabled = isRunning;
  els.setupSubmit.disabled = isRunning;
  els.setupDays.disabled = isRunning;
  els.setupBudget.disabled = isRunning;

  for (const cell of els.scenarioButtons.children) {
    const button = cell.querySelector("button");
    if (button === null) continue;
    // A scenario that does not apply to this trip stays disabled either way.
    // Finishing a run must not hand it back.
    const applicable = button.dataset.applicable === "yes";
    button.disabled = isRunning || !applicable;
    if (!isRunning) button.classList.remove("is-running");
  }

  els.traceStatus.textContent = label;
  els.traceStatus.classList.toggle("live", isRunning);
}

function runScenario(scenario, button) {
  if (running) return;

  els.trace.replaceChildren();
  currentTurn = null;
  els.scenarioNote.textContent = scenario.note;
  setRunning(true, "running");
  button.classList.add("is-running");

  stream = new EventSource(`/api/run?scenario=${encodeURIComponent(scenario.id)}`);

  const on = (name, handler) =>
    stream.addEventListener(name, (event) => handler(JSON.parse(event.data)));

  on("reset", (trip) => applyTrip(trip));
  on("scenario", () => {});
  on("disruption", (data) => {
    traceDisruption(data);
    applyTrip(data.trip);
  });
  on("agent_start", (data) =>
    traceNotice(`Agent running on ${data.model}, turn cap ${data.maxTurns}.`),
  );
  on("turn", (data) => traceTurn(data.index));
  on("reasoning", (data) => traceReasoning(data.text));
  on("tool_call", (data) => traceCall(data.name, data.args));
  on("tool_result", (data) => traceResult(data));
  on("notice", (data) => traceNotice(data.text));
  on("notification", (data) => traceReport(data.message));
  on("done", (data) => {
    traceSummary(data);
    finish("finished");
  });
  on("failed", (data) => {
    settleTurn();
    currentTurn = null;
    addEntry(el("div", "entry entry-failed", data.message), { toRoot: true });
    finish("failed");
  });

  // The server ends the response when the run is over, which surfaces here as an
  // error. Only report it if the run had not already reported itself.
  stream.onerror = () => {
    if (running) {
      settleTurn();
      finish("disconnected");
    }
  };
}

function finish(label) {
  if (stream !== null) {
    stream.close();
    stream = null;
  }
  settleTurn();
  setRunning(false, label);
}

// ================================================================== boot

async function boot() {
  // The page opens on the default trip the server built, so there is always
  // something to look at before anything is configured.
  const trip = await fetch("/api/trip").then((response) => response.json());
  applyTrip(trip);

  els.setupForm.addEventListener("submit", submitSetup);
  els.enterStudio.addEventListener("click", () => showPage("studio"));
  els.backToPlan.addEventListener("click", () => {
    if (running) return;
    showPage("plan");
  });

  els.resetButton.addEventListener("click", async () => {
    if (running) return;
    // Reset goes back to the trip the traveller configured, not to any
    // hardcoded one.
    const fresh = await fetch("/api/reset", { method: "POST" }).then((response) =>
      response.json(),
    );
    applyTrip(fresh);
    resetTrace("Back to your trip as booked. Fire a scenario to start again.");
  });

  setRunning(false, "idle");
}

boot().catch((error) => {
  els.providerChip.textContent = "server unreachable";
  showFeasibility({ error: `Could not reach the server: ${error.message}` });
});
