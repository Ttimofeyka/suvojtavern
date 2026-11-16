/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LorebooksRepository } from "../repositories/lorebooks";
import type { Lorebook, LorebookEntry, LorebookEntryInput } from "../schema/lorebooks";

/**
 * SillyTavern world info (lorebook) import.
 *
 * Accepts all three ST shapes: `{ entries: { "0": … } }` (keyed object, the
 * on-disk format), `{ entries: [ … ] }`, and a bare array of entries. Every
 * ST field maps to a native column; fields with no native column are kept
 * verbatim in `extra` so exports round-trip losslessly (see ../export).
 */

// --- coercion helpers --------------------------------------------------------

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** ST keys: array of strings (legacy cards may use a comma-separated string). */
function asKeyArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((key): key is string => typeof key === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key !== "");
  }
  return [];
}

/** ST `role`: null, "user"/"assistant"/"system", or 0/1/2 → native string|null. */
function roleToNative(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    if (value === 1) return "user";
    if (value === 2) return "assistant";
    return "system";
  }
  return typeof value === "string" ? value : null;
}

/**
 * ST fields that map to native columns (or are reconstructed on export from
 * a native column + `extra`). Anything else in the source entry is copied
 * into `extra` verbatim.
 */
const MAPPED_ST_FIELDS = new Set([
  "key",
  "keysecondary",
  "comment",
  "content",
  "constant",
  "selective",
  "selectiveLogic",
  "order",
  "position",
  "depth",
  "role",
  "probability",
  "useProbability",
  "disable",
  "sticky",
  "cooldown",
  "delay",
  "vectorized",
  "caseSensitive",
  "matchWholeWords",
  "scanDepth",
  "group",
  "groupWeight",
  "excludeRecursion",
  "preventRecursion",
  "delayUntilRecursion",
  "matchPersonaDescription",
  "matchCharacterDescription",
  "matchCharacterPersonality",
  "matchCharacterDepthPrompt",
  "matchScenario",
  "matchCreatorNotes",
  "characterFilter",
  "displayIndex",
]);

/** Converts one ST world info entry into a native entry input. */
export function stEntryToNative(source: Record<string, unknown>): LorebookEntryInput {
  // `useProbability: false` disables the roll in ST (= always include), which
  // is native `probability: 100`. The original values ride in `extra` so the
  // export can restore them exactly.
  const useProbability = asBool(source.useProbability, true);
  const rawProbability = asInt(source.probability, 100);

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!MAPPED_ST_FIELDS.has(key) && value !== undefined) {
      extra[key] = value;
    }
  }
  extra.useProbability = useProbability;
  if (!useProbability) {
    extra.probability = rawProbability;
  }

  return {
    keys: asKeyArray(source.key),
    secondary: asKeyArray(source.keysecondary),
    content: asString(source.content),
    comment: typeof source.comment === "string" ? source.comment : null,
    constant: asBool(source.constant, false),
    selective: asBool(source.selective, false),
    logic: asInt(source.selectiveLogic, 0),
    order: asInt(source.order, 100),
    position: asInt(source.position, 0),
    depth: asInt(source.depth, 4),
    role: roleToNative(source.role),
    probability: useProbability ? rawProbability : 100,
    enabled: !asBool(source.disable, false),
    sticky: asInt(source.sticky, 0),
    cooldown: asInt(source.cooldown, 0),
    delay: asInt(source.delay, 0),
    vectorized: asBool(source.vectorized, false),
    case_sensitive: asBool(source.caseSensitive, false),
    match_whole_words: asBool(source.matchWholeWords, true),
    scan_depth:
      typeof source.scanDepth === "number" && Number.isFinite(source.scanDepth)
        ? Math.trunc(source.scanDepth)
        : null,
    group: typeof source.group === "string" ? source.group : null,
    group_weight:
      typeof source.groupWeight === "number" && Number.isFinite(source.groupWeight)
        ? Math.trunc(source.groupWeight)
        : null,
    recursion: {
      excludeRecursion: asBool(source.excludeRecursion, false),
      preventRecursion: asBool(source.preventRecursion, false),
      delayUntilRecursion: asBool(source.delayUntilRecursion, false),
    },
    match_fields: {
      matchPersonaDescription: asBool(source.matchPersonaDescription, false),
      matchCharacterDescription: asBool(source.matchCharacterDescription, false),
      matchCharacterPersonality: asBool(source.matchCharacterPersonality, false),
      matchCharacterDepthPrompt: asBool(source.matchCharacterDepthPrompt, false),
      matchScenario: asBool(source.matchScenario, false),
      matchCreatorNotes: asBool(source.matchCreatorNotes, false),
    },
    character_filter:
      source.characterFilter && typeof source.characterFilter === "object"
        ? (source.characterFilter as { isExclude: boolean; names: string[]; tags: string[] })
        : null,
    display_index: asInt(source.displayIndex, 0),
    extra: Object.keys(extra).length > 0 ? extra : null,
  };
}

// --- file parsing ------------------------------------------------------------

/** Entry list out of either ST shape: keyed object, array, or `{ entries }`. */
function entryList(entries: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(entries)) {
    return entries.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
    );
  }
  if (entries && typeof entries === "object") {
    return Object.values(entries).filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
    );
  }
  return null;
}

export interface ParsedLorebook {
  /** Book name from the file (`name` or `originalData.name`), if any. */
  name: string | null;
  entries: LorebookEntryInput[];
}

/** Parses any ST world info shape into native entry inputs. */
export function parseLorebook(raw: unknown): ParsedLorebook {
  if (Array.isArray(raw)) {
    return { name: null, entries: entryList(raw)?.map(stEntryToNative) ?? [] };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const list = entryList(obj.entries);
    if (list) {
      const originalData =
        obj.originalData && typeof obj.originalData === "object"
          ? (obj.originalData as Record<string, unknown>)
          : null;
      const name = asString(obj.name) || asString(originalData?.name) || null;
      return { name, entries: list.map(stEntryToNative) };
    }
  }
  throw new Error("not a SillyTavern world info file: no entries");
}

/** Entry inputs only (no database access) — used by the card importer. */
export function importLorebookEntries(raw: unknown): LorebookEntryInput[] {
  return parseLorebook(raw).entries;
}

/**
 * Converts a V2-spec `character_book` (embedded in character cards) into
 * native entry inputs. Spec entries carry the ST world info surface inside
 * `extensions`; the few spec-level fields are folded on top with priority.
 */
export function characterBookToEntries(book: unknown): LorebookEntryInput[] {
  if (!book || typeof book !== "object") {
    return [];
  }
  const obj = book as Record<string, unknown>;
  const list = entryList(obj.entries);
  if (!list) {
    return [];
  }
  return list.map((entry) => {
    const extensions =
      entry.extensions && typeof entry.extensions === "object"
        ? (entry.extensions as Record<string, unknown>)
        : {};
    const specPosition = entry.position;
    const position =
      typeof extensions.position === "number"
        ? extensions.position
        : specPosition === "after_char"
          ? 1
          : 0;
    return stEntryToNative({
      ...extensions,
      uid: entry.id ?? extensions.uid,
      key: entry.keys ?? extensions.key,
      keysecondary: entry.secondary_keys ?? extensions.keysecondary,
      comment: entry.comment ?? extensions.comment,
      content: entry.content ?? extensions.content,
      constant: entry.constant ?? extensions.constant,
      selective: entry.selective ?? extensions.selective,
      order: entry.insertion_order ?? extensions.order,
      position,
      disable: !(entry.enabled ?? !(extensions.disable ?? false)),
    });
  });
}

// --- database import ----------------------------------------------------------

export interface LorebookImportOptions {
  /** Book name; overrides any name found in the file. */
  name?: string;
  description?: string;
  /**
   * When true, an existing lorebook with the same name (case-insensitive)
   * has its entries replaced instead of a second book being created.
   */
  upsert?: boolean;
}

export interface LorebookImportResult {
  lorebook: Lorebook;
  entries: LorebookEntry[];
}

/** Imports an ST world info file as a new lorebook (or upserts by name). */
export function importLorebook(
  raw: unknown,
  lorebooks: LorebooksRepository,
  opts: LorebookImportOptions = {},
): LorebookImportResult {
  const parsed = parseLorebook(raw);
  const name = opts.name ?? parsed.name ?? "Imported lorebook";
  const description = opts.description ?? "";

  if (opts.upsert) {
    const existing = lorebooks
      .list()
      .find((book) => book.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      return { lorebook: existing, entries: lorebooks.replaceEntries(existing.id, parsed.entries) };
    }
  }
  const lorebook = lorebooks.create({ name, description });
  return { lorebook, entries: lorebooks.replaceEntries(lorebook.id, parsed.entries) };
}
