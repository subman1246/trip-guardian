# Trip Guardian

Autonomous travel agent that defends your itinerary and budget in real time.

A traveller lands in Jaipur with a fixed plan and a fixed budget. When a
disruption hits (an activity is cancelled, a price spikes, a venue closes), Trip
Guardian reasons about the tradeoff, rebooks, reallocates the budget across
categories, and reports what it did.

Built for a hackathon, Track A (Agentic AI).

## Status

Prompt 1 of 4 is done: **the mock world**. The travel world is a small handmade
JSON dataset, there is no external data source and no booking API. The agent
reasoning that operates on this world arrives in prompt 3.

## Run it

```bash
npm install
npm run world       # load the world and print the starting trip state
npm run typecheck   # tsc --noEmit
```

## Layout

```
src/
  data/
    types.ts       every type in the world (Option, TripState, Budget, Disruption)
    world.json     the handmade mock dataset for Jaipur
  world/
    loader.ts      reads and validates the JSON, builds and recomputes TripState
    printer.ts     pretty prints the itinerary, the budget and the option catalogue
    money.ts       whole rupee helpers and INR formatting
scripts/
  show-world.ts    npm run world, the verification script
```

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
