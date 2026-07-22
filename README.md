# Trip Guardian

Autonomous travel agent that defends your itinerary and budget in real time.

A traveller lands in Jaipur with a fixed plan and a fixed budget. When a
disruption hits (an activity is cancelled, a price spikes, a venue closes), Trip
Guardian reasons about the tradeoff, rebooks, reallocates the budget across
categories, and reports what it did.

Built for a hackathon, Track A (Agentic AI).

## Status

Prompts 1, 2 and 3 of 4 are done.

- **Prompt 1, the mock world.** A small handmade JSON dataset. No external data
  source, no booking API.
- **Prompt 2, the tools and the disruption engine.** The four functions the agent
  calls, plus the events it reacts to. No AI, these are the hands.
- **Prompt 3, the autonomous agent.** A Gemini driven reasoning loop that reads
  the damage, decides for itself what to do, calls the real tools, adapts when
  they refuse it, and reports the tradeoff it made.

Prompt 4 adds a thin demo UI.

## Run it

```bash
npm install
npm run world                        # print the starting trip state
npm run tools-demo                   # drive the tools through a fixed script, no AI
npm run agent-demo -- --list         # show the scenarios
npm run agent-demo -- <scenario-id>  # let the agent loose on one
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

Ad hoc combinations work too: `npm run agent-demo -- -d d1,d4`.

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
scripts/
  show-world.ts       npm run world
  tools-demo.ts       npm run tools-demo
  agent-demo.ts       npm run agent-demo
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
