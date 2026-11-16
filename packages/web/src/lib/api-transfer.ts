/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { api } from "./api";

/** Character row as created/replaced by a card import (schema/characters.ts). */
export interface ImportedCharacter {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  avatar_path: string | null;
  /** The imported card JSON, verbatim. */
  card_raw: unknown;
  created_at: string;
  updated_at: string;
}

/** Lorebook row (schema/lorebooks.ts). */
export interface ImportedLorebook {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

/** Response of POST /api/import/card. */
export interface CardImportResult {
  character: ImportedCharacter;
  /** Lorebook imported from an embedded `character_book`, if the card had one. */
  lorebook: ImportedLorebook | null;
  /** True when `onConflict: "rename"` produced a suffixed name. */
  renamed: boolean;
}

/**
 * Where a URL import fetched the card from. `janitor` means the server
 * recognized a JanitorAI URL and delegated to its browser-based importer.
 */
export type CardImportSource = "chub" | "png" | "json" | "janitor";

/** Duplicate-name handling shared by every card import endpoint. */
export type ImportConflict = "error" | "rename" | "replace";

/** Response of POST /api/import/url. */
export interface UrlCardImportResult extends CardImportResult {
  source: CardImportSource;
}

/** Chat row as created by a chat import (schema/chats.ts). */
export interface ImportedChat {
  id: string;
  character_id: string;
  persona_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  branch_root_id: string | null;
  active_branch: string | null;
}

/** Imported message row (active messages, one per position, in order). */
export interface ImportedMessage {
  id: string;
  chat_id: string;
  seq: number;
  role: "system" | "user" | "assistant";
  name: string | null;
  content: string;
  variant_of: string | null;
  active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Response of POST /api/import/chat. */
export interface ChatImportResult {
  chat: ImportedChat;
  messages: ImportedMessage[];
}

/**
 * Imports a SillyTavern character card (PNG with an embedded `chara`/`ccv3`
 * chunk, or raw JSON) as multipart `file`. `onConflict` decides duplicate
 * name handling: "error" (default) fails, "rename" suffixes, "replace"
 * overwrites in place.
 */
export function importCard(file: File, onConflict?: ImportConflict): Promise<CardImportResult> {
  const form = new FormData();
  form.append("file", file);
  if (onConflict !== undefined) {
    form.append("onConflict", onConflict);
  }
  return api("/api/import/card", { method: "POST", body: form });
}

/**
 * Imports a character card by URL: a chub.ai / venus.chub.ai /
 * characterhub.org character page (or bare `creator/project` id), or any
 * direct http(s) link to a card PNG or JSON. `onConflict` decides duplicate
 * name handling like `importCard`; the resolved `source` names where the
 * card came from.
 */
export function importCardFromUrl(
  url: string,
  onConflict?: ImportConflict,
): Promise<UrlCardImportResult> {
  // JSON.stringify drops the undefined optional, matching importCard's omit-when-absent.
  return api("/api/import/url", { method: "POST", body: JSON.stringify({ url, onConflict }) });
}

/**
 * Imports a SillyTavern chat JSONL export. Exactly one of
 * `opts.character_id` / `opts.character_name` must target an existing
 * character (by id, or by case-insensitive name).
 */
export function importChat(
  file: File,
  opts: { character_id?: string; character_name?: string },
): Promise<ChatImportResult> {
  const form = new FormData();
  form.append("file", file);
  if (opts.character_id !== undefined) {
    form.append("character_id", opts.character_id);
  }
  if (opts.character_name !== undefined) {
    form.append("character_name", opts.character_name);
  }
  return api("/api/import/chat", { method: "POST", body: form });
}

/** Download URL of a character card PNG (default) or JSON (`format: "json"`). */
export function exportCardUrl(id: string, format?: "json"): string {
  const query = format === undefined ? "" : `?format=${format}`;
  return `/api/export/card/${encodeURIComponent(id)}${query}`;
}

/** Download URL of a chat's JSONL export. */
export function exportChatUrl(id: string): string {
  return `/api/export/chat/${encodeURIComponent(id)}`;
}

/** Download URL of a lorebook's JSON export. */
export function exportLorebookUrl(id: string): string {
  return `/api/export/lorebook/${encodeURIComponent(id)}`;
}
