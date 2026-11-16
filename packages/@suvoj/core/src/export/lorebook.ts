/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lorebook, LorebookEntry } from "../schema/lorebooks";

/**
 * Native → SillyTavern world info export. Emits the on-disk ST shape
 * (`{ name, entries: { "<uid>": … } }`) with every ST field materialized,
 * so re-importing the result reproduces the native entries exactly
 * (field-level round-trip, covered by tests against real ST files).
 */

/** ST fields reconstructed from `extra` (no native column of their own). */
const EXTRA_BACKED_ST_FIELDS = new Set([
  "uid",
  "addMemo",
  "useProbability",
  "probability",
  "ignoreBudget",
  "groupOverride",
  "outletName",
  "automationId",
  "triggers",
  "useGroupScoring",
]);

/** Native role string → ST numeric role (null passes through). */
function roleToSt(role: string | null): number | string | null {
  if (role === null) {
    return null;
  }
  if (role === "user") return 1;
  if (role === "assistant") return 2;
  return 0;
}

function extraOf(entry: LorebookEntry): Record<string, unknown> {
  return entry.extra ?? {};
}

function extraBool(extra: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof extra[key] === "boolean" ? (extra[key] as boolean) : fallback;
}

function extraString(extra: Record<string, unknown>, key: string, fallback: string): string {
  return typeof extra[key] === "string" ? (extra[key] as string) : fallback;
}

/** Converts one native entry back into an ST world info entry. */
export function nativeToStEntry(entry: LorebookEntry): Record<string, unknown> {
  const extra = extraOf(entry);
  const useProbability = extraBool(extra, "useProbability", true);
  // When the roll was disabled at import time, `extra.probability` keeps the
  // original (ignored) ST value; otherwise the native column is authoritative.
  const probability =
    !useProbability && typeof extra.probability === "number"
      ? extra.probability
      : entry.probability;
  const recursion = entry.recursion ?? {
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
  };
  const matchFields = entry.match_fields ?? {};

  const stEntry: Record<string, unknown> = {
    uid: typeof extra.uid === "number" ? extra.uid : entry.display_index,
    key: entry.keys,
    keysecondary: entry.secondary,
    comment: entry.comment,
    content: entry.content,
    constant: entry.constant,
    vectorized: entry.vectorized,
    selective: entry.selective,
    selectiveLogic: entry.logic,
    addMemo: extraBool(extra, "addMemo", true),
    order: entry.order,
    position: entry.position,
    disable: !entry.enabled,
    ignoreBudget: extraBool(extra, "ignoreBudget", false),
    excludeRecursion: recursion.excludeRecursion,
    preventRecursion: recursion.preventRecursion,
    matchPersonaDescription: matchFields.matchPersonaDescription === true,
    matchCharacterDescription: matchFields.matchCharacterDescription === true,
    matchCharacterPersonality: matchFields.matchCharacterPersonality === true,
    matchCharacterDepthPrompt: matchFields.matchCharacterDepthPrompt === true,
    matchScenario: matchFields.matchScenario === true,
    matchCreatorNotes: matchFields.matchCreatorNotes === true,
    delayUntilRecursion: recursion.delayUntilRecursion,
    probability,
    useProbability,
    depth: entry.depth,
    outletName: extraString(extra, "outletName", ""),
    group: entry.group,
    groupOverride: extraBool(extra, "groupOverride", false),
    groupWeight: entry.group_weight,
    scanDepth: entry.scan_depth,
    caseSensitive: entry.case_sensitive,
    matchWholeWords: entry.match_whole_words,
    useGroupScoring: extra.useGroupScoring ?? null,
    automationId: extraString(extra, "automationId", ""),
    role: roleToSt(entry.role),
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    triggers: extra.triggers ?? [],
    displayIndex: entry.display_index,
    characterFilter: entry.character_filter ?? { isExclude: false, names: [], tags: [] },
  };

  // Unknown extra fields (future ST surface) ride along verbatim.
  for (const [key, value] of Object.entries(extra)) {
    if (!EXTRA_BACKED_ST_FIELDS.has(key) && stEntry[key] === undefined) {
      stEntry[key] = value;
    }
  }
  return stEntry;
}

/**
 * Exports a lorebook into the ST on-disk world info shape. Entries are
 * keyed by their ST `uid` (imported entries keep it in `extra`; native
 * entries fall back to `display_index`).
 */
export function exportLorebook(
  lorebook: Lorebook,
  entries: ReadonlyArray<LorebookEntry>,
): { name: string; entries: Record<string, Record<string, unknown>> } {
  const out: Record<string, Record<string, unknown>> = {};
  const seenKeys = new Set<string>();
  for (const entry of entries) {
    const uid =
      typeof extraOf(entry).uid === "number" ? (extraOf(entry).uid as number) : entry.display_index;
    let key = String(uid);
    while (seenKeys.has(key)) {
      key = `${key}x`;
    }
    seenKeys.add(key);
    out[key] = nativeToStEntry(entry);
  }
  return { name: lorebook.name, entries: out };
}
