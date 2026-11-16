/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { api } from "./api";

/** A stored lorebook row (GET /api/lorebooks, POST /api/lorebooks, …). */
export interface Lorebook {
  id: string;
  name: string;
  description: string;
  /** True while the book runs in every chat (Settings-managed). */
  global: boolean;
  /** How many characters this book is attached to. */
  attached_character_count: number;
  created_at: string;
  updated_at: string;
}

/** Lorebook row plus its per-character link state (GET /api/characters/:id/lorebooks). */
export interface CharacterLorebook extends Lorebook {
  enabled: boolean;
}

/** Lorebook row plus its entries and sections (GET /api/lorebooks/:id, import responses). */
export interface LorebookDetail extends Lorebook {
  entries: LorebookEntry[];
  sections: LorebookSection[];
}

/**
 * A named, purely organizational group of entries inside one lorebook
 * ("Sections" in the UI). Sections are a SuvojTavern concept with no
 * SillyTavern equivalent and never affect generation — an entry activates and
 * injects exactly the same whether it sits in a section or not. Distinct from
 * an entry's own ST `group` (inclusion groups), which DOES affect activation.
 */
export interface LorebookSection {
  id: string;
  lorebook_id: string;
  name: string;
  display_index: number;
  created_at: string;
  updated_at: string;
}

/** ST recursion flags, grouped for the `recursion` JSON column. */
export interface LorebookRecursion {
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
}

/** ST `characterFilter` — include/exclude characters by name or tags. */
export interface LorebookCharacterFilter {
  isExclude: boolean;
  names: string[];
  tags: string[];
}

/** A lorebook entry carrying the canonical SillyTavern field set. */
export interface LorebookEntry {
  id: string;
  lorebook_id: string;
  keys: string[];
  secondary: string[];
  content: string;
  comment: string | null;
  constant: boolean;
  selective: boolean;
  logic: number;
  order: number;
  position: number;
  depth: number;
  role: string | null;
  probability: number;
  enabled: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  vectorized: boolean;
  case_sensitive: boolean;
  match_whole_words: boolean;
  scan_depth: number | null;
  group: string | null;
  group_weight: number | null;
  recursion: LorebookRecursion | null;
  match_fields: Record<string, boolean> | null;
  character_filter: LorebookCharacterFilter | null;
  /** Organizational section membership; null = the book's ungrouped bucket.
   *  Unlike `group` (inclusion groups), this never affects activation. */
  section_id: string | null;
  display_index: number;
  extra: Record<string, unknown> | null;
}

/** POST /api/lorebooks body — `description` falls back to "". */
export interface CreateLorebookInput {
  name: string;
  description?: string;
}

/** PATCH /api/lorebooks/:id body — absent fields are left untouched. */
export type UpdateLorebookInput = Partial<CreateLorebookInput>;

/**
 * POST /api/lorebooks/:id/entries body — every field falls back to the ST
 * default, so all of them are optional.
 */
export interface CreateLorebookEntryInput {
  keys?: string[];
  secondary?: string[];
  content?: string;
  comment?: string | null;
  constant?: boolean;
  selective?: boolean;
  logic?: number;
  order?: number;
  position?: number;
  depth?: number;
  role?: string | null;
  probability?: number;
  enabled?: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  vectorized?: boolean;
  case_sensitive?: boolean;
  match_whole_words?: boolean;
  scan_depth?: number | null;
  group?: string | null;
  group_weight?: number | null;
  recursion?: LorebookRecursion | null;
  match_fields?: Record<string, boolean> | null;
  character_filter?: LorebookCharacterFilter | null;
  /** Organizational section to file the new entry under; null/absent = the
   *  ungrouped bucket. The server appends it within that container. */
  section_id?: string | null;
  display_index?: number;
  extra?: Record<string, unknown> | null;
}

/** PATCH entry body — any subset of the full ST entry field set. */
export type UpdateLorebookEntryInput = CreateLorebookEntryInput;

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** All lorebooks. */
export function listLorebooks(): Promise<Lorebook[]> {
  return api("/api/lorebooks");
}

/** One lorebook with its entries (ordered by display_index). */
export function getLorebook(id: string): Promise<LorebookDetail> {
  return api(`/api/lorebooks/${id}`);
}

export function createLorebook(input: CreateLorebookInput): Promise<Lorebook> {
  return api("/api/lorebooks", jsonInit("POST", input));
}

export function updateLorebook(id: string, patch: UpdateLorebookInput): Promise<Lorebook> {
  return api(`/api/lorebooks/${id}`, jsonInit("PATCH", patch));
}

export function deleteLorebook(id: string): Promise<{ ok: boolean }> {
  return api(`/api/lorebooks/${id}`, { method: "DELETE" });
}

/** All sections of one lorebook, ordered by display_index. */
export function listSections(lorebookId: string): Promise<LorebookSection[]> {
  return api(`/api/lorebooks/${lorebookId}/sections`);
}

/** Creates a section at the end of the book's section order. */
export function createSection(lorebookId: string, name: string): Promise<LorebookSection> {
  return api(`/api/lorebooks/${lorebookId}/sections`, jsonInit("POST", { name }));
}

/** Renames and/or repositions one section (absent fields are left untouched). */
export function updateSection(
  lorebookId: string,
  sectionId: string,
  patch: { name?: string; display_index?: number },
): Promise<LorebookSection> {
  return api(`/api/lorebooks/${lorebookId}/sections/${sectionId}`, jsonInit("PATCH", patch));
}

/** Deletes a section; its entries survive and fall back to the ungrouped bucket. */
export function deleteSection(lorebookId: string, sectionId: string): Promise<{ ok: boolean }> {
  return api(`/api/lorebooks/${lorebookId}/sections/${sectionId}`, { method: "DELETE" });
}

/** Rewrites the book's whole section order from the given ids (immediate write). */
export function reorderSections(
  lorebookId: string,
  ids: string[],
): Promise<{ sections: LorebookSection[] }> {
  return api(`/api/lorebooks/${lorebookId}/sections/order`, jsonInit("PUT", { ids }));
}

/**
 * Rewrites the whole order of one entry container — the book's ungrouped
 * bucket when `sectionId` is null, else that section's entries. `ids` must
 * name every entry of the container, in the new order.
 */
export function reorderEntries(
  lorebookId: string,
  sectionId: string | null,
  ids: string[],
): Promise<{ entries: LorebookEntry[] }> {
  return api(
    `/api/lorebooks/${lorebookId}/entries/order`,
    jsonInit("PUT", { section_id: sectionId, ids }),
  );
}

/** All entries of one lorebook, ordered by display_index. */
export function listEntries(lorebookId: string): Promise<LorebookEntry[]> {
  return api(`/api/lorebooks/${lorebookId}/entries`);
}

export function addEntry(
  lorebookId: string,
  input: CreateLorebookEntryInput,
): Promise<LorebookEntry> {
  return api(`/api/lorebooks/${lorebookId}/entries`, jsonInit("POST", input));
}

export function updateEntry(
  lorebookId: string,
  entryId: string,
  patch: UpdateLorebookEntryInput,
): Promise<LorebookEntry> {
  return api(`/api/lorebooks/${lorebookId}/entries/${entryId}`, jsonInit("PATCH", patch));
}

export function deleteEntry(lorebookId: string, entryId: string): Promise<{ ok: boolean }> {
  return api(`/api/lorebooks/${lorebookId}/entries/${entryId}`, { method: "DELETE" });
}

/** Links the lorebook to a character. */
export function attachLorebook(lorebookId: string, characterId: string): Promise<{ ok: boolean }> {
  return api(
    `/api/lorebooks/${lorebookId}/attach`,
    jsonInit("POST", { character_id: characterId }),
  );
}

/** Unlinks the lorebook from a character; 404 when not attached. */
export function detachLorebook(lorebookId: string, characterId: string): Promise<{ ok: boolean }> {
  return api(`/api/lorebooks/${lorebookId}/attach/${characterId}`, { method: "DELETE" });
}

/** Lorebooks linked to a character, each with its enabled flag. */
export function listCharacterLorebooks(characterId: string): Promise<CharacterLorebook[]> {
  return api(`/api/characters/${encodeURIComponent(characterId)}/lorebooks`);
}

/** Toggles a character link; 404 when the book is not attached. */
export function setCharacterLorebookEnabled(
  characterId: string,
  lorebookId: string,
  enabled: boolean,
): Promise<{ ok: boolean; enabled: boolean }> {
  return api(
    `/api/characters/${encodeURIComponent(characterId)}/lorebooks/${encodeURIComponent(lorebookId)}`,
    jsonInit("PATCH", { enabled }),
  );
}

/** Adds/removes the book from the global (every-chat) lorebooks. */
export function setLorebookGlobal(
  lorebookId: string,
  enabled: boolean,
): Promise<{ ok: boolean; global: boolean }> {
  return api(
    `/api/lorebooks/${encodeURIComponent(lorebookId)}/global`,
    jsonInit("PATCH", { enabled }),
  );
}

/** Imports a SillyTavern world info JSON text; `name` overrides the file's name. */
export function importLorebook(raw: string, name?: string): Promise<LorebookDetail> {
  return api("/api/lorebooks/import", jsonInit("POST", { raw, name }));
}
