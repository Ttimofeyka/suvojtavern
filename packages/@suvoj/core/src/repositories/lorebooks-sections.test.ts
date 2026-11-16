/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { at, createTestDb } from "../test-utils";
import { LorebooksRepository } from "./lorebooks";

let db: Database;
let lorebooks: LorebooksRepository;

beforeEach(() => {
  db = createTestDb();
  lorebooks = new LorebooksRepository(db);
});

/** Adds a minimal entry in `sectionId` (null = ungrouped). */
function addEntry(
  bookId: string,
  sectionId: string | null,
  overrides: Record<string, unknown> = {},
) {
  return lorebooks.addEntry(bookId, { content: "c", section_id: sectionId, ...overrides });
}

describe("LorebooksRepository sections", () => {
  it("creates sections appended in order", () => {
    const book = lorebooks.create({ name: "World" });
    const first = lorebooks.createSection(book.id, { name: "Places" });
    const second = lorebooks.createSection(book.id, { name: "People" });
    // createSection always appends, whatever display_index the caller passed.
    const third = lorebooks.createSection(book.id, { name: "Items", display_index: 99 });

    expect(first.display_index).toBe(0);
    expect(second.display_index).toBe(1);
    expect(third.display_index).toBe(2);
    expect(lorebooks.listSections(book.id).map((section) => section.name)).toEqual([
      "Places",
      "People",
      "Items",
    ]);
  });

  it("renames a section and reorders it via display_index", () => {
    const book = lorebooks.create({ name: "World" });
    const a = lorebooks.createSection(book.id, { name: "A" });
    const b = lorebooks.createSection(book.id, { name: "B" });

    expect(lorebooks.updateSection(a.id, { name: "A2" })).toMatchObject({
      id: a.id,
      name: "A2",
      display_index: 0,
    });
    // B moves to the front; list order follows display_index.
    lorebooks.updateSection(b.id, { display_index: 0 });
    lorebooks.updateSection(a.id, { display_index: 1 });
    expect(lorebooks.listSections(book.id).map((section) => section.id)).toEqual([b.id, a.id]);

    expect(lorebooks.updateSection("missing", { name: "X" })).toBeNull();
    expect(lorebooks.getSection("missing")).toBeNull();
  });

  it("round-trips section timestamps", () => {
    const book = lorebooks.create({ name: "World" });
    const created = lorebooks.createSection(book.id, { name: "S" });
    expect(created.created_at).not.toBe("");
    expect(created.updated_at).not.toBe("");
    expect(created.updated_at).toBe(created.created_at);

    // The read paths (get/list) carry the same timestamps.
    expect(lorebooks.getSection(created.id)?.created_at).toBe(created.created_at);
    expect(at(lorebooks.listSections(book.id), 0).updated_at).toBe(created.updated_at);
  });

  it("appends entries within a section, independently of the ungrouped bucket", () => {
    const book = lorebooks.create({ name: "World" });
    const section = lorebooks.createSection(book.id, { name: "S" });

    // Two ungrouped entries: 0 then 1.
    const u0 = addEntry(book.id, null);
    const u1 = addEntry(book.id, null);
    // Section entries get their OWN 0-based sequence.
    const s0 = addEntry(book.id, section.id);
    const s1 = addEntry(book.id, section.id);

    expect([u0.display_index, u1.display_index]).toEqual([0, 1]);
    expect([s0.display_index, s1.display_index]).toEqual([0, 1]);
    expect(u0.section_id).toBeNull();
    expect(s0.section_id).toBe(section.id);
  });

  it("honors an explicit display_index on add", () => {
    const book = lorebooks.create({ name: "World" });
    const entry = addEntry(book.id, null, { display_index: 4 });
    expect(entry.display_index).toBe(4);
    // A later append continues after the explicit one.
    expect(addEntry(book.id, null).display_index).toBe(5);
  });

  it("deletes a section, keeping its entries and appending them ungrouped", () => {
    const book = lorebooks.create({ name: "World" });
    const section = lorebooks.createSection(book.id, { name: "S" });
    const ungrouped = addEntry(book.id, null);
    const inA = addEntry(book.id, section.id, { content: "a" });
    const inB = addEntry(book.id, section.id, { content: "b" });

    expect(lorebooks.deleteSection(section.id)).toBe(true);
    expect(lorebooks.getSection(section.id)).toBeNull();

    // Entries survive, section_id is cleared, and they follow the existing
    // ungrouped row (index 1 onwards) in their former relative order.
    const byId = new Map(lorebooks.listEntries(book.id).map((entry) => [entry.id, entry]));
    expect(byId.get(ungrouped.id)?.display_index).toBe(0);
    expect(byId.get(inA.id)).toMatchObject({ section_id: null, display_index: 1 });
    expect(byId.get(inB.id)).toMatchObject({ section_id: null, display_index: 2 });

    expect(lorebooks.deleteSection("missing")).toBe(false);
  });

  it("reorders sections only for a valid permutation", () => {
    const book = lorebooks.create({ name: "World" });
    const a = lorebooks.createSection(book.id, { name: "A" });
    const b = lorebooks.createSection(book.id, { name: "B" });
    const c = lorebooks.createSection(book.id, { name: "C" });

    const reordered = lorebooks.reorderSections(book.id, [c.id, a.id, b.id]);
    expect(reordered?.map((section) => section.id)).toEqual([c.id, a.id, b.id]);

    // Missing id, extra id, and an id from another book all fail.
    expect(lorebooks.reorderSections(book.id, [a.id, b.id])).toBeNull();
    expect(lorebooks.reorderSections(book.id, [a.id, b.id, c.id, "extra"])).toBeNull();
    const other = lorebooks.create({ name: "Other" });
    const foreign = lorebooks.createSection(other.id, { name: "F" });
    expect(lorebooks.reorderSections(book.id, [a.id, b.id, foreign.id])).toBeNull();
    // Failed calls leave the order untouched.
    expect(lorebooks.listSections(book.id).map((section) => section.id)).toEqual([
      c.id,
      a.id,
      b.id,
    ]);
  });

  it("reorders entries within a container only for a valid permutation", () => {
    const book = lorebooks.create({ name: "World" });
    const section = lorebooks.createSection(book.id, { name: "S" });
    const u0 = addEntry(book.id, null);
    const u1 = addEntry(book.id, null);
    const s0 = addEntry(book.id, section.id);
    const s1 = addEntry(book.id, section.id);

    // Returns every entry of the book, so index by id rather than trusting
    // the (per-container) display_index sequence to be globally unique.
    const returned = lorebooks.reorderEntries(book.id, section.id, [s1.id, s0.id]);
    expect(returned).not.toBeNull();
    const indexOf = (id: string) => returned?.find((entry) => entry.id === id)?.display_index ?? -1;
    expect(indexOf(s1.id)).toBe(0);
    expect(indexOf(s0.id)).toBe(1);
    // The ungrouped container is untouched.
    expect(indexOf(u0.id)).toBe(0);
    expect(indexOf(u1.id)).toBe(1);

    // Bad sets: a missing id, an extra id, and an entry from another container.
    expect(lorebooks.reorderEntries(book.id, section.id, [s1.id])).toBeNull();
    expect(lorebooks.reorderEntries(book.id, section.id, [s0.id, s1.id, u0.id])).toBeNull();

    // The ungrouped container is addressed with section_id = null.
    const ungrouped = lorebooks.reorderEntries(book.id, null, [u1.id, u0.id]);
    const ungroupedIndex = (id: string) =>
      ungrouped?.find((entry) => entry.id === id)?.display_index ?? -1;
    expect(ungroupedIndex(u1.id)).toBe(0);
    expect(ungroupedIndex(u0.id)).toBe(1);
  });

  it("treats a cross-book section as an empty container (routes guard this)", () => {
    // The FK on `lorebook_entries.section_id` can only prove the section
    // exists, never that it belongs to the entry's book. The repository is
    // therefore deliberately permissive here — the routes are the trust
    // boundary that rejects a foreign `section_id` before these run. This
    // test pins that split so nobody mistakes the repo for an integrity gate.
    const a = lorebooks.create({ name: "A" });
    const b = lorebooks.create({ name: "B" });
    const secB = lorebooks.createSection(b.id, { name: "B-section" });
    const entry = addEntry(a.id, null);

    // A foreign section id is not a container of book A: empty, so only the
    // empty id list is a "permutation" — and it mutates nothing.
    expect(lorebooks.reorderEntries(a.id, secB.id, [entry.id])).toBeNull();
    expect(lorebooks.reorderEntries(a.id, secB.id, [])).not.toBeNull();
    expect(lorebooks.getEntry(entry.id)?.section_id).toBeNull();
  });

  it("appends an entry when it moves to another container without an index", () => {
    const book = lorebooks.create({ name: "World" });
    const section = lorebooks.createSection(book.id, { name: "S" });
    const existing = addEntry(book.id, section.id); // index 0 in the section
    const moving = addEntry(book.id, null); // index 0 ungrouped

    const moved = lorebooks.updateEntry(moving.id, { section_id: section.id });
    expect(moved).toMatchObject({ section_id: section.id, display_index: 1 });

    // Ungrouping appends back into the (now empty) ungrouped bucket at 0.
    const ungrouped = lorebooks.updateEntry(moving.id, { section_id: null });
    expect(ungrouped).toMatchObject({ section_id: null, display_index: 0 });

    // An explicit display_index still wins on a move.
    const forced = lorebooks.updateEntry(existing.id, { section_id: null, display_index: 7 });
    expect(forced).toMatchObject({ section_id: null, display_index: 7 });
  });

  it("drops sections on a full-replace import", () => {
    const book = lorebooks.create({ name: "World" });
    const section = lorebooks.createSection(book.id, { name: "S" });
    addEntry(book.id, section.id);
    expect(lorebooks.listSections(book.id)).toHaveLength(1);

    const entries = lorebooks.replaceEntries(book.id, [{ content: "fresh" }]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.section_id).toBeNull();
    expect(lorebooks.listSections(book.id)).toEqual([]);
  });

  it("cascades sections and entries when their lorebook is deleted", () => {
    const book = lorebooks.create({ name: "World" });
    const section = lorebooks.createSection(book.id, { name: "S" });
    addEntry(book.id, section.id);
    expect(lorebooks.delete(book.id)).toBe(true);
    expect(lorebooks.listSections(book.id)).toEqual([]);
    expect(lorebooks.listEntries(book.id)).toEqual([]);
  });
});
