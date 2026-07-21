/**
 * The agent's four tools, in one place.
 *
 * Prompt 3 exposes these to the model under their snake_case names, so the
 * mapping between the model facing name and the implementation lives here.
 */

export { searchAlternatives } from "./search.js";
export { rebookSlot } from "./rebook.js";
export { reallocateBudget } from "./reallocate.js";
export { notifyUser, formatNotification } from "./notify.js";

export type { SearchQuery, SearchConstraints, SearchDetails, Alternative } from "./search.js";
export type { RebookDetails } from "./rebook.js";
export type { ReallocateDetails } from "./reallocate.js";
export type { NotificationInput, NotificationDetails } from "./notify.js";
export type { ToolResult, ToolSuccess, ToolFailure, FailureReason } from "./types.js";

export { formatToolResult, formatAlternatives } from "./format.js";

/** The names the model will use in prompt 3, next to what they do. */
export const TOOL_NAMES = {
  search_alternatives: "Read only. List bookable options for a slot or category.",
  rebook_slot: "Swap an option in the itinerary, or fill an emptied slot.",
  reallocate_budget: "Move allocation between categories. The total never changes.",
  notify_user: "Read only. Format the traveller facing report.",
} as const;
