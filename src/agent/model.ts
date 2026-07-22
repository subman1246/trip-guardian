/**
 * The model, behind a small interface.
 *
 * The loop only needs three things from a model: the text it reasoned, the tool
 * calls it wants, and the raw turn to append back to the conversation. Keeping
 * that behind an interface means the loop can be exercised without a network
 * call, and it keeps the SDK details in one file.
 */

import type { Content } from "@google/genai";

export interface ModelToolCall {
  /** The SDK's call id, echoed back on the response so the two are paired. */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelTurn {
  /** The model's own words for this turn. This is the visible reasoning. */
  text: string;
  toolCalls: ModelToolCall[];
  /**
   * The unmodified turn from the model, appended to the conversation as is.
   * Passing it through untouched preserves anything the SDK needs to keep,
   * including thought signatures on thinking models.
   */
  content: Content;
}

export interface AgentModel {
  /** For the trace header, so it is obvious which model produced a run. */
  readonly name: string;
  generate(contents: Content[]): Promise<ModelTurn>;
}
