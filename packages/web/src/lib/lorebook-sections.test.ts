/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { LorebookEntry, LorebookSection } from "./api-lorebooks";
import {
  buildBlocks,
  clampBlockPage,
  containerEntries,
  type LorebookBlock,
  moveInOrder,
  pageCountBlocks,
  pageUnits,
  paginateBlocks,
} from "./lorebook-sections";

/** An entry fixture; only the fields these helpers read are meaningful. */
function entry(id: string, sectionId: string | null): LorebookEntry {
  return {
    id,
    lorebook_id: "book",
    keys: [id],
    secondary: [],
    content: "",
    comment: null,
    constant: false,
    selective: false,
    logic: 0,
    order: 100,
    position: 0,
    depth: 4,
    role: null,
    probability: 100,
    enabled: true,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    vectorized: false,
    case_sensitive: false,
    match_whole_words: true,
    scan_depth: null,
    group: null,
    group_weight: null,
    recursion: null,
    match_fields: null,
    character_filter: null,
    section_id: sectionId,
    display_index: 0,
    extra: null,
  };
}

/** A section fixture; `display_index` is the only ordering input. */
function section(id: string, displayIndex: number): LorebookSection {
  return {
    id,
    lorebook_id: "book",
    name: id,
    display_index: displayIndex,
    created_at: "",
    updated_at: "",
  };
}

const idsOf = (entries: readonly LorebookEntry[]): string[] => entries.map((e) => e.id);

describe("buildBlocks", () => {
  it("yields one flat ungrouped block for a sectionless book", () => {
    const entries = [entry("a", null), entry("b", null)];
    expect(buildBlocks(entries, [])).toEqual([{ kind: "ungrouped", entries }]);
  });

  it("orders sections by display_index, not array order", () => {
    const sections = [section("late", 5), section("early", 1)];
    const blocks = buildBlocks([], sections);
    expect(blocks.map((b) => (b.kind === "section" ? b.section.id : "ungrouped"))).toEqual([
      "early",
      "late",
    ]);
  });

  it("files each entry into its own section, preserving input order", () => {
    const blocks = buildBlocks(
      [entry("a", "s2"), entry("b", "s1"), entry("c", "s2")],
      [section("s1", 0), section("s2", 1)],
    );
    expect(blocks[0]).toEqual({
      kind: "section",
      section: section("s1", 0),
      entries: [entry("b", "s1")],
    });
    expect(blocks[1]).toEqual({
      kind: "section",
      section: section("s2", 1),
      entries: [entry("a", "s2"), entry("c", "s2")],
    });
  });

  it("drops unknown/foreign section ids into the ungrouped bucket, last", () => {
    const blocks = buildBlocks(
      [entry("foreign", "ghost"), entry("none", null), entry("home", "s1")],
      [section("s1", 0)],
    );
    expect(blocks.map((b) => b.kind)).toEqual(["section", "ungrouped"]);
    const ungrouped = blocks[1] as Extract<LorebookBlock, { kind: "ungrouped" }>;
    expect(idsOf(ungrouped.entries)).toEqual(["foreign", "none"]);
  });

  it("omits an empty ungrouped block when sections exist", () => {
    const blocks = buildBlocks([entry("a", "s1")], [section("s1", 0)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("section");
  });

  it("keeps an empty section block so its header stays manageable", () => {
    const blocks = buildBlocks([], [section("empty", 0)]);
    expect(blocks).toEqual([{ kind: "section", section: section("empty", 0), entries: [] }]);
  });

  it("emits an empty ungrouped block for a sectionless book with no entries", () => {
    expect(buildBlocks([], [])).toEqual([{ kind: "ungrouped", entries: [] }]);
  });

  it("breaks display_index ties by input order (stable)", () => {
    const blocks = buildBlocks([], [section("second", 0), section("first", 0)]);
    expect(blocks.map((b) => (b.kind === "section" ? b.section.id : "ungrouped"))).toEqual([
      "second",
      "first",
    ]);
  });
});

describe("containerEntries", () => {
  it("returns one container's entries in order", () => {
    const entries = [entry("a", "s1"), entry("b", null), entry("c", "s1")];
    expect(idsOf(containerEntries(entries, "s1"))).toEqual(["a", "c"]);
    expect(idsOf(containerEntries(entries, null))).toEqual(["b"]);
    expect(containerEntries(entries, "missing")).toEqual([]);
  });
});

describe("pageUnits", () => {
  it("keeps a section whole and splits the ungrouped bucket per entry", () => {
    const blocks = buildBlocks(
      [entry("a", "s1"), entry("b", "s1"), entry("u1", null), entry("u2", null)],
      [section("s1", 0)],
    );
    const units = pageUnits(blocks);
    expect(units.map((b) => b.entries.map((e) => e.id))).toEqual([["a", "b"], ["u1"], ["u2"]]);
    expect(units[0]?.kind).toBe("section");
    expect(units[1]?.kind).toBe("ungrouped");
  });

  it("turns a sectionless book into one unit per entry", () => {
    const blocks = buildBlocks([entry("a", null), entry("b", null)], []);
    expect(pageUnits(blocks).map((b) => b.entries.map((e) => e.id))).toEqual([["a"], ["b"]]);
  });
});

describe("moveInOrder", () => {
  it("swaps an item with its neighbour", () => {
    expect(moveInOrder(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
  });

  it("returns null at the ends and for invalid indices", () => {
    expect(moveInOrder(["a", "b"], 0, -1)).toBeNull();
    expect(moveInOrder(["a", "b"], 1, 1)).toBeNull();
    expect(moveInOrder(["a", "b"], -1, 1)).toBeNull();
    expect(moveInOrder(["a", "b"], 2, -1)).toBeNull();
    expect(moveInOrder([], 0, 1)).toBeNull();
  });

  it("does not mutate its input", () => {
    const ids = ["a", "b", "c"];
    const next = moveInOrder(ids, 1, 1);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(next).not.toBe(ids);
  });

  it("handles a singleton list as a no-op", () => {
    expect(moveInOrder(["only"], 0, -1)).toBeNull();
    expect(moveInOrder(["only"], 0, 1)).toBeNull();
  });
});

describe("paginateBlocks", () => {
  it("counts pages and clamps against the block count", () => {
    expect(pageCountBlocks(0, 24)).toBe(1);
    expect(pageCountBlocks(25, 24)).toBe(2);
    expect(clampBlockPage(2, 30, 24)).toBe(2);
    expect(clampBlockPage(3, 24, 24)).toBe(1);
    expect(clampBlockPage(0, 10, 24)).toBe(1);
  });

  it("never splits a section holding more entries than the page size", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => entry(`s${i}`, "big")),
      ...Array.from({ length: 30 }, (_, i) => entry(`e${i}`, null)),
    ];
    const units = pageUnits(buildBlocks(entries, [section("big", 0)]));
    // The 5-entry section is one unit, so it lands whole on page 1 (the page's
    // remaining 2 slots go to the first two ungrouped entries).
    const first = paginateBlocks(units, 1, 3);
    expect(first.items).toHaveLength(3);
    expect(first.items[0]?.kind).toBe("section");
    expect(idsOf(first.items[0]?.entries ?? [])).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(first.items.slice(1).map((b) => b.entries[0]?.id)).toEqual(["e0", "e1"]);
    expect(first).toMatchObject({ start: 1, end: 3 });
  });

  it("degenerates to per-entry paging for a sectionless book", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`e${i}`, null));
    const units = pageUnits(buildBlocks(entries, []));
    const page2 = paginateBlocks(units, 2, 12);
    expect(page2.items.map((b) => b.entries[0]?.id)).toEqual(
      entries.slice(12, 24).map((e) => e.id),
    );
    expect(page2).toMatchObject({ start: 13, end: 24 });
  });

  it("resets an out-of-range page to the first page's blocks", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`e${i}`, null));
    const units = pageUnits(buildBlocks(entries, []));
    const result = paginateBlocks(units, 9, 12);
    expect(result.start).toBe(1);
    expect(result.end).toBe(12);
  });
});
