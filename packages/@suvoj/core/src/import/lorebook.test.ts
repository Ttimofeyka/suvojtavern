/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { exportLorebook } from "../export/lorebook";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import type { LorebookEntry } from "../schema/lorebooks";
import { at, createTestDb } from "../test-utils";
import { importLorebook, importLorebookEntries, parseLorebook } from "./lorebook";

/** The shipped sample lorebook (the seeded copy is the canonical source). */
const EXAMPLE_URL = new URL(
  "../../../../../packages/server/seed/EXAMPLE_LOREBOOK.json",
  import.meta.url,
);

let repos: Repositories;
let example: unknown;

beforeEach(async () => {
  repos = createRepositories(createTestDb());
  example = await Bun.file(EXAMPLE_URL).json();
});

describe("importLorebook", () => {
  it("imports the real EXAMPLE_LOREBOOK.json with 13 entries", () => {
    const { lorebook, entries } = importLorebook(example, repos.lorebooks, {
      name: "Example: Drone World",
    });
    expect(lorebook.name).toBe("Example: Drone World");
    expect(entries).toHaveLength(13);

    // Spot-checks against the file's entry 0 (Earth - The Age of Drones).
    const earth = at(entries, 0);
    expect(earth.constant).toBe(true);
    expect(earth.keys).toEqual(["earth", "world", "society", "city"]);
    expect(earth.match_whole_words).toBe(true);
    expect(earth.group).toBe("");
    expect(earth.probability).toBe(100);
    expect(earth.comment).toBe("Earth - The Age of Drones");
    expect(earth.content).toContain("JCJenson");
    expect(earth.extra?.uid).toBe(0);
  });

  it("accepts all three ST shapes", () => {
    const entry = { uid: 0, key: ["a"], content: "A", disable: false, probability: 100 };
    const fromKeyed = parseLorebook({ entries: { 0: entry } });
    const fromArray = parseLorebook({ entries: [entry] });
    const fromBare = parseLorebook([entry]);
    expect(fromKeyed.entries[0]?.keys).toEqual(["a"]);
    expect(fromArray.entries[0]?.content).toBe("A");
    expect(fromBare.entries[0]?.keys).toEqual(["a"]);
    expect(() => parseLorebook({ nope: true })).toThrow("no entries");
  });

  it("upserts by name, replacing entries", () => {
    const first = importLorebook(example, repos.lorebooks, { name: "Drone World", upsert: true });
    const second = importLorebook({ entries: [{ key: ["x"], content: "Y" }] }, repos.lorebooks, {
      name: "drone world",
      upsert: true,
    });
    expect(second.lorebook.id).toBe(first.lorebook.id);
    expect(repos.lorebooks.listEntries(first.lorebook.id)).toHaveLength(1);
    expect(repos.lorebooks.list()).toHaveLength(1);
  });

  it("round-trips the real EXAMPLE_LOREBOOK.json field by field", () => {
    const { lorebook, entries } = importLorebook(example, repos.lorebooks, {
      name: "Example: Drone World",
    });
    const exported = exportLorebook(lorebook, entries);
    const original = example as { entries: Record<string, Record<string, unknown>> };

    expect(Object.keys(exported.entries)).toEqual(Object.keys(original.entries));
    for (const [key, originalEntry] of Object.entries(original.entries)) {
      expect(exported.entries[key]).toEqual(originalEntry);
    }

    // And re-importing the export yields identical native entries.
    const reimported = importLorebookEntries(exported);
    expect(reimported).toHaveLength(entries.length);
    for (const [index, entry] of reimported.entries()) {
      const native: Partial<LorebookEntry> = { ...entry };
      delete native.id;
      delete native.lorebook_id;
      const original: Partial<LorebookEntry> = { ...at(entries, index) };
      delete original.id;
      delete original.lorebook_id;
      // `section_id` is native-only: ST files carry no sections, so an import
      // always lands ungrouped and the comparison drops the column.
      delete native.section_id;
      delete original.section_id;
      expect(native).toEqual(original);
    }
  });

  it("keeps ignored probability values (useProbability: false)", () => {
    const book = repos.lorebooks.create({ name: "Book" });
    const [entry] = importLorebookEntries({
      entries: { 0: { key: ["a"], content: "A", probability: 40, useProbability: false } },
    });
    const stored = repos.lorebooks.addEntry(book.id, entry as { content: string });

    expect(stored.probability).toBe(100); // native: always include
    expect(stored.extra?.probability).toBe(40); // original preserved
    expect(stored.extra?.useProbability).toBe(false);

    const exported = exportLorebook(book, [stored]);
    const exportedEntry = exported.entries["0"];
    expect(exportedEntry?.probability).toBe(40);
    expect(exportedEntry?.useProbability).toBe(false);
  });
});
