/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { at, createTestDb } from "../test-utils";
import { CharactersRepository } from "./characters";
import { LorebooksRepository } from "./lorebooks";

let db: Database;
let lorebooks: LorebooksRepository;

beforeEach(() => {
  db = createTestDb();
  lorebooks = new LorebooksRepository(db);
});

describe("LorebooksRepository", () => {
  it("round-trips an entry with the full SillyTavern field surface", () => {
    const book = lorebooks.create({ name: "World", description: "Facts" });
    const entry = lorebooks.addEntry(book.id, {
      keys: ["earth", "world"],
      secondary: ["terra"],
      content: "Earth is an alternate universe.",
      comment: "Earth",
      constant: true,
      selective: true,
      logic: 1,
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
      recursion: { excludeRecursion: false, preventRecursion: true, delayUntilRecursion: false },
      match_fields: { matchPersonaDescription: true, matchCharacterDescription: false },
      character_filter: { isExclude: false, names: [], tags: [] },
      display_index: 0,
      extra: { outletName: "", automationId: "auto-1", triggers: [], useProbability: true },
    });
    expect(lorebooks.getEntry(entry.id)).toEqual(entry);
    expect(lorebooks.get(book.id)).toEqual(book);
    expect(lorebooks.list().map((b) => b.name)).toEqual(["World"]);
  });

  it("imports lorebooks via full-replace", () => {
    const book = lorebooks.create({ name: "Import" });
    const entries = lorebooks.replaceEntries(book.id, [
      { keys: ["a"], content: "A" },
      { keys: ["b"], content: "B", display_index: 1 },
    ]);
    expect(entries.map((e) => e.keys)).toEqual([["a"], ["b"]]);
    expect(lorebooks.listEntries(book.id).length).toBe(2);
    const updated = lorebooks.updateEntry(at(entries, 0).id, { probability: 50, enabled: false });
    expect(updated).toMatchObject({ probability: 50, enabled: false });
    expect(lorebooks.deleteEntry(at(entries, 1).id)).toBe(true);
    expect(lorebooks.listEntries(book.id).length).toBe(1);
  });

  it("links lorebooks to characters and cascades on delete", () => {
    const characters = new CharactersRepository(db);
    const book = lorebooks.create({ name: "World" });
    const alice = characters.create({ name: "Alice" });
    const bob = characters.create({ name: "Bob" });
    lorebooks.attachToCharacter(alice.id, book.id);
    lorebooks.attachToCharacter(bob.id, book.id);
    expect(lorebooks.listForCharacter(alice.id).map((b) => b.id)).toEqual([book.id]);
    lorebooks.detachFromCharacter(bob.id, book.id);
    expect(lorebooks.listForCharacter(bob.id)).toEqual([]);
    lorebooks.addEntry(book.id, { keys: ["x"], content: "y" });
    expect(lorebooks.delete(book.id)).toBe(true);
    expect(lorebooks.listEntries(book.id)).toEqual([]);
  });

  it("toggles character link enablement without dropping the link", () => {
    const characters = new CharactersRepository(db);
    const book = lorebooks.create({ name: "World" });
    const alice = characters.create({ name: "Alice" });

    // Links start enabled (migration default 1).
    lorebooks.attachToCharacter(alice.id, book.id);
    expect(lorebooks.listAttachmentsForCharacter(alice.id)).toMatchObject([
      { id: book.id, enabled: true },
    ]);
    expect(lorebooks.listForCharacter(alice.id).map((b) => b.id)).toEqual([book.id]);

    // Disabling hides the book from listForCharacter — the engine surface —
    // while the link survives with its state.
    expect(lorebooks.setAttachmentEnabled(alice.id, book.id, false)).toBe(true);
    expect(lorebooks.listForCharacter(alice.id)).toEqual([]);
    expect(lorebooks.listAttachmentsForCharacter(alice.id)).toMatchObject([
      { id: book.id, enabled: false },
    ]);

    // Re-enabling restores it; a missing link answers false.
    expect(lorebooks.setAttachmentEnabled(alice.id, book.id, true)).toBe(true);
    expect(lorebooks.listForCharacter(alice.id).map((b) => b.id)).toEqual([book.id]);
    expect(lorebooks.setAttachmentEnabled(alice.id, "missing", true)).toBe(false);
  });

  it("counts character links per lorebook", () => {
    const characters = new CharactersRepository(db);
    const book = lorebooks.create({ name: "World" });
    const other = lorebooks.create({ name: "Other" });
    const alice = characters.create({ name: "Alice" });
    const bob = characters.create({ name: "Bob" });
    lorebooks.attachToCharacter(alice.id, book.id);
    lorebooks.attachToCharacter(bob.id, book.id);
    lorebooks.attachToCharacter(alice.id, other.id);
    const counts = lorebooks.attachmentCounts();
    expect(counts.get(book.id)).toBe(2);
    expect(counts.get(other.id)).toBe(1);
    expect(counts.has("missing")).toBe(false);
  });
});
