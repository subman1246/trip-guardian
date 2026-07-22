# Trip Guardian

An autonomous travel agent that defends a live itinerary and a fixed budget
when something goes wrong mid trip.

Most travel tools plan for before a trip, not during one. When a flight is
cancelled or a hotel closes, the annoying part is rarely finding a
replacement, it is affording it without blowing a budget that was already
spent. Trip Guardian is built around that second problem: it holds a real
itinerary and a real budget, and when a disruption hits it has to reason its
way to a fix using only the money already on the table.

## What it does

The agent holds a live itinerary and a fixed budget in Indian Rupees. A
disruption fires (a cancellation, a price spike, a venue closing), and the
agent reasons about it, calls real tools to search alternatives, rebook slots
and reallocate money between categories, then reports the tradeoff it made.
Nothing is presented for approval first and no fix is scripted. Every repair
is worked out at runtime against the actual state of the trip.

The flagship case is `no-donor-left`: the only replacement for an emptied slot
busts its own spending category, and no single other category can lend enough
to cover it either. Rebooking alone is refused. Reallocating alone is refused.
The agent has to work out that no direct repair exists, then spend less
somewhere else first (downgrade to the option that costs the trip least),
free up room in two categories at once, reallocate, and only then book the
replacement. That sequence is reasoned by the model at runtime, not hardcoded
anywhere in this repo.

## Quick start

Prerequisites: Node.js 20 or later.

1. Clone the repository and install dependencies.
   ```bash
   git clone <this-repo-url>
   cd trip-guardian
   npm install
   ```
2. Create a `.env` file in the project root with at least one provider key
   (see the table below for where to get one).
   ```
   GROQ_API_KEY=your_key_here
   GROQ_MODEL=openai/gpt-oss-120b
   ```
3. Start the demo.
   ```bash
   npm run demo
   ```
4. Open `http://localhost:5173`.

## Environment variables

`.env` lives in the project root and is read by `src/agent/config.ts`. Real
process environment variables always win over the file.

| Variable | What it does | Required | Default |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | Groq API key, used when the Groq provider is active | Yes, unless using Gemini | none |
| `GROQ_MODEL` | Which Groq model to call | No | `llama-3.3-70b-versatile` |
| `GEMINI_API_KEY` | Google Gemini API key, used when the Gemini provider is active | Yes, unless using Groq | none |
| `GEMINI_MODEL` | Which Gemini model to call | No | `gemini-2.5-flash` |
| `MODEL_PROVIDER` | Force `groq` or `gemini` when both keys are present | No | picks Groq if it has a key, else Gemini, else Groq (so the missing key error names one provider) |

Get a free Groq key at console.groq.com. No card required. Set
`GROQ_MODEL=openai/gpt-oss-120b`: it is a reasoning model and returns its
working in a `reasoning` field, which is exactly what the visible trace in
the demo UI shows. `llama-3.3-70b-versatile` is faster and has a higher token
allowance, but it returns no reasoning text and is noticeably sloppier in
practice (it has invented option ids and left slots unfilled while reporting
success). The tools reject invalid calls either way, so the budget stays
sound, but the trace is much weaker with it.

## Using the demo

Open the page and it starts on a setup step: pick a trip length, 1 to 4 days,
and a total budget in whole rupees. Everything after that is arithmetic over
the local catalogue, run before the agent is ever involved. If the budget
cannot cover a viable trip at that length, nothing is built. Instead you are
told the minimum budget that would work, so you never see a broken trip.

Once a trip is built you land on two pages, Plan and Studio.

**Plan** shows the day by day itinerary, the per category budget allocation,
and the split rule that produced it. Nothing moves here.

**Studio** is where a disruption is fired. A row of buttons fires a named
scenario against the trip. Buttons for scenarios that do not apply to your
specific trip (for example a scenario that needs a stay, on a 1 day trip with
no stay booked) are shown disabled, with the reason on hover, rather than
hidden or silently broken.

You can also type into the chat box instead of clicking a scenario button:
describe a disruption in plain language ("the hotel just cancelled") or point
out something the agent missed ("Day 2 Morning is still empty"), and the
agent responds in the same live trace.

**Reset trip** puts the itinerary and budget back to how you configured them,
so a scenario can be run again from the same starting point.

## Scripts

| Script | What it does | Needs an API key |
| --- | --- | --- |
| `npm run world` | Prints the starting trip state | No |
| `npm run tools-demo` | Drives the four tools through a fixed script | No |
| `npm run agent-demo -- --list` | Lists the available scenarios | No |
| `npm run agent-demo -- <scenario-id>` | Runs the agent against one scenario in the terminal | Yes |
| `npm run verify-scenario -- <id>` | Checks a scenario's arithmetic offline | No |
| `npm run verify-trips` | Checks trip building at 1 to 4 days and several budgets | No |
| `npm run demo` | Starts the browser demo UI on `http://localhost:5173` | Yes |
| `npm run ui-harness` | Serves the same UI driven by a scripted stub instead of a model, on `http://localhost:5174` | No |
| `npm run typecheck` | `tsc --noEmit` | No |
| `npm run build` | `tsc --noEmit` (no build step, this project runs on `tsx`) | No |

`verify-trips`, `tools-demo`, `world`, `ui-harness` and `verify-scenario` all
run fully offline, so the project can be evaluated end to end without an API
key at all.

## How it works

The loop is sense, decide, act. A disruption fires, the agent is told what
broke, and it repeats a cycle of reasoning and tool calls until it reports.

The four tools (`search_alternatives`, `rebook_slot`, `reallocate_budget`,
`notify_user`) are described to the model only as function declarations. The
model can only ask for one by name, it never touches state directly. Every
call is validated and executed by real server side tools that own all
validation, so nothing the model sends can bypass a budget rule.

State is immutable and the budget is never written by hand: it is always
recomputed from the itinerary, so spent, remaining and totals can never drift.
A rejected call returns a structured reason and, where relevant, the exact
rupee shortfall, and that gets fed straight back to the model so it can adapt
on the next turn.

The loop also checks the agent's own honesty: it verifies the final report
against the actual state of the trip. Leaving a slot empty is allowed if the
report says so. Claiming a booking that was never made is not. A run that
cannot be reconciled ends as `reported_with_discrepancy` instead of a clean
success.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detail behind all of this.

## Project structure

```
src/
  data/
    types.ts          every type in the world (Option, TripState, Budget, Disruption)
    world.json         the handmade mock dataset for Jaipur
    disruptions.json    the catalogue of events that can be fired
    scenarios.json      named sets of disruptions to fire before a run
  world/
    loader.ts          reads and validates the JSON, builds and recomputes TripState
    slots.ts           how many days a trip can run for, and which slots it uses
    trip.ts            builds a trip from days and budget: the split rule, headroom, feasibility
    state.ts           the immutability rule and the helpers that enforce it
    printer.ts         pretty prints the itinerary, budget and option catalogue
    money.ts           whole rupee helpers and INR formatting
  tools/
    search.ts          search_alternatives, read only
    rebook.ts          rebook_slot
    reallocate.ts      reallocate_budget
    notify.ts          notify_user, read only
    types.ts           the ToolResult shape every tool returns
    format.ts           turning tool results into console output
    index.ts            the four tools in one import
  events/
    engine.ts          loads disruptions and applies them to the world
    scenarios.ts       named sets of disruptions to fire before a run
    applicability.ts   resolves a disruption against the live itinerary
  agent/
    config.ts          reads API keys from the environment, picks the provider
    declarations.ts    the four tools described to the model as function declarations
    executor.ts        validates model arguments, calls the real tools
    prompts.ts         the system instruction and the opening context
    model.ts           the small interface the loop needs from a model
    gemini.ts          the Gemini provider
    groq.ts            the Groq provider, OpenAI wire format, plain fetch
    providers.ts       picks between the two, the loop cannot tell which is running
    errors.ts          turns quota and auth failures into a plain fix
    loop.ts            the reasoning loop for a scripted scenario run
    chatDeclarations.ts the extra apply_disruption tool chat needs
    chatTools.ts        dispatches chat tool calls to the real executor
    chatLoop.ts          the separate turn loop used by free form chat
    trace.ts            the visible reasoning trace
  server/
    server.ts          node:http, serves the page and streams a run over SSE
    session.ts         the one trip the demo server looks after, and its reset
    views.ts           turns World and TripState into the JSON the page draws
web/
  index.html           two pages in one document, Plan and Studio
  styles.css           the visual styling
  app.js               subscribes to the stream and redraws, no dependencies
scripts/
  show-world.ts        npm run world
  tools-demo.ts        npm run tools-demo
  agent-demo.ts        npm run agent-demo
  verify-scenario.ts   npm run verify-scenario
  verify-trips.ts      npm run verify-trips
  serve.ts             npm run demo
  ui-harness.ts        npm run ui-harness, drives the UI with no model
```

## A note on the data

The travel world is a curated, handmade mock dataset for Jaipur, not scraped
from any real booking source. That is deliberate. A fixed, controllable
dataset makes the demo repeatable, every option, price and closure is known
in advance, so the thing actually being tested is the agent's reasoning, not
the reliability of some external API. Wiring up real booking providers would
have turned this into an integration project instead of an agent one.

## Limits and known behaviour

Trips are capped at 4 days because the dataset is handmade and only carries
curated Jaipur options out that far. Longer trips would need filler data, so
the UI states the cap and refuses anything past it.

Groq's free tier caps tokens per minute and per day. A reasoning model in a
growing conversation can hit the per minute ceiling, and the provider reads
the wait Groq asks for and retries automatically. If you see a rate limit
error, it names the limit Groq reported and suggests waiting, switching
models, or checking usage at console.groq.com/settings/limits.

In practice, no scenario ever produces a live rejection in the demo UI.
Cutting spend is always legal: swapping down to a cheaper option can never
push a category further over its allocation. So for any repairable trip there
is an ordering (cut spend first, then reallocate, then book) that reaches a
valid end state with zero refusals, and a model that reasons through the
whole plan before its first mutating call finds that ordering. The
reject-and-adapt path (a tool actually refusing a call, and the agent
recovering from it) is real and always available to the agent, but the only
place it is proven deterministically is the offline harness,
`npm run tools-demo`.

## Security note

API keys are read server side only, in `src/agent/config.ts`, and the agent
runs inside the server process. A key is never sent to the browser, never put
into a stream event, and never printed. `.env` is gitignored.
