/**
 * Trip Guardian: the shape of the world.
 *
 * Everything the agent will later read or mutate is typed here. Later prompts
 * add tools and reasoning on top of these types, so they are meant to be stable.
 *
 * Money rules for the whole project:
 *   - All money is Indian Rupees (INR).
 *   - All money is a plain integer number of whole rupees. No paise, no floats.
 */

/** The three kinds of thing you can spend money on in this world. */
export type Category = "transport" | "stay" | "activity";

/**
 * Human readable time slots. We deliberately avoid real timestamps.
 *
 * "Trip" is a spanning slot for things that cover the whole visit rather than
 * one part of one day (a hotel booking, a multi day local cab).
 *
 * THE SHAPE OF A TRIP. Trips run from 1 to 4 days. Every day has a Morning and
 * an Afternoon. Every day except the last also has an Evening, because on the
 * last day the traveller heads home after lunch. So a 2 day trip ends at Day 2
 * Afternoon (no Day 2 Evening), and a 4 day trip ends at Day 4 Afternoon. Since
 * 4 is the cap, Day 4 is always the last day, which is why there is no
 * "Day 4 Evening" below. src/world/slots.ts turns a trip length into the exact
 * list of slots that trip uses.
 */
export type TimeSlot =
  | "Day 1 Morning"
  | "Day 1 Afternoon"
  | "Day 1 Evening"
  | "Day 2 Morning"
  | "Day 2 Afternoon"
  | "Day 2 Evening"
  | "Day 3 Morning"
  | "Day 3 Afternoon"
  | "Day 3 Evening"
  | "Day 4 Morning"
  | "Day 4 Afternoon"
  | "Trip";

/** Every day slot in the order they happen, with the spanning slot last. */
export const TIME_SLOTS: readonly TimeSlot[] = [
  "Day 1 Morning",
  "Day 1 Afternoon",
  "Day 1 Evening",
  "Day 2 Morning",
  "Day 2 Afternoon",
  "Day 2 Evening",
  "Day 3 Morning",
  "Day 3 Afternoon",
  "Day 3 Evening",
  "Day 4 Morning",
  "Day 4 Afternoon",
  "Trip",
] as const;

/** Every category the budget tracks, in display order. */
export const CATEGORIES: readonly Category[] = ["transport", "stay", "activity"] as const;

/**
 * One bookable thing in the mock world: a train, a hotel, a fort tour.
 * Options are the catalogue. They are never mutated by the agent, the agent
 * mutates the itinerary that points at them.
 */
export interface Option {
  /** Stable id, for example "t1" or "a4". Itinerary items reference this. */
  id: string;
  category: Category;
  /** Name as a traveller would read it. This is what shows up on screen. */
  name: string;
  /** Whole rupees, integer. */
  price: number;
  /** When it happens. Stays and multi day local transport use "Trip". */
  timeSlot: TimeSlot;
  /** One line of colour, shown under the name. */
  description: string;
  /** Stays only: how many nights the price covers. Omitted for other categories. */
  nightsCovered?: number;
  /**
   * Whether this option can still be booked. Absent means available, so the
   * world file does not have to spell it out for every entry. Disruptions flip
   * this to false when a venue closes or an activity is cancelled.
   */
  available?: boolean;
  /**
   * "Trip" slot options only. A hotel is charged per night and local transport
   * that runs for the whole visit is charged per day, so a 4 day trip must pay
   * more for the same thing than a 2 day trip does.
   *
   * The catalogue in world.json is written for the REFERENCE trip, which is 2
   * days and therefore 1 night. `price` is what the option costs on that trip,
   * and `unitPrice` is the rate it is built from. When a trip of another length
   * is constructed, src/world/trip.ts rebuilds the option at
   * `unitPrice * units`, so the reference trip comes out byte identical and
   * every other length is priced honestly.
   */
  scalesPer?: "night" | "day";
  /** Whole rupees for one night or one day. Required when scalesPer is set. */
  unitPrice?: number;
  /**
   * Name with "{n}" where the night or day count goes, used when the option is
   * rebuilt for another trip length. Only needed when the name states a count.
   */
  nameTemplate?: string;
}

/**
 * One committed choice in the plan: "at this time slot, we are doing this option".
 * The category is not stored here, it is looked up from the referenced Option so
 * the two can never disagree.
 */
export interface ItineraryItem {
  timeSlot: TimeSlot;
  optionId: string;
}

/**
 * The fixed budget the traveller gave us: a total, split across categories.
 * Invariant: the three allocations sum exactly to totalINR.
 */
export interface Budget {
  totalINR: number;
  allocations: Record<Category, number>;
}

/** Allocated vs spent for one category. remaining is always allocated - spent. */
export interface CategoryLedger {
  allocated: number;
  spent: number;
  /** Derived. Can go negative if the agent overspends a category. */
  remaining: number;
}

/** The whole budget picture, derived from the budget plus the live itinerary. */
export interface BudgetState {
  totalINR: number;
  totalSpent: number;
  /** Derived. totalINR - totalSpent. */
  totalRemaining: number;
  byCategory: Record<Category, CategoryLedger>;
}

/**
 * The live state the agent reads and mutates. Everything derived (spent,
 * remaining) is recomputed from the itinerary, never edited by hand.
 */
export interface TripState {
  city: string;
  tripLengthDays: number;
  itinerary: ItineraryItem[];
  budget: BudgetState;
}

/**
 * The kinds of trouble (and luck) the world can throw at the traveller.
 * Every kind targets exactly one option, which keeps the engine simple.
 */
export type DisruptionKind =
  | "activity_cancelled"
  | "price_spike"
  | "venue_closed"
  | "price_drop";

/**
 * A generic disruption target: "whatever this trip has booked in this slot for
 * this category". Used instead of a hardcoded option id so a disruption stays
 * meaningful whatever shape the trip is.
 *
 * It resolves against the live itinerary and nothing else, so it can never
 * silently land on an unrelated option: if that slot and category holds no
 * booking, the disruption simply does not apply.
 */
export interface DisruptionTarget {
  timeSlot: TimeSlot;
  category: Category;
}

/**
 * A single disruption event. The catalogue of concrete events lives in
 * src/data/disruptions.json so they can be fired on demand.
 *
 * Exactly one of optionId or target must be set. optionId pins the event to one
 * named option, which is what the finely tuned demo scenarios need. target picks
 * the event up off the current itinerary instead, which is what keeps a scenario
 * meaningful on a trip of any length. src/events/applicability.ts resolves a
 * targeted disruption into a concrete one before the engine ever sees it, so the
 * engine only ever handles an optionId.
 *
 * Which fields matter depends on kind:
 *   - "activity_cancelled": the booked activity that is off. It is marked
 *     unavailable and dropped from the itinerary, leaving the slot empty.
 *   - "venue_closed": the option whose venue shut. It is marked unavailable
 *     whether or not it was booked, so it can also kill a fallback the agent was
 *     counting on.
 *   - "price_spike" and "price_drop": newPrice, the new integer INR price, or
 *     priceFactor for a targeted event where the old price is not known in
 *     advance. A spike can push a category over its allocation.
 */
export interface Disruption {
  id: string;
  kind: DisruptionKind;
  /** The option this hits, when the event is pinned to one. */
  optionId?: string;
  /** The booking this hits, when the event is picked off the live itinerary. */
  target?: DisruptionTarget;
  /** The slot affected, when the disruption is about a slot in the plan. */
  timeSlot?: TimeSlot;
  /** Price events on a pinned option: the new whole rupee price. */
  newPrice?: number;
  /**
   * Price events on a targeted booking: multiply the price it finds. Above 1 for
   * a spike, below 1 for a drop. The result is rounded to whole rupees.
   */
  priceFactor?: number;
  /**
   * Traveller facing sentence, for example "Chokhi Dhani is fully booked
   * tonight." A targeted disruption may write "{option}" where the name of the
   * booking it landed on should go.
   */
  message: string;
}

/** The full mock world as loaded from JSON. */
export interface World {
  city: string;
  /** Always "INR" in this project, kept explicit so the data is self describing. */
  currency: "INR";
  tripLengthDays: number;
  /** The catalogue of everything bookable. */
  options: Option[];
  /** The plan the traveller arrives with, and the plan the agent defends. */
  startingItinerary: ItineraryItem[];
  budget: Budget;
}
