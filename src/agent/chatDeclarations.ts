/**
 * The one extra tool chat needs: apply_disruption.
 *
 * The four prompt-2 tools (search_alternatives, rebook_slot, reallocate_budget,
 * notify_user) only ever touch the ITINERARY and the BUDGET. None of them can
 * make a hotel close or a price change, because in the scripted demo that
 * damage always happens before the agent is ever invoked. Chat breaks that
 * assumption: a traveller can say "the hotel just cancelled" mid conversation,
 * and the agent needs a way to make that real.
 *
 * apply_disruption is that way, and nothing more. It maps onto the SAME four
 * kinds src/data/disruptions.json already uses (activity_cancelled,
 * price_spike, venue_closed, price_drop), described here exactly as narrowly.
 * The model cannot invent a fifth kind, and it cannot point at anything that is
 * not a real option id or a real slot and category on this trip: every call
 * is resolved and applied through the exact same functions the scripted
 * scenarios use (src/events/applicability.ts, src/events/engine.ts), never a
 * parallel implementation. See src/agent/chatTools.ts for the dispatcher.
 */

import { type FunctionDeclaration, Type } from "@google/genai";

import { CATEGORIES, TIME_SLOTS } from "../data/types.js";
import { AGENT_FUNCTION_DECLARATIONS } from "./declarations.js";

const applyDisruptionDeclaration: FunctionDeclaration = {
  name: "apply_disruption",
  description:
    "Make something go wrong in the world, the same way a scripted disruption does. Use this " +
    "ONLY when the traveller has just told you a real event happened (a cancellation, a closure, " +
    "a price change). Never use it to invent trouble of your own, and never use it as a way to " +
    "change a booking you simply want changed, that is what rebook_slot and reallocate_budget are " +
    "for. kind must be one of the four kinds this world understands: activity_cancelled (a booked " +
    "activity is off, its slot goes empty), venue_closed (an option shuts, whether booked or not, " +
    "so it can no longer be chosen), price_spike or price_drop (an option's price moves). Point at " +
    "what changed either by its exact option id, if the traveller named the thing, or by timeSlot " +
    "and category together, if they only described where it sits ('the hotel', 'tonight's " +
    "dinner'), and this acts on whatever is actually booked there. This is refused, like any other " +
    "tool, if the option or the slot named does not exist or is not booked on this trip, it never " +
    "guesses.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      kind: {
        type: Type.STRING,
        enum: ["activity_cancelled", "price_spike", "venue_closed", "price_drop"],
        description: "Which of the four kinds of event this is. No other value is understood.",
      },
      optionId: {
        type: Type.STRING,
        description:
          'The exact option id this hits, for example "a3". Use this when the traveller named the ' +
          "thing precisely. Leave this out and use timeSlot plus category instead when they only " +
          "described it.",
      },
      timeSlot: {
        type: Type.STRING,
        enum: [...TIME_SLOTS],
        description:
          "Together with category: the slot to act on, when there is no exact option id. This " +
          "acts on whatever this trip actually booked there, not on any option you name yourself.",
      },
      category: {
        type: Type.STRING,
        enum: [...CATEGORIES],
        description: "Together with timeSlot: the category to act on, when there is no exact option id.",
      },
      newPrice: {
        type: Type.NUMBER,
        description:
          "price_spike or price_drop WITH an optionId: the new whole rupee price. Must be above " +
          "the option's current price for a spike, below it for a drop.",
      },
      priceFactor: {
        type: Type.NUMBER,
        description:
          "price_spike or price_drop WITH a timeSlot and category: multiply whatever is booked " +
          "there by this. Above 1 for a spike, below 1 for a drop. Use this instead of newPrice " +
          "when you do not already know the current price.",
      },
      message: {
        type: Type.STRING,
        description:
          'One traveller facing sentence describing what happened, for the trace, for example ' +
          '"The approach road is closed for repairs." Write "{option}" where the name of the ' +
          "thing it hits should go if you do not know that name yet, it will be filled in.",
      },
    },
    required: ["kind", "message"],
  },
};

/** The four prompt-2 tools, unchanged, plus apply_disruption for chat. */
export const CHAT_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  ...AGENT_FUNCTION_DECLARATIONS,
  applyDisruptionDeclaration,
];
