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
 * one part of one day (a hotel booking, a two day local cab). A 2 day trip ends
 * after Day 2 Afternoon, when the traveller heads home, so there is no
 * "Day 2 Evening" slot.
 */
export type TimeSlot =
  | "Day 1 Morning"
  | "Day 1 Afternoon"
  | "Day 1 Evening"
  | "Day 2 Morning"
  | "Day 2 Afternoon"
  | "Trip";

/** Day slots in the order they happen, with the spanning slot last. */
export const TIME_SLOTS: readonly TimeSlot[] = [
  "Day 1 Morning",
  "Day 1 Afternoon",
  "Day 1 Evening",
  "Day 2 Morning",
  "Day 2 Afternoon",
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
 * A single disruption event. The catalogue of concrete events lives in
 * src/data/disruptions.json so they can be fired on demand.
 *
 * Which fields matter depends on kind:
 *   - "activity_cancelled": optionId is the booked activity that is off. It is
 *     marked unavailable and dropped from the itinerary, leaving the slot empty.
 *   - "venue_closed": optionId is the option whose venue shut. It is marked
 *     unavailable whether or not it was booked, so it can also kill a fallback
 *     the agent was counting on.
 *   - "price_spike" and "price_drop": optionId plus newPrice, the new integer
 *     INR price. A spike can push a category over its allocation.
 */
export interface Disruption {
  id: string;
  kind: DisruptionKind;
  /** The option this hits. Present for every kind we currently model. */
  optionId: string;
  /** The slot affected, when the disruption is about a slot in the plan. */
  timeSlot?: TimeSlot;
  /** Price spikes only: the new whole rupee price. */
  newPrice?: number;
  /** Traveller facing sentence, for example "Chokhi Dhani is fully booked tonight." */
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
