/**
 * The four prompt-2 tools, described to Gemini as function declarations.
 *
 * These are descriptions only. Nothing here executes anything. The executor
 * maps a call the model makes back onto the real tool, so all of the prompt-2
 * validation and every budget invariant still applies.
 *
 * The descriptions matter as much as the schemas. They are the only place the
 * model learns that a rejection is normal and recoverable, and that reallocating
 * before rebooking is the way through a category that cannot cover a swap.
 */

import { type FunctionDeclaration, Type } from "@google/genai";

import { CATEGORIES, TIME_SLOTS } from "../data/types.js";

const searchAlternativesDeclaration: FunctionDeclaration = {
  name: "search_alternatives",
  description:
    "Read only. List the bookable options that could fill a time slot or a category, " +
    "excluding whatever is already booked and anything a disruption has closed. " +
    "Always call this before rebooking, so you choose from what actually exists. " +
    "priceDelta is what the swap costs on top of the current booking, and it is the " +
    "number that has to fit the category, not the sticker price.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      timeSlot: {
        type: Type.STRING,
        enum: [...TIME_SLOTS],
        description:
          'The slot to fill. "Trip" covers the whole visit (the hotel and the local ' +
          'transport), so pass a category with it.',
      },
      category: {
        type: Type.STRING,
        enum: [...CATEGORIES],
        description: "Narrow the search to one kind of spending.",
      },
      maxPrice: {
        type: Type.NUMBER,
        description: "Optional ceiling on the option price, in whole rupees.",
      },
      mustFitRemainingBudget: {
        type: Type.BOOLEAN,
        description:
          "If true, only return options the category can already afford. Leave false " +
          "to also see options you would need to reallocate budget for.",
      },
      sortBy: {
        type: Type.STRING,
        enum: ["cheapest", "closest_price"],
        description:
          '"cheapest" for the lowest price first, "closest_price" to keep the trip ' +
          "closest to what the traveller originally chose.",
      },
    },
    required: [],
  },
};

const rebookSlotDeclaration: FunctionDeclaration = {
  name: "rebook_slot",
  description:
    "Change the itinerary. Swap one booked option for another, or fill a slot that a " +
    "disruption emptied. The two options must be the same time slot and the same " +
    "category. This is rejected if it would push the category past its allocation, " +
    "and the rejection tells you exactly how many rupees short you are. That is not a " +
    "dead end: call reallocate_budget to move that much in, then call this again. " +
    "If a category is ALREADY over its allocation, a swap that reduces the overspend is " +
    "allowed even while it stays negative, so you can downgrade your way back toward " +
    "solvency one step at a time. Keep going until nothing is over.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      oldOptionId: {
        type: Type.STRING,
        description:
          "The option id being replaced, for example \"s2\". Omit this when the slot is " +
          "already empty because a disruption removed the booking.",
      },
      newOptionId: {
        type: Type.STRING,
        description: 'The option id to book, for example "s3".',
      },
    },
    required: ["newOptionId"],
  },
};

const reallocateBudgetDeclaration: FunctionDeclaration = {
  name: "reallocate_budget",
  description:
    "Move budget allocation from one category to another. The total budget never " +
    "changes, only the split. A category can only give away what it has not already " +
    "spent, so check the remaining figures first. Use this when a rebooking you want " +
    "was rejected for being over a category allocation.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      fromCategory: {
        type: Type.STRING,
        enum: [...CATEGORIES],
        description: "The category giving up allocation. It must have enough unspent.",
      },
      toCategory: {
        type: Type.STRING,
        enum: [...CATEGORIES],
        description: "The category receiving the allocation.",
      },
      amount: {
        type: Type.NUMBER,
        description: "Whole rupees to move. Must be a positive integer.",
      },
    },
    required: ["fromCategory", "toCategory", "amount"],
  },
};

const notifyUserDeclaration: FunctionDeclaration = {
  name: "notify_user",
  description:
    "Read only. Send the traveller your final report. Call this exactly once, as the " +
    "last thing you do, after the itinerary is repaired and the budget is sound. Be " +
    "honest about what was lost, not just what was fixed.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      headline: {
        type: Type.STRING,
        description: "One sentence. The thing to read if they read nothing else.",
      },
      whatHappened: {
        type: Type.STRING,
        description: "The disruption in plain words, including the money involved.",
      },
      reasoning: {
        type: Type.STRING,
        description:
          "Why you chose this repair over the alternatives you looked at. Name the " +
          "options you rejected and say what was wrong with them.",
      },
      actions: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "The concrete changes you made, in order, each with its price.",
      },
      tradeoff: {
        type: Type.STRING,
        description:
          "What the traveller gives up, stated plainly. If they lost comfort, time or " +
          "an experience, say so. Do not pretend a downgrade is a win.",
      },
    },
    required: ["headline"],
  },
};

/** Everything the model is allowed to call, in one tool block. */
export const AGENT_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  searchAlternativesDeclaration,
  rebookSlotDeclaration,
  reallocateBudgetDeclaration,
  notifyUserDeclaration,
];
