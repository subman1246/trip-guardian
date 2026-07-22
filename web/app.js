/*
 * The demo page.
 *
 * Plain browser JavaScript, no build step, no framework, no dependencies.
 *
 * It does no reasoning and no money maths. The server sends an already resolved
 * view of the trip with every event and this file draws it. There is no model
 * client here and no API key here, by construction: the only thing this page can
 * talk to is its own origin.
 */

const els = {
  providerChip: document.getElementById("provider-chip"),
  scenarioButtons: document.getElementById("scenario-buttons"),
  scenarioNote: document.getElementById("scenario-note"),
  resetButton: document.getElementById("reset-button"),
  itinerary: document.getElementById("itinerary"),
  itineraryTotal: document.getElementById("itinerary-total"),
  budget: document.getElementById("budget"),
  budgetTotal: document.getElementById("budget-total"),
  trace: document.getElementById("trace"),
  traceStatus: document.getElementById("trace-status"),
  setupForm: document.getElementById("setup-form"),
  setupDays: document.getElementById("setup-days"),
  setupBudget: document.getElementById("setup-budget"),
  setupSubmit: document.getElementById("setup-submit"),
  setupError: document.getElementById("setup-error"),
  setupSummary: document.getElementById("setup-summary"),
};

/** The scenario written to be refused. Flagged in the button row. */
const HEADLINE_SCENARIO = "no-donor-left";

let stream = null;
let running = false;
/** Previous slot contents, so a row that actually changed can be flashed. */
let lastSlotSignature = new Map();

// ------------------------------------------------------------- formatting

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

// ------------------------------------------------------------- itinerary

function renderTrip(trip) {
  renderItinerary(trip);
  renderBudget(trip.budget);
  els.itineraryTotal.textContent = rupees(trip.itineraryTotal);
  els.budgetTotal.textContent = `${rupees(trip.budget.totalSpent)} of ${rupees(trip.budget.totalINR)}`;
  // Only the endpoints that build a trip carry the setup block. A tool result
  // mid run does not, and must not blank the panel.
  if (trip.setup) renderSetup(trip.setup);
}

function renderItinerary(trip) {
  const signature = new Map();
  els.itinerary.replaceChildren();

  for (const slot of trip.slots) {
    const line = slot.bookings.map((b) => `${b.optionId}:${b.price}`).join(",");
    signature.set(slot.timeSlot, line);

    const row = el("div", "slot");
    const previous = lastSlotSignature.get(slot.timeSlot);
    // Only flash a genuine change, never the first paint.
    if (previous !== undefined && previous !== line) row.classList.add("changed");

    row.append(el("div", "slot-when", slot.timeSlot === "Trip" ? "Whole trip" : slot.timeSlot));

    const body = el("div");
    if (slot.bookings.length === 0) {
      body.append(el("div", "slot-empty", slot.isDaySlot ? "EMPTY, nothing booked" : "nothing booked"));
    }
    for (const booking of slot.bookings) {
      const wrap = el("div", "booking");
      const name = el("div", "booking-name");
      name.append(el("span", `booking-cat ${booking.category}`, booking.category));
      const strong = el("b", null, booking.name);
      name.append(strong);
      wrap.append(name, el("div", "booking-price", rupees(booking.price)));
      body.append(wrap);
    }

    row.append(body);
    els.itinerary.append(row);
  }

  lastSlotSignature = signature;
}

// ---------------------------------------------------------------- budget

function renderBudget(budget) {
  els.budget.replaceChildren();

  for (const ledger of budget.byCategory) {
    const over = ledger.remaining < 0;
    const cat = el("div", `cat ${ledger.category}${over ? " is-over" : ""}`);

    const head = el("div", "cat-head");
    head.append(el("div", "cat-name", ledger.category));

    const figures = el("div", "cat-figures");
    figures.append(document.createTextNode(`${rupees(ledger.spent)} of ${rupees(ledger.allocated)}, `));
    const remaining = el("span", over ? "over" : null, over
      ? `${rupees(-ledger.remaining)} OVER`
      : `${rupees(ledger.remaining)} left`);
    figures.append(remaining);
    head.append(figures);
    cat.append(head);

    // The bar is scaled to whichever is larger, the allocation or the spend, so
    // an overspend visibly runs past the allocation tick instead of clipping.
    const scale = Math.max(ledger.allocated, ledger.spent, 1);
    const bar = el("div", "bar");
    const fill = el("div", "bar-fill");
    fill.style.width = `${(Math.max(0, ledger.spent) / scale) * 100}%`;
    const tick = el("div", "bar-tick");
    tick.style.left = `${(ledger.allocated / scale) * 100}%`;
    bar.append(fill, tick);
    cat.append(bar);

    const legend = el("div", "cat-legend");
    legend.append(el("span", null, "spent"), el("span", null, `allocated ${rupees(ledger.allocated)}`));
    cat.append(legend);

    els.budget.append(cat);
  }

  const totals = el("div", "cat-legend");
  totals.append(
    el("span", null, `total spent ${rupees(budget.totalSpent)}`),
    el("span", null, `${rupees(budget.totalRemaining)} of ${rupees(budget.totalINR)} unspent`),
  );
  els.budget.append(totals);
}

// ------------------------------------------------------------- the setup

/**
 * Show the trip that was constructed, and the arithmetic behind it, before any
 * scenario is fired. Every number here was computed on the server from the
 * catalogue. The page does no money maths of its own.
 */
function renderSetup(setup) {
  els.setupDays.value = String(setup.days);
  els.setupBudget.value = String(setup.totalINR);
  els.setupDays.min = String(setup.minDays);
  els.setupDays.max = String(setup.maxDays);

  els.setupSummary.replaceChildren();

  const head = el("div", "setup-head");
  head.append(
    el("strong", null, `${setup.days} day trip, ${setup.nights} night${setup.nights === 1 ? "" : "s"}`),
    el("span", null, `${setup.requiredBookings} bookings`),
    el("span", null, `${rupees(setup.startingSpendINR)} of ${rupees(setup.totalINR)} committed`),
    el("span", "setup-headroom", `${rupees(setup.headroomINR)} held back (${setup.headroomPercent}%)`),
  );
  els.setupSummary.append(head);

  const table = el("div", "setup-table");
  table.append(
    el("span", "setup-th", "category"),
    el("span", "setup-th", "cheapest possible"),
    el("span", "setup-th", "allocated"),
    el("span", "setup-th", "starts at"),
    el("span", "setup-th", "headroom"),
  );
  for (const row of setup.byCategory) {
    table.append(
      el("span", `setup-cat ${row.category}`, row.category),
      el("span", null, rupees(row.floor)),
      el("span", null, rupees(row.allocated)),
      el("span", null, rupees(row.startingSpend)),
      el("span", "setup-room", rupees(row.headroom)),
    );
  }
  els.setupSummary.append(table);

  const rules = el("ol", "setup-rule");
  for (const line of setup.rule) rules.append(el("li", null, line));
  els.setupSummary.append(rules);
}

/** Clear or show the feasibility refusal. Nothing is rebuilt when it shows. */
function showSetupError(text) {
  if (!text) {
    els.setupError.hidden = true;
    els.setupError.textContent = "";
    return;
  }
  els.setupError.hidden = false;
  els.setupError.textContent = text;
}

async function submitSetup(event) {
  event.preventDefault();
  if (running) return;

  const days = Number(els.setupDays.value);
  const budget = Number(els.setupBudget.value);

  els.setupSubmit.disabled = true;
  showSetupError("");

  try {
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days, budget }),
    });
    const body = await response.json();

    if (!response.ok) {
      // 422 is the feasibility refusal: the request made sense and the money
      // does not stretch. The old trip is left exactly as it was.
      showSetupError(body.error);
      return;
    }

    lastSlotSignature = new Map();
    renderTrip(body);
    await loadScenarios();
    clearTrace();
    els.trace.append(
      el("p", "trace-empty", "Trip built. Fire a scenario above to watch the agent defend it."),
    );
    els.scenarioNote.textContent = "";
    els.traceStatus.textContent = "idle";
  } catch (error) {
    showSetupError(`Could not reach the server: ${error.message}`);
  } finally {
    els.setupSubmit.disabled = false;
  }
}

// ------------------------------------------------------------- scenarios

/**
 * Draw the scenario row. A scenario whose options are not booked on this trip
 * is drawn disabled with the reason next to it, rather than being hidden, so it
 * is obvious that it exists and why it cannot run right now.
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
}

// ----------------------------------------------------------------- trace

function clearTrace() {
  els.trace.replaceChildren();
}

function addEntry(node) {
  if (els.trace.querySelector(".trace-empty")) clearTrace();
  els.trace.append(node);
  els.trace.scrollTop = els.trace.scrollHeight;
  return node;
}

function traceTurn(index) {
  addEntry(el("div", "entry entry-turn", `Turn ${index}`));
}

function traceDisruption(data) {
  const box = el("div", "entry entry-disruption");
  box.append(el("div", "kind", `${data.id} ${data.kind.replace(/_/g, " ")}`));
  box.append(el("p", null, data.message));
  const list = el("ul");
  for (const change of data.changes) list.append(el("li", null, change));
  box.append(list);
  addEntry(box);
}

function traceReasoning(text) {
  addEntry(el("div", "entry entry-reasoning", text.trim()));
}

function traceCall(name, args) {
  const box = el("div", "entry entry-call");
  const line = el("div");
  line.append(el("span", "tool", name), document.createTextNode("("));
  box.append(line);

  const entries = Object.entries(args ?? {}).filter(([, value]) => value !== undefined && value !== null);
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
  const box = el("div", `entry entry-result ${data.ok ? "ok" : "rejected"}`);
  const line = el("div");
  line.append(el("span", "verdict", data.ok ? "ACCEPTED" : "REJECTED"));
  line.append(document.createTextNode(data.summary));
  box.append(line);

  if (!data.ok) {
    const detail = data.shortfall === null
      ? `reason: ${data.reason}`
      : `reason: ${data.reason}, short by ${rupees(data.shortfall)}`;
    box.append(el("span", "reason", detail));
  }

  addEntry(box);
  if (data.trip) renderTrip(data.trip);
}

function traceNotice(text) {
  addEntry(el("div", "entry entry-notice", text));
}

function traceReport(message) {
  const box = el("div", "entry entry-report");
  box.append(el("h3", null, "Report to the traveller"));
  box.append(el("pre", null, message));
  addEntry(box);
}

function traceSummary(data) {
  const box = el("div", "entry entry-summary");
  const broken = data.trip.overspentCategories.length > 0;
  box.append(
    labelled("ended", data.stopped.replace(/_/g, " ")),
    labelled("turns", String(data.turns)),
    labelled("tool calls", String(data.toolCalls)),
    labelled("refused by the tools", String(data.rejections)),
  );
  box.append(el("span", broken ? "broken" : "held",
    broken ? `BUDGET BROKEN in ${data.trip.overspentCategories.join(", ")}` : "BUDGET HELD"));
  addEntry(box);

  // The budget holding is not the same as the report being true. An agent can
  // claim a booking it never made, so never let the green line stand alone.
  const unresolved = data.unresolved ?? [];
  if (unresolved.length > 0) {
    const warning = el("div", "entry entry-discrepancy");
    warning.append(el("h3", null, "The report does not match the trip handed back"));
    const list = el("ul");
    for (const problem of unresolved) list.append(el("li", null, problem));
    warning.append(list);
    addEntry(warning);
  }

  renderTrip(data.trip);
}

function labelled(label, value) {
  const span = el("span");
  span.append(document.createTextNode(`${label} `), el("b", null, value));
  return span;
}

// ------------------------------------------------------------ the run

function setRunning(isRunning, label) {
  running = isRunning;
  els.resetButton.disabled = isRunning;
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

  clearTrace();
  lastSlotSignature = new Map();
  els.scenarioNote.textContent = scenario.note;
  setRunning(true, "running");
  button.classList.add("is-running");

  stream = new EventSource(`/api/run?scenario=${encodeURIComponent(scenario.id)}`);

  const on = (name, handler) => stream.addEventListener(name, (event) => handler(JSON.parse(event.data)));

  on("reset", (trip) => renderTrip(trip));
  on("scenario", () => {});
  on("disruption", (data) => {
    traceDisruption(data);
    renderTrip(data.trip);
  });
  on("agent_start", (data) => traceNotice(`Agent running on ${data.model}, turn cap ${data.maxTurns}.`));
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
    addEntry(el("div", "entry entry-failed", data.message));
    finish("failed");
  });

  // The server ends the response when the run is over, which surfaces here as an
  // error. Only report it if the run had not already reported itself.
  stream.onerror = () => {
    if (running) finish("disconnected");
  };
}

function finish(label) {
  if (stream !== null) {
    stream.close();
    stream = null;
  }
  setRunning(false, label);
}

// ----------------------------------------------------------------- boot

async function boot() {
  // The page opens on the default trip the server built, so there is always
  // something to look at before anything is configured.
  const trip = await fetch("/api/trip").then((response) => response.json());
  renderTrip(trip);
  await loadScenarios();

  els.setupForm.addEventListener("submit", submitSetup);

  els.resetButton.addEventListener("click", async () => {
    if (running) return;
    // Reset goes back to the trip the traveller configured, not to any
    // hardcoded one.
    const fresh = await fetch("/api/reset", { method: "POST" }).then((response) => response.json());
    lastSlotSignature = new Map();
    renderTrip(fresh);
    clearTrace();
    els.trace.append(el("p", "trace-empty", "Back to your trip as booked. Fire a scenario to start again."));
    els.scenarioNote.textContent = "";
    els.traceStatus.textContent = "idle";
  });

  setRunning(false, "idle");
}

boot().catch((error) => {
  els.providerChip.textContent = "server unreachable";
  addEntry(el("div", "entry entry-failed", `Could not reach the server: ${error.message}`));
});
