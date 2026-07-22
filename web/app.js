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

  // The budget holding is not the same as the trip being repaired. An agent can
  // leave a slot empty and still report success, so say so rather than let the
  // green line imply the job is done.
  if (data.trip.emptySlots.length > 0) {
    box.append(el("span", "broken", `LEFT EMPTY: ${data.trip.emptySlots.join(", ")}`));
  }

  addEntry(box);
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
  for (const button of els.scenarioButtons.children) {
    button.disabled = isRunning;
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
  const [meta, trip] = await Promise.all([
    fetch("/api/scenarios").then((response) => response.json()),
    fetch("/api/trip").then((response) => response.json()),
  ]);

  els.providerChip.textContent = `${meta.provider} / ${meta.model}`;
  renderTrip(trip);

  for (const scenario of meta.scenarios) {
    const button = el("button", "btn", scenario.title);
    if (scenario.id === HEADLINE_SCENARIO) button.classList.add("btn-headline");
    button.type = "button";
    button.title = scenario.note;
    button.addEventListener("click", () => runScenario(scenario, button));
    els.scenarioButtons.append(button);
  }

  els.resetButton.addEventListener("click", async () => {
    if (running) return;
    const fresh = await fetch("/api/reset", { method: "POST" }).then((response) => response.json());
    lastSlotSignature = new Map();
    renderTrip(fresh);
    clearTrace();
    els.trace.append(el("p", "trace-empty", "Back to the trip as booked. Fire a scenario to start again."));
    els.scenarioNote.textContent = "";
    els.traceStatus.textContent = "idle";
  });

  setRunning(false, "idle");
}

boot().catch((error) => {
  els.providerChip.textContent = "server unreachable";
  addEntry(el("div", "entry entry-failed", `Could not reach the server: ${error.message}`));
});
