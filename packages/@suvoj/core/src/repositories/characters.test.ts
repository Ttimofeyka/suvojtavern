/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { stmt } from "../db/sql";
import { createTestDb } from "../test-utils";
import { CharactersRepository } from "./characters";
import { ChatsRepository } from "./chats";

let db: Database;
let characters: CharactersRepository;

beforeEach(() => {
  db = createTestDb();
  characters = new CharactersRepository(db);
});

describe("CharactersRepository", () => {
  it("round-trips a character, including JSON columns and card_raw", () => {
    const alice = characters.create({
      name: "Alice",
      description: "An expert mage.",
      first_mes: "Hello!",
      tags: ["mage", "cool"],
      alternate_greetings: ["Hi!", "Yo!"],
      card_raw: { spec: "chara_card_v2", data: { name: "Alice" } },
    });
    expect(alice.tags).toEqual(["mage", "cool"]);
    expect(characters.get(alice.id)).toEqual(alice);
  });

  it("lists, filters by tag(s) and searches by name", () => {
    characters.create({ name: "Alice", tags: ["mage"] });
    characters.create({ name: "Bob", tags: ["mage", "bard"] });
    characters.create({ name: "Cera" });
    expect(characters.list().map((c) => c.name)).toEqual(["Alice", "Bob", "Cera"]);
    expect(characters.list({ tags: ["mage"] }).map((c) => c.name)).toEqual(["Alice", "Bob"]);
    // Multiple tags AND together: only a character carrying all of them stays.
    expect(characters.list({ tags: ["mage", "bard"] }).map((c) => c.name)).toEqual(["Bob"]);
    expect(characters.list({ tags: ["mage", "missing"] })).toEqual([]);
    expect(characters.list({ search: "cer" }).map((c) => c.name)).toEqual(["Cera"]);
  });

  it("orders by the requested sort: name (default), created, or recent", () => {
    const a = characters.create({ name: "Alice" });
    const b = characters.create({ name: "Bob" });
    const c = characters.create({ name: "Cera" });

    // Default is name-ascending; an explicit "name" is the same ordering.
    expect(characters.list().map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect(characters.list({ sort: "name" }).map((x) => x.id)).toEqual([a.id, b.id, c.id]);

    // "created" is newest-first. Identical ms timestamps fall back to the
    // rowid DESC tiebreak, i.e. reverse-insertion order...
    const createdIds = (): string[] => characters.list({ sort: "created" }).map((x) => x.id);
    expect(createdIds()).toEqual([c.id, b.id, a.id]);
    // ...while explicit, distinct created_at values decide it outright.
    for (const [id, at] of [
      [a.id, "2024-01-01T00:00:00.000Z"],
      [b.id, "2024-03-01T00:00:00.000Z"],
      [c.id, "2024-02-01T00:00:00.000Z"],
    ] as const) {
      stmt(db, "UPDATE characters SET created_at = ? WHERE id = ?").run(at, id);
    }
    expect(createdIds()).toEqual([b.id, c.id, a.id]);

    // "recent": newest chat activity first, and a character with no chats
    // sinks last (SQLite orders NULLs last under DESC). Explicit timestamps
    // because wall-clock values collide at ms resolution.
    const chats = new ChatsRepository(db);
    const chatA = chats.create({ character_id: a.id });
    const chatC = chats.create({ character_id: c.id });
    stmt(db, "UPDATE chats SET updated_at = ? WHERE id = ?").run(
      "2024-05-01T00:00:00.000Z",
      chatA.id,
    );
    stmt(db, "UPDATE chats SET updated_at = ? WHERE id = ?").run(
      "2024-06-01T00:00:00.000Z",
      chatC.id,
    );
    expect(characters.list({ sort: "recent" }).map((x) => x.id)).toEqual([c.id, a.id, b.id]);
  });

  it("list() returns only the slim list fields, never full card bodies", () => {
    characters.create({ name: "Alice", description: "A mage.", card_raw: { spec: "x" } });
    const [row] = characters.list();
    expect(row).toEqual({
      id: expect.any(String),
      name: "Alice",
      avatar_path: null,
      tags: [],
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(row).not.toHaveProperty("description");
    expect(row).not.toHaveProperty("card_raw");
    expect(row).not.toHaveProperty("first_mes");
    // The full row is still available through get().
    expect(characters.get(row?.id ?? "")?.description).toBe("A mage.");
  });

  it("pages with limit/offset and count() matches the filters", () => {
    for (const name of ["Alice", "Bob", "Cera", "Dana"]) {
      characters.create({ name, tags: name === "Bob" ? ["mage"] : [] });
    }
    expect(characters.list().map((c) => c.name)).toEqual(["Alice", "Bob", "Cera", "Dana"]);
    expect(characters.list({ limit: 2 }).map((c) => c.name)).toEqual(["Alice", "Bob"]);
    expect(characters.list({ limit: 2, offset: 1 }).map((c) => c.name)).toEqual(["Bob", "Cera"]);
    expect(characters.list({ limit: 10, offset: 3 }).map((c) => c.name)).toEqual(["Dana"]);
    // Paging does not change the filter semantics: both see the same WHERE.
    expect(characters.list({ tags: ["mage"], limit: 1 }).map((c) => c.name)).toEqual(["Bob"]);
    expect(characters.count()).toBe(4);
    expect(characters.count({ tags: ["mage"] })).toBe(1);
    expect(characters.count({ search: "a" })).toBe(3); // Alice, Cera, Dana
  });

  it("listTags returns the distinct facet for the same filters, ignoring paging", () => {
    characters.create({ name: "Alice", tags: ["elf", "mage"] });
    characters.create({ name: "Bob", tags: ["elf", "dwarf"] });
    characters.create({ name: "Cera" }); // no tags
    characters.create({ name: "Dana", tags: [] }); // empty tag array

    expect(characters.listTags()).toEqual(["dwarf", "elf", "mage"]);
    // The tag filter narrows the character set, so only tags on matching
    // characters appear. A multi-tag filter ANDs, so elf+mage leaves only
    // Alice — whose tags are the elf/mage facet.
    expect(characters.listTags({ tags: ["elf"] })).toEqual(["dwarf", "elf", "mage"]);
    expect(characters.listTags({ tags: ["mage"] })).toEqual(["elf", "mage"]);
    expect(characters.listTags({ tags: ["elf", "mage"] })).toEqual(["elf", "mage"]);
    expect(characters.listTags({ tags: ["orc"] })).toEqual([]);
    expect(characters.listTags({ search: "ali" })).toEqual(["elf", "mage"]);
    expect(characters.listTags({ search: "bob" })).toEqual(["dwarf", "elf"]);
  });

  it("updates characters, serializing JSON columns", () => {
    const alice = characters.create({ name: "Alice" });
    const updated = characters.update(alice.id, { name: "Alice v2", tags: ["mage"] });
    expect(updated).toMatchObject({ name: "Alice v2", tags: ["mage"] });
    expect(characters.update("missing", { name: "x" })).toBe(null);
  });

  it("manages the image gallery", () => {
    const alice = characters.create({ name: "Alice" });
    const img1 = characters.addImage(alice.id, { blob_path: "data/blobs/1.webp", sort: 1 });
    const img2 = characters.addImage(alice.id, { blob_path: "data/blobs/2.webp", sort: 0 });
    expect(characters.listImages(alice.id).map((i) => i.blob_path)).toEqual([
      "data/blobs/2.webp",
      "data/blobs/1.webp",
    ]);
    expect(characters.updateImage(img1.id, { sort: -1 })?.sort).toBe(-1);
    expect(characters.getImage(img2.id)?.character_id).toBe(alice.id);
    expect(characters.deleteImage(img2.id)).toBe(true);
    expect(characters.listImages(alice.id).length).toBe(1);
  });

  it("deleting a character cascades gallery images but not chats", () => {
    const alice = characters.create({ name: "Alice" });
    characters.addImage(alice.id, { blob_path: "data/blobs/1.webp" });
    expect(characters.delete(alice.id)).toBe(true);
    const remaining = stmt<{ n: number }>(db, "SELECT COUNT(*) AS n FROM character_images").get();
    expect(remaining?.n).toBe(0);

    const bob = characters.create({ name: "Bob" });
    new ChatsRepository(db).create({ character_id: bob.id });
    expect(() => characters.delete(bob.id)).toThrow();
  });
});
