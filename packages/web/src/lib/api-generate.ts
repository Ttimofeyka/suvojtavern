/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { api } from "./api";
import type { TrackerSnapshotDto } from "./api-tracker";

/** Prompt token budget snapshot reported by the "prompt" status event. */
export interface PromptBudgetInfo {
  /** Full context size the preset allows. */
  context: number;
  /** Tokens the assembled prompt occupies. */
  used: number;
  remaining: number;
}

/** Summary block the summaries memory strategy injected when it elided history. */
export interface MemorySummaryInfo {
  /** First elided message seq. */
  seqFrom: number;
  /** Last elided message seq. */
  seqTo: number;
  /** Ready-to-inject text — the snippets wrapped in the configured
   *  injection template, e.g. `[Summary of past events: …]`. */
  text: string;
}

/**
 * SSE events of POST /api/chats/:id/generate, exactly as the server emits
 * them (one `data: <json>` line per event; `summary` is omitted when absent).
 *
 * The tracker pair (`tracking` status + `tracker` event) fires once per
 * auto-mode generation; a tracker failure arrives as `tracker {ok:false}`
 * and NEVER breaks the stream — the reply still completes.
 */
export type GenerateEvent =
  | { type: "status"; stage: "preparing" }
  | {
      type: "status";
      stage: "prompt";
      tokenCount: number;
      budget: PromptBudgetInfo;
      summary?: MemorySummaryInfo;
    }
  | { type: "status"; stage: "summarizing" }
  | { type: "status"; stage: "tracking" }
  | { type: "delta"; content: string }
  | { type: "done"; message_id: string; content: string }
  | {
      type: "tracker";
      ok: true;
      snapshot: TrackerSnapshotDto;
      render: { html: string; css: string };
    }
  | { type: "tracker"; ok: false; error: string }
  | { type: "error"; message: string };

/** POST /api/chats/:id/generate body — every field optional. */
export interface GenerateInput {
  preset_id?: string;
  persona_id?: string;
  /** True to add a fresh swipe replacing the last assistant message. */
  regenerate?: boolean;
  /**
   * True to extend the last assistant message in place (SillyTavern's
   * continue): the server appends the generated text to that same message id,
   * with no new swipe and no new position — falling back to an appended new
   * position when the last message is not an assistant message.
   */
  continue?: boolean;
}

/** One message of a dry-run assembled prompt (GET prompt-preview). */
export interface PromptMessageInfo {
  role: "system" | "user" | "assistant";
  /** Speaker name when the message carries one (e.g. the persona's). */
  name?: string;
  content: string;
  tokens: number;
}

/**
 * GET /api/chats/:id/prompt-preview — a strictly read-only dry run of the
 * prompt the next generation would assemble. It works before the first
 * message too, since nothing is sent to the model.
 */
export interface PromptPreviewResponse {
  /** Assembled messages, in the order they would be sent. */
  messages: PromptMessageInfo[];
  /** Total tokens the messages occupy. */
  tokenCount: number;
  /** Same shape the "prompt" status event reports. */
  budget: PromptBudgetInfo;
  /** Present when the summaries strategy elided a range into a block. */
  summary?: MemorySummaryInfo;
  /** Raw lorebook payload that was injected, or null when none was. */
  lorebook?: unknown | null;
  /** True when a plugin's onPrompt rewrote the assembled messages. */
  plugin_rewritten: boolean;
}

/** A hierarchical summary row covering a seq range of a chat. */
export interface SummaryInfo {
  id: string;
  chat_id: string;
  /** 0 summarizes message ranges; higher levels summarize summaries. */
  level: number;
  seq_from: number;
  seq_to: number;
  summary: string;
  /** Tokens of the summary text. Derived server-side when an imported row
   *  carried none, so it is always present on read. */
  tokens: number;
  /** Content tokens of the messages the row covers (derived server-side on
   *  read, never stored): the "before" side of the summary's compression. */
  source_tokens: number;
  created_at: string;
}

/** Stored summaries of a chat, coarse-to-fine (level, then message range). */
export function listSummaries(chatId: string): Promise<SummaryInfo[]> {
  return api(`/api/chats/${chatId}/summaries`);
}

/** Dry-runs the prompt assembly for the chat without sending anything. */
export function previewPrompt(chatId: string): Promise<PromptPreviewResponse> {
  return api(`/api/chats/${chatId}/prompt-preview`);
}

/** Summarizes every uncovered message range; returns the created rows. */
export function summarizeChat(chatId: string, presetId?: string): Promise<SummaryInfo[]> {
  return api(`/api/chats/${chatId}/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(presetId === undefined ? {} : { preset_id: presetId }),
  });
}

/** GET /api/chats/:id/summaries/export envelope (version 1) — a portable
 *  snapshot of every summary row of the chat, in the exact shape the
 *  import route replaces them with. */
export interface SummariesExport {
  version: number;
  chat_id: string;
  exported_at: string;
  summaries: SummaryInfo[];
}

/** Importable summary row: the fields the import route reads (ids and
 *  timestamps regenerate server-side). A full SummaryInfo satisfies this
 *  shape, so export payloads round-trip unchanged. */
export interface SummaryImportInput {
  level: number;
  seq_from: number;
  seq_to: number;
  summary: string;
  tokens?: number | null;
}

/** Result of DELETE /api/chats/:id/summaries. */
export interface ClearSummariesResult {
  deleted: SummaryInfo[];
  /** Positions back in the live window (their summaries were removed). */
  unhidden_seqs: number[];
}

/** Removes every summary of the chat; covered messages return to the live window. */
export function clearSummaries(chatId: string): Promise<ClearSummariesResult> {
  return api(`/api/chats/${chatId}/summaries`, { method: "DELETE" });
}

/** Edits one summary's text; resolves with the updated row. */
export function updateSummary(
  chatId: string,
  summaryId: string,
  summary: string,
): Promise<SummaryInfo> {
  return api(`/api/chats/${chatId}/summaries/${summaryId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary }),
  });
}

/** Exports every summary row of the chat as a versioned JSON snapshot. */
export function exportSummaries(chatId: string): Promise<SummariesExport> {
  return api(`/api/chats/${chatId}/summaries/export`);
}

/**
 * REPLACES every existing summary of the chat with `summaries`; resolves
 * with the created rows.
 */
export function importSummaries(
  chatId: string,
  summaries: SummaryImportInput[],
): Promise<SummaryInfo[]> {
  return api(`/api/chats/${chatId}/summaries/import`, {
    method: "POST",
    body: JSON.stringify({ summaries }),
  });
}
