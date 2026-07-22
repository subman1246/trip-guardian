# Trip Guardian

Autonomous travel agent that defends your itinerary and budget in real time.

A traveller lands in Jaipur with a fixed plan and a fixed budget. When a
disruption hits (an activity is cancelled, a price spikes, a venue closes), Trip
Guardian reasons about the tradeoff, rebooks, reallocates the budget across
categories, and reports what it did.

Built for a hackathon, Track A (Agentic AI).

## Status

All four prompts are done.

- **Prompt 1, the mock world.** A small handmade JSON dataset. No external data
  source, no booking API.
- **Prompt 2, the tools and the disruption engine.** The four functions the agent
  calls, plus the events it reacts to. No AI, these are the hands.
- **Prompt 3, the autonomous agent.** A Gemini driven reasoning loop that reads
  the damage, decides for itself what to do, calls the real tools, adapts when
  they refuse it, and reports the tradeoff it made.
- **Prompt 4, the demo UI.** A thin server that streams a live run to a plain
  HTML page, plus `no-donor-left`, a scenario where every direct repair is
  arithmetically refused.

## Run it

```bash
npm install
npm run world                        # print the starting trip state
npm run tools-demo                   # drive the tools through a fixed script, no AI
npm run agent-demo -- --list         # show the scenarios
npm run agent-demo -- <scenario-id>  # let the agent loose on one
npm run verify-scenario -- <id>      # check a scenario's arithmetic, no AI
npm run demo                         # the browser UI on http://localhost:5173
npm run typecheck                    # tsc --noEmit
```

`agent-demo` needs an API key for one of two providers. Put it in `.env` in the
project root:

```
# Groq, free tier, no card required
GROQ_API_KEY=your_key_here
GROQ_MODEL=openai/gpt-oss-120b

# or Google Gemini
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash

# optional, force one when both keys are present
MODEL_PROVIDER=groq
```

`.env` is gitignored. Keys are read from the environment only, are never
printed, and never appear in a trace.

**Which provider runs:** `MODEL_PROVIDER` wins if set. Otherwise whichever
provider has a key, preferring Groq. If neither has one, the error names Groq so
there is a single thing to fix.

**Which Groq model:** `openai/gpt-oss-120b` gives by far the best traces. It is a
reasoning model, so it returns its working in a `reasoning` field, and that
becomes the visible chain of thought in the trace. `llama-3.3-70b-versatile` is
faster and has a higher token allowance, but it returns no reasoning text and is
noticeably sloppier (it has invented option ids and left slots unfilled while
reporting success). The tools reject the invalid calls either way, so the budget
stays sound, but the trace is much weaker.

Groq's free tier caps tokens per minute, and a reasoning model plus a growing
conversation hits that ceiling. The provider reads the wait Groq asks for and
retries automatically, printing a line so the run does not look frozen.

## Scenarios

| id | what it proves |
| --- | --- |
| `cancelled-tour` | The warm up. One slot empties, one option closes. |
| `cab-spike` | A category goes over. There is a cheap fix inside it. |
| `transport-squeeze` | **The forced tradeoff.** No amount of rebooking alone can fix it, the agent has to reallocate from another category first. |
| `evening-collapse` | A cascade with no clean answer. A slot has nothing left to book, so the agent has to accept a gap and say so. |
| `double-hit` | Two independent breaks at once. It has to notice both. |
| `no-donor-left` | **The forced refusal.** The only replacement for the empty slot busts activity by Rs 700, and the whole trip can only lend Rs 550, so no rebooking and no reallocation works until the agent spends less somewhere first. |

Ad hoc combinations work too: `npm run agent-demo -- -d d1,d4`.

`npm run verify-scenario -- <id>` checks a scenario's arithmetic offline, with no
AI and no network: whether a straightforward first move exists (which would mean
no refusal ever fires) and whether a real path to a repaired trip exists at all.

### On forcing a refusal

`no-donor-left` is built so that every direct repair is refused. The verifier
proves it: rebooking the balloon is refused for `category_would_go_negative`,
and reallocating the Rs 700 is refused for `insufficient_allocation` from either
donor, because transport has Rs 450 spare and stay has Rs 100. Even emptying both
donors completely yields Rs 550 against a Rs 700 gap.

What that does **not** do is guarantee the refusal appears in a live trace, and it
is worth being precise about why. Cutting spend is always legal: swapping down to
a cheaper option can never push a category further over. So for any repairable
trip there exists an order (every cut first, then the reallocations, then the new
booking) that reaches a valid end state with zero refusals. An agent that plans
the whole sequence before acting will find that order and never be refused. With
`openai/gpt-oss-120b`, which reasons at length before its first mutating call,
that is exactly what happens: it works out that the donors are short, downgrades
the cab, then reallocates, then books.

Forcing a refusal on camera would need a tool change, not a data change, and the
tools are deliberately left alone. The offline harness (`npm run tools-demo`,
step 8) is where the reject-and-adapt path is demonstrated deterministically.

## The demo UI

```bash
npm run demo                         # http://localhost:5173
```

A thin page for watching one run. Three regions: the itinerary by time slot, the
per category budget bars, and the reasoning trace streaming in live. A row of
buttons fires any scenario, and a reset button puts the trip back to how it was
booked, so a scenario can be demoed over and over without restarting.

**The key never reaches the browser.** The agent runs in the server process.
`src/agent/config.ts` reads the key from the environment there, and it is never
put into a response, a stream event or a served file. The page has no model
client in it, and the only origin it talks to is its own server.

Events reach the page over Server Sent Events. The agent already reports through
`AgentObserver`, which is a one way stream of events with nothing coming back
from the browser in between, so SSE fits with no dependency and no protocol
upgrade. Observer hooks are synchronous and cannot wait, so they push onto a
queue and a separate pump drains it with a gap between events, which is what
makes a run readable at human speed rather than arriving in one burst.

Each run resets to the trip as booked before firing, so a scenario behaves the
same on the tenth demo as on the first.

## Layout

```
src/
  data/
    types.ts          every type in the world (Option, TripState, Budget, Disruption)
    world.json        the handmade mock dataset for Jaipur
    disruptions.json  the catalogue of events that can be fired
  world/
    loader.ts         reads and validates the JSON, builds and recomputes TripState
    state.ts          the immutability rule, and the helpers that enforce it
    printer.ts        pretty prints the itinerary, budget and option catalogue
    money.ts          whole rupee helpers and INR formatting
  tools/
    search.ts         search_alternatives, read only
    rebook.ts         rebook_slot
    reallocate.ts     reallocate_budget
    notify.ts         notify_user, read only
    types.ts          the ToolResult shape every tool returns
    format.ts         turning tool results into console output
    index.ts          the four tools in one import
  events/
    engine.ts         loads disruptions and applies them to the world
    scenarios.ts      named sets of disruptions to fire before a run
  agent/
    config.ts         reads API keys from the environment, and picks the provider
    declarations.ts   the four tools described to the model as function declarations
    executor.ts       validates model arguments, calls the REAL tools
    prompts.ts        the system instruction and the opening context
    model.ts          the small interface the loop needs from a model
    gemini.ts         the Gemini provider
    groq.ts           the Groq provider, OpenAI format, plain fetch
    providers.ts      picks between them, the loop cannot tell which is running
    errors.ts         turns quota and auth failures into a plain fix
    loop.ts           the reasoning loop itself
    trace.ts          the visible reasoning trace
  server/
    server.ts         node:http, serves the page and streams a run over SSE
    session.ts        the one trip the demo server looks after, and its reset
    views.ts          turns World and TripState into the JSON the page draws
web/
  index.html          the three panels and the scenario buttons
  styles.css          styling, tuned for legibility in a screen recording
  app.js              subscribes to the stream and redraws, no dependencies
scripts/
  show-world.ts       npm run world
  tools-demo.ts       npm run tools-demo
  agent-demo.ts       npm run agent-demo
  verify-scenario.ts  npm run verify-scenario
  serve.ts            npm run demo
```

## How the agent works

The model never touches state. It can only ask, by name, for one of the four
tools. Every request lands in `executor.ts`, which checks the arguments and
hands it to the real prompt-2 tool. So every rule those tools enforce still
holds no matter what the model sends, and the budget invariants cannot be
argued around.

The flow of one turn:

1. The loop sends the conversation to Gemini.
2. Gemini replies with reasoning text and zero or more function calls.
3. Each call is validated and executed against the real tools. The state is
   rebound to whatever the tool returned.
4. The result, success or rejection, goes back as a `functionResponse`.
5. Repeat until the agent calls `notify_user`, or the turn cap is hit.

Rejections are the interesting part. When a rebooking would break a category,
the tool refuses and says how many rupees short it is. That refusal is fed
straight back, and the agent has to work out for itself that it can move
allocation in and try again. That path is not scripted anywhere.

Bad arguments from the model are treated the same way: they come back as an
ordinary rejection with an explanation, so a malformed call costs a turn rather
than crashing the run.

## State discipline

State is **immutable**. No tool and no disruption edits a TripState or a World in
place, they return new ones. That gives the agent a free undo (keep the old
reference) and a clean before/after for the demo.

Derived money is never written by hand. Every change to the itinerary or to the
allocations goes back through `computeBudgetState`, so spent, remaining and
totals can never drift away from the itinerary.

Tools never throw for an expected problem and never print. They return a
`ToolResult`, which is either a success with details or a failure with a machine
readable reason. A failure returns the unchanged state, so a rejected call can
never damage the trip.

## Conventions

These hold for the whole project.

- Node with TypeScript, ES modules, strict mode. Minimal dependencies.
- Money is Indian Rupees, stored as plain integers (whole rupees, never floats).
- Time slots are human readable strings ("Day 1 Morning"), never real timestamps.
- No em-dashes anywhere in code, comments, output or docs.
- Secrets live in `.env`, which is gitignored, and never appear in code.

## The world

One city (Jaipur), a 2 day trip, 15 bookable options. The trip runs from Day 1
Morning to Day 2 Afternoon, so there is no Day 2 Evening slot. Options that cover
the whole visit (a hotel, a two day cab) sit in the spanning `Trip` slot.

## The budget

Total 15,000 INR, split so the starting plan fits with room for the agent to
manoeuvre when something breaks.

| Category  |  Allocated | Starting spend | Headroom |
| --------- | ---------: | -------------: | -------: |
| transport |      4,000 |          3,550 |      450 |
| stay      |      5,000 |          2,800 |    2,200 |
| activity  |      6,000 |          4,100 |    1,900 |
| **Total** | **15,000** |     **10,450** |    4,550 |

The headroom is deliberate. Some repairs fit inside a category, others (swapping
up to the heritage suite, or adding the balloon ride) cost more than one category
has left, which forces the agent to reallocate across categories or trade down
elsewhere. That is the decision we want to see it make.
