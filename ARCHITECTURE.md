# Architecture

This is the detail behind the "How it works" section of the README: the
reasoning loop, the tool boundary, the state discipline, and the honesty
check that verifies the agent's own report.

## Sense, decide, act

One scripted scenario run (`npm run agent-demo`, or firing a scenario in the
demo UI) is driven by `runAgent` in `src/agent/loop.ts`:

1. One or more disruptions fire against the world (`src/events/engine.ts`),
   producing a `DisruptionOutcome[]`. This is the sense step, and it happens
   before the model is ever called.
2. `buildOpeningMessage` (`src/agent/prompts.ts`) describes the trip, the
   budget and the damage, and that becomes the first message in the
   conversation.
3. Each turn, the loop calls `model.generate(contents)`. The model replies
   with reasoning text and zero or more function calls. This is the decide
   step.
4. Every function call is validated and executed by `executeToolCall` in
   `src/agent/executor.ts`, which owns argument checking and then hands off
   to the real tool in `src/tools/`. This is the act step. The result, success
   or rejection, is appended to the conversation as a `functionResponse` and
   the loop goes round again.
5. The loop ends when the model calls `notify_user` and the report is
   reconciled against the trip, or when the turn cap (14) is hit, or when the
   model stops calling tools and stops reporting after being nudged twice.

Chat (`src/agent/chatLoop.ts`) is a second, deliberately separate loop with
the same reason, call tools, feed results back shape, used for free form
messages in the demo UI instead of a scripted scenario. It reuses the same
tools, the same `TripState`/`World` types and the same two providers, but
does not force every reply into a traveller facing report the way
`runAgent` does, and it trims its own history so a long conversation cannot
grow the token cost of every future turn.

## The tool boundary

The model is only ever shown four tools as function declarations
(`src/agent/declarations.ts`): `search_alternatives`, `rebook_slot`,
`reallocate_budget`, `notify_user`. It cannot edit a `TripState` or a `World`
directly, it can only ask for one of these by name with some arguments.

`src/agent/executor.ts` is the only bridge between what the model asks for
and what actually happens. It validates every argument (right type, right
enum, whole rupees where money is expected) and, once satisfied, calls the
same tool function that `npm run tools-demo` calls directly with no model
involved at all. A malformed call, an unknown option id, or an argument of
the wrong shape comes back as an ordinary rejection with an explanation, not
a crash, so one bad call costs a turn rather than the whole run.

Because every mutation goes through this one path, every invariant those
tools enforce holds no matter what the model sends. There is no way for a
model to "argue around" a budget rule from the outside.

## Structured rejections

Each tool (`src/tools/rebook.ts`, `src/tools/reallocate.ts`, `src/tools/search.ts`,
`src/tools/notify.ts`) returns a `ToolResult`, never throws for an expected
problem, and never prints. A rejection carries a machine readable `reason`
(for example `category_would_go_negative` or `insufficient_allocation`) and,
where relevant, an exact rupee `shortfall`. That structure, not prose, is what
the agent sees, and it is what lets it adapt: a rejected rebooking because a
category would go negative tells the model precisely how many rupees short
it is, so the next reasonable move is calling `reallocate_budget` for at
least that amount, and the tool descriptions in `declarations.ts` say so
directly. None of that adaptation is scripted; the tools only ever describe
the shape of the problem, not the fix.

One rule worth calling out in `rebook.ts`: a swap into an already overspent
category is allowed as long as it strictly improves the overspend, even
while it stays negative. Without that, a category pushed over by a price
spike would be stuck, since no single swap inside it could close the whole
gap in one move, and the agent needs to be able to downgrade its way back to
solvency step by step.

## Immutable state

Nothing in this project edits a `TripState` or a `World` in place
(`src/world/state.ts`). Every tool and every disruption takes the current one
and returns a new one. That gives the loop a free undo (the caller can always
keep the old reference) and means a rejected call can never leave partial
damage behind, since the state returned on a rejection is the exact object
that came in.

Money is never written by hand. `withItinerary` and `withAllocations`
(`src/world/state.ts`) always run the result back through
`computeBudgetState` (`src/world/loader.ts`), so spent, remaining and totals
are recomputed from the itinerary and the allocations rather than tracked as
separate numbers that could drift out of sync.

## The honesty check

The loop does not just trust the agent's final report. When `notify_user`
lands, `openProblems()` in `loop.ts` checks two things against the actual
`TripState`: whether every slot a disruption emptied is either filled again
or explicitly admitted as left empty in the report text, and whether every
category's `remaining` is non negative.

Leaving a slot empty is a legitimate outcome; sometimes nothing can fill it
and the honest answer is to say so. What is not allowed is a report that
does not admit it, or a category that is still over its allocation. If a
problem is found, the agent is sent back with the specific list of what does
not match and given another chance (`buildDiscrepancyMessage`, up to 2
nudges). If it still cannot reconcile, the run ends with
`stopped: "reported_with_discrepancy"` rather than a clean success, so a
false report is never presented as a normal ending.

## Providers

`src/agent/providers.ts` picks between `src/agent/gemini.ts` and
`src/agent/groq.ts` based on `MODEL_PROVIDER`, or by which API key is
present (see the README for the exact selection order). Both implement the
same small `AgentModel` interface (`src/agent/model.ts`), so `loop.ts` and
`chatLoop.ts` cannot tell which one is answering. Groq speaks the OpenAI chat
completions wire format over a plain `fetch` call (no SDK), and its provider
file owns translating the loop's `Content[]` shape to and from OpenAI
messages, including folding reasoning models' separate `reasoning` field
into the trace text when the model said nothing in `content`.

## Server and streaming

`src/server/server.ts` is plain `node:http`. The agent runs inside this
process; the API key is read here by `src/agent/config.ts` and is never put
into a response, a stream event, or a served file. The browser only ever
talks to this server.

A run is reported over Server Sent Events. The loop's `AgentObserver` hooks
are synchronous, so they push events onto a queue and a separate pump drains
it with a small delay between events (`PACING_MS` in `server.ts`), which is
what makes a run readable at human speed in the demo UI rather than arriving
in one burst.
