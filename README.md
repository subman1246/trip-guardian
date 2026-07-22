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
- **Prompt B1, trips you choose.** The 2 day, Rs 15,000 trip is no longer
  hardcoded. You pick 1 to 4 days and a budget, the trip is built from that with
  a documented split rule and a headroom target, an unaffordable budget is
  refused with the minimum that would work, and scenarios that do not apply to
  your trip are disabled with the reason.

## Run it

```bash
npm install
npm run world                        # print the starting trip state
npm run tools-demo                   # drive the tools through a fixed script, no AI
npm run agent-demo -- --list         # show the scenarios
npm run agent-demo -- <scenario-id>  # let the agent loose on one
npm run verify-scenario -- <id>      # check a scenario's arithmetic, no AI
npm run verify-trips                 # check trip building at 1 to 4 days, no AI
npm run demo                         # the browser UI on http://localhost:5173
npm run ui-harness                   # the same UI, driven with no model at all
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
| `no-donor-left` | **The forced refusal.** The only replacement for the empty slot busts activity, and every donor emptied together still cannot cover the gap, so no rebooking and no reallocation works until the agent spends less somewhere first. |
| `any-cancelled-plan` | The same shape as `cancelled-tour`, but written against the slot instead of an option id, so it works on any trip. |
| `any-price-shock` | Local transport and the room both repriced, whatever this trip booked for them. Needs a stay, so not on a 1 day trip. |

Ad hoc combinations work too: `npm run agent-demo -- -d d1,d4`.

### Scenarios and the trip you actually configured

Most scenarios were written against specific option ids. `no-donor-left` needs
a5, s2 and s1 to be exactly where they were. On a shorter or differently built
trip those options may not be booked, or may not exist at that length, and firing
the scenario would be meaningless.

So every scenario is checked against the current trip before it is offered. The
UI draws the ones that do not apply **disabled, with the reason beside them and
on hover**, rather than hiding them, and the server refuses to run one anyway so
a stale page cannot half fire it. On a 1 day trip that reads:

```
APPLIES  cancelled-tour
BLOCKED  cab-spike           "Private Cab with Driver (1 day)" is not booked on this trip, so this would change nothing.
BLOCKED  evening-collapse    Day 1 Evening is not part of a 1 day trip, so "Chokhi Dhani Village Dinner" cannot be booked.
BLOCKED  no-donor-left       Day 2 Morning is not part of a 1 day trip, so "Hawa Mahal and Jantar Mantar Walk" cannot be booked.
BLOCKED  double-hit          A 1 day trip sleeps nowhere, so "Hotel Pearl Palace (Heritage Room)" is not offered on it.
APPLIES  any-cancelled-plan
BLOCKED  any-price-shock     This trip has no stay booked for the whole trip.
```

Where a disruption can be written generically it is. A disruption may name a
**target** (a time slot and a category) instead of an option id, and it then
lands on whatever this trip has booked there: `g1` hits the Day 1 Afternoon
activity, `g2` the local transport, `g3` the room. Price events on a target carry
a factor rather than a price, since they cannot know in advance what they will
land on.

A target only ever matches a booking in the same slot playing the same role. It
is never retargeted onto something unrelated: if that slot and category holds no
booking, the scenario is reported as not applicable instead of being moved. The
finely tuned scenarios keep their hardcoded ids on purpose, because their whole
value is in arithmetic that only works against those exact options.

`npm run verify-scenario -- <id>` checks a scenario's arithmetic offline, with no
AI and no network: whether a straightforward first move exists (which would mean
no refusal ever fires) and whether a real path to a repaired trip exists at all.

`npm run verify-trips` is the offline proof for trip building, also with no AI
and no network. It checks that every slot at every length has at least two open
options, that trips build at 1, 2, 3 and 4 days across several budgets with the
allocations summing exactly and the budget matching a fresh recomputation, that
the starting itinerary always leaves the headroom, that a budget one rupee below
the minimum is refused while the minimum itself builds, that scenario
applicability matches what firing the scenario actually does, and that
`no-donor-left` still forces a refusal on the constructed trip. It exits non zero
if anything fails.

### On forcing a refusal

`no-donor-left` is built so that every direct repair is refused. The verifier
proves it: rebooking the balloon is refused for `category_would_go_negative`,
and reallocating the shortfall is refused for `insufficient_allocation` from
either donor. On the world file's own 4,000 / 5,000 / 6,000 split that is Rs 550
of donor money against a Rs 700 gap. On the trip the split rule builds for 2 days
and Rs 15,000 it is Rs 530 against Rs 680, checked by `npm run verify-trips`
rather than assumed, since the allocations are now computed rather than typed.

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

**Two pages, one document.**

**Plan** is the calm page. Days, budget, the 4 day cap explained, the feasibility
answer, and then the constructed trip: the day by day plan, the per category
allocation table, and the split rule in plain English. Nothing moves here.

**Studio** is the page that gets screen recorded. The itinerary by day and slot,
the per category budget bars, and the reasoning trace. A row of buttons fires any
scenario that applies to the trip, and a reset button puts the trip back to how
**you** configured it, so a scenario can be demoed over and over.

Moving between them is a transition, not a navigation: both pages are mounted the
whole time, Plan lifts away as Studio rises, and going back reverses it.

### The visual direction

Obsidian and gold. A deep green black ground, warm rather than the usual blue
black dashboard, with antique gold for structure and parchment for text. A serif
carries the display headings and, more importantly, the agent's own reasoning. A
mono carries every number and every tool call, so money always reads as data. The
three budget categories borrow from Jaipur itself: a faded indigo for transport, a
terracotta for stay, a pistachio for activity, and a vermilion for danger.

It is tuned for a compressed screen recording, so nothing depends on subtle tone.
Body text sits above 8:1 against its panel, the gold above 9:1, the danger
vermilion above 6:1, and there is no thin text over a busy background anywhere.

### What moves, and why

Motion is reserved for things that changed, because the trace is the star and
decoration must not compete with it.

- **Budget bars slide** when the agent rebooks or reallocates. The bars are built
  once and updated in place rather than redrawn, which is the only reason the
  transition can run at all.
- **A category going negative** turns the bar vermilion, raises an `OVER` badge
  and shakes once. Once only, so the alarm never becomes wallpaper.
- **A rebooked slot** sweeps gold and settles. **A day slot going empty** turns
  red and keeps a slow pulse, because a hole in the trip should stay loud.
- **Turns group the trace.** A turn opens in a thinking state with a pulsing
  indicator, and the first thing that arrives for it resolves that state. There
  is no spinner: while the agent is thinking, the waiting is the content.
- **Reasoning, tool calls, ACCEPTED and REJECTED** are four visually distinct
  things. A refusal gets a vermilion frame, a filled `REJECTED` pill and a flash
  as it lands, so it can never be mistaken for a success.
- **The report card** arrives as its own moment in gold, and the **discrepancy
  warning** (the agent's report not matching the trip it handed back) is the
  loudest thing the page can draw. Neither is softened.

Timing is untouched: the server's per event pacing is what it always was.

### Driving the UI with no model

```bash
npm run ui-harness                   # http://localhost:5174
```

`scripts/ui-harness.ts` serves the same page with no model, no network and no API
key, so the UI can be built and checked while the provider quota is exhausted. It
speaks the same event names in the same order at the same pacing, and it reports
itself as `offline stub / no model called` in the provider chip so a screenshot
taken against it is self labelling.

Every tool call it makes goes through the real prompt 2 tools, so every ACCEPTED,
every REJECTED, every shortfall and every resulting trip view is genuinely
computed. The disruptions are the real engine and the trip comes from the real
`Session`. **Only the prose between the calls is canned narration, and it is not
model output.** Add `&discrepancy=1` to `/api/run` to exercise the discrepancy
warning without waiting for an agent to actually misreport.

The harness never touches `src/server/server.ts`, so the production server and
the SSE event contract are exactly as they were.

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
    slots.ts          how many days a trip can run for, and which slots it uses
    trip.ts           builds a trip from days and budget: the split rule, the
                      headroom target and the feasibility check
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
    applicability.ts  resolves a disruption against the live itinerary, and works
                      out whether a scenario means anything on the current trip
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
  index.html          two pages in one document: Plan, and the Studio
  styles.css          obsidian and gold, tuned for a compressed screen recording
  app.js              subscribes to the stream and redraws, no dependencies
scripts/
  show-world.ts       npm run world
  tools-demo.ts       npm run tools-demo
  agent-demo.ts       npm run agent-demo
  verify-scenario.ts  npm run verify-scenario
  verify-trips.ts     npm run verify-trips
  serve.ts            npm run demo
  ui-harness.ts       npm run ui-harness, drives the UI with no model
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

One city (Jaipur), 29 bookable options, and a trip of **1 to 4 days** that the
traveller chooses.

Every day has a Morning and an Afternoon. Every day except the last also has an
Evening, because the traveller heads home after lunch on the final day. So a 2
day trip ends at Day 2 Afternoon and a 4 day trip ends at Day 4 Afternoon.
Anything that spans the whole visit (the hotel, the local transport) sits in the
`Trip` slot. Nights are one fewer than days, so a 1 day trip is a day trip out of
Delhi with no stay at all.

**The 4 day cap is real.** The dataset is handmade and only carries curated
Jaipur options out to Day 4. Anything longer would be filler, so the UI states
the cap and refuses it.

**Every slot has at least two open options** in every category it books, so a
disruption always leaves an alternative. That is not an aspiration, it is checked
programmatically by `npm run verify-trips`.

**Options that scale.** A hotel is charged per night and local transport that
runs all visit is charged per day, so a 4 day trip cannot pay the 2 day price for
either. `world.json` is written for the reference trip (2 days, 1 night) and
carries the rate each price is built from. `src/world/trip.ts` rebuilds those
options at the requested length, so a 3 night stay at the Pearl Palace costs
Rs 8,400 rather than Rs 2,800, and the reference trip comes out byte identical.

## Building a trip from what you asked for

The UI opens with a setup step: a number of days (1 to 4, enforced) and a total
budget in whole rupees. Everything from there is arithmetic over the local
catalogue, run before the agent exists.

### The split rule

1. Work out the **cheapest bookable plan** for that many days: for each thing the
   trip must book (the arrival, the stay, the local transport, one activity per
   remaining day slot), take the cheapest open option. Add up what that costs per
   category. Those are the **floors**.
2. The **surplus** is the total budget minus the sum of the floors. It is the
   discretionary money, the part that buys a nicer trip.
3. Every category gets its floor first, so it can always afford its own bookings.
   The surplus is then shared out **20% to transport, 40% to stay, 40% to
   activity**. Transport moves you around and is worth the least extra spend, a
   bed and the things you came to do are worth the most. On a 1 day trip there is
   no stay, so its share is spread over the other two.
4. Transport and stay take the whole rupee floor of their share and activity
   takes the remainder, so the three allocations sum to the total exactly.

### The headroom target

The starting itinerary must leave **at least 20% of the total budget** and **at
least 5% of every category's allocation** unspent. The builder then buys the
nicest trip that still respects both ceilings.

The headroom is the whole point. A trip booked up to its allocations cannot
absorb a price spike, cannot lend between categories, and turns every disruption
into an unfixable one. Some repairs fit inside a category, others (swapping up to
the heritage suite, or adding the balloon ride) cost more than one category has
left, which forces the agent to reallocate across categories or trade down
elsewhere. That is the decision we want to see it make.

### The feasibility check, before the agent is ever involved

If the requested budget cannot cover a viable trip, **nothing is built**. The
cheapest bookable plan is priced, the headroom is applied, and the traveller is
told the minimum that would work:

> Rs 5,000 cannot cover a 3 day trip in Jaipur, Rajasthan. The cheapest bookable
> plan for 3 days costs Rs 8,150, and we hold back 20% of the budget as headroom
> so the agent has room to repair things when they break. Raise the budget to at
> least Rs 10,188 for 3 days, or ask for fewer days.

Pure arithmetic, no model involved. The minimums today:

| Days | Cheapest bookable plan | Minimum budget |
| ---: | ---------------------: | -------------: |
|    1 |                  2,450 |          3,063 |
|    2 |                  5,450 |          6,813 |
|    3 |                  8,150 |         10,188 |
|    4 |                 11,000 |         13,750 |

### The default trip

The page opens on 2 days and Rs 15,000, which the split rule builds into the
trip this project was designed around: the Shatabdi in, the Pearl Palace, the
private cab, and the Amber Fort, Chokhi Dhani, Hawa Mahal and block printing
days. Allocations come out at 4,060 transport, 4,920 stay and 6,020 activity,
which spends 10,450 and holds back 4,550.
