/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LorebookEntry, LorebookSection } from "./api-lorebooks";
import { clampPage, pageCount, pageSlice } from "./pagination";

/**
 * Section grouping and block pagination for the lorebook editor.
 *
 * A "section" is a named, purely ORGANIZATIONAL group of entries inside one
 * lorebook: it groups the editor's cards and never touches generation — an
 * entry activates and injects exactly the same with or without one. It is
 * deliberately unrelated to an entry's SillyTavern `group` (inclusion groups),
 * which DOES affect activation.
 *
 * A container is (book, `section_id`); `null` is the book's "ungrouped"
 * bucket, which also absorbs entries whose `section_id` names a section the
 * book no longer has. `buildBlocks` turns the flat, server-ordered entry list
 * into render blocks — sections in `display_index` order, then the ungrouped
 * bucket LAST. `pageUnits` then converts those render blocks into the units
 * pagination counts: one section (with ALL its entries) is one unit, one
 * ungrouped entry is one unit, so a section is never split across pages while
 * a sectionless book degenerates to exactly the old per-entry pagination.
 *
 * Everything here is pure and non-mutating, mirroring the role of
 * lib/pagination.ts and lib/preset-groups.ts: the editor holds the state,
 * these functions only compute.
 */

/**
 * One render block: a whole section with its entries in list order, or the
 * book's ungrouped bucket. A sectionless book yields a single ungrouped block
 * (see `buildBlocks`), so it renders exactly as it did before sections existed.
 */
export type LorebookBlock =
  | { kind: "section"; section: LorebookSection; entries: LorebookEntry[] }
  | { kind: "ungrouped"; entries: LorebookEntry[] };

/** Sections in `display_index` order, ties broken by input order (stable). */
function sortSections(sections: readonly LorebookSection[]): LorebookSection[] {
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => a.section.display_index - b.section.display_index || a.index - b.index)
    .map(({ section }) => section);
}

/**
 * The book's render blocks: one per section in `display_index` order, each
 * holding its own entries in the order given, then the ungrouped bucket LAST.
 *
 * An entry whose `section_id` is null — or names a section this book does not
 * have — lands in the ungrouped bucket. That bucket is emitted only when it
 * would carry entries, OR when the book has no sections at all: a sectionless
 * book must still get one block so its cards have somewhere to render (and it
 * then looks exactly like the pre-sections editor).
 */
export function buildBlocks(
  entries: readonly LorebookEntry[],
  sections: readonly LorebookSection[],
): LorebookBlock[] {
  const ordered = sortSections(sections);
  const known = new Set(ordered.map((section) => section.id));
  const bySection = new Map<string, LorebookEntry[]>();
  for (const section of ordered) {
    bySection.set(section.id, []);
  }

  const ungrouped: LorebookEntry[] = [];
  for (const entry of entries) {
    // A foreign/unknown id is treated as ungrouped rather than silently
    // dropped: the entry still needs a card, and the editor has no header to
    // file it under.
    const bucket =
      entry.section_id !== null && known.has(entry.section_id)
        ? bySection.get(entry.section_id)
        : undefined;
    if (bucket === undefined) {
      ungrouped.push(entry);
    } else {
      bucket.push(entry);
    }
  }

  const blocks: LorebookBlock[] = ordered.map((section) => ({
    kind: "section",
    section,
    entries: bySection.get(section.id) ?? [],
  }));
  if (ungrouped.length > 0 || ordered.length === 0) {
    blocks.push({ kind: "ungrouped", entries: ungrouped });
  }
  return blocks;
}

/** The entries of one container (`null` = the ungrouped bucket), in order. */
export function containerEntries(
  entries: readonly LorebookEntry[],
  sectionId: string | null,
): LorebookEntry[] {
  return entries.filter((entry) => entry.section_id === sectionId);
}

/**
 * Pagination units for `blocks`: sections pass through whole, while the
 * ungrouped bucket is split into one unit per entry (so the ungrouped bucket
 * can flow across pages one card at a time). Top-level order — sections, then
 * ungrouped — is preserved.
 */
export function pageUnits(blocks: readonly LorebookBlock[]): LorebookBlock[] {
  const units: LorebookBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "section") {
      units.push(block);
      continue;
    }
    for (const entry of block.entries) {
      units.push({ kind: "ungrouped", entries: [entry] });
    }
  }
  return units;
}

/**
 * A NEW array with the item at `index` swapped with its neighbour `delta`
 * (-1 up, +1 down). Returns null when the move is out of range (an invalid
 * index, or a target outside the array), so callers can no-op at the ends.
 * The input is never mutated.
 */
export function moveInOrder(ids: readonly string[], index: number, delta: -1 | 1): string[] | null {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) {
    return null;
  }
  const next = [...ids];
  const moved = next[index] as string;
  next[index] = next[target] as string;
  next[target] = moved;
  return next;
}

/** Pages needed to hold `totalBlocks` block units (always at least one). */
export function pageCountBlocks(totalBlocks: number, pageSize: number): number {
  return pageCount(totalBlocks, pageSize);
}

/** The page a stored page number settles on once the block count changes. */
export function clampBlockPage(page: number, totalBlocks: number, pageSize: number): number {
  return clampPage(page, totalBlocks, pageSize);
}

/**
 * The block units of the requested page, plus the 1-based inclusive range for
 * the "Showing A–B of N blocks" caption (0–0 when there are none). Units are
 * never split, which is what keeps a section whole.
 */
export function paginateBlocks<T>(
  blocks: readonly T[],
  page: number,
  pageSize: number,
): { items: T[]; start: number; end: number } {
  return pageSlice(blocks, page, pageSize);
}
