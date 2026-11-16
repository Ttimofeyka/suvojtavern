/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestDb } from "../test-utils";
import { CharactersRepository } from "./characters";
import { ChatsRepository } from "./chats";
import { MessagesRepository } from "./messages";
import { PersonasRepository } from "./personas";
import { SummariesRepository } from "./summaries";

let db: Database;
let characterId: string;
let personaId: string;
let chats: ChatsRepository;
let messages: MessagesRepository;
let summaries: SummariesRepository;

beforeEach(() => {
  db = createTestDb();
  const characters = new CharactersRepository(db);
  const personas = new PersonasRepository(db);
  chats = new ChatsRepository(db);
  messages = new MessagesRepository(db);
  summaries = new SummariesRepository(db);
  characterId = characters.create({ name: "Forky" }).id;
  personaId = personas.create({ name: "User" }).id;
});

describe("ChatsRepository", () => {
  it("lists chats of a character, most recently updated first", () => {
    const first = chats.create({ character_id: characterId, title: "First" });
    const second = chats.create({ character_id: characterId, title: "Second" });
    expect(chats.listByCharacter(characterId).map((c) => c.id)).toEqual([second.id, first.id]);
    expect(chats.get(first.id)?.title).toBe("First");
  });

  it("updates and deletes chats (messages cascade)", () => {
    const chat = chats.create({ character_id: characterId, title: "T" });
    messages.insertMessage(chat.id, { role: "user", content: "hi" });
    expect(chats.update(chat.id, { title: "Renamed" })?.title).toBe("Renamed");
    expect(chats.delete(chat.id)).toBe(true);
    expect(messages.listActive(chat.id)).toEqual([]);
    expect(chats.delete(chat.id)).toBe(false);
  });

  it("counts chats per character in one grouped query", () => {
    const other = new CharactersRepository(db).create({ name: "Other" }).id;
    chats.create({ character_id: characterId, title: "a" });
    chats.create({ character_id: characterId, title: "b" });
    chats.create({ character_id: other, title: "c" });

    const counts = chats.countsByCharacter();
    expect(counts.get(characterId)).toBe(2);
    expect(counts.get(other)).toBe(1);
    // Characters with no chats are absent, not zero — callers use `?? 0`.
    expect(counts.has("missing")).toBe(false);
  });

  it("lists and counts chats with a character filter and paging", () => {
    const other = new CharactersRepository(db).create({ name: "Other" }).id;
    const a = chats.create({ character_id: characterId, title: "a" });
    const b = chats.create({ character_id: characterId, title: "b" });
    const c = chats.create({ character_id: characterId, title: "c" });
    const foreign = chats.create({ character_id: other, title: "d" });

    // Newest first; rowid DESC breaks same-millisecond updated_at ties, so
    // the order is the reverse of creation.
    expect(chats.list().map((chat) => chat.id)).toEqual([foreign.id, c.id, b.id, a.id]);
    expect(chats.list({ limit: 2 }).map((chat) => chat.id)).toEqual([foreign.id, c.id]);
    expect(chats.list({ limit: 2, offset: 2 }).map((chat) => chat.id)).toEqual([b.id, a.id]);
    // listByCharacter keeps the same order, just scoped to one character.
    expect(chats.listByCharacter(characterId).map((chat) => chat.id)).toEqual([c.id, b.id, a.id]);
    expect(chats.list({ characterId, limit: 1, offset: 1 }).map((chat) => chat.id)).toEqual([b.id]);

    expect(chats.count()).toBe(4);
    expect(chats.count(characterId)).toBe(3);
    expect(chats.count("missing")).toBe(0);
  });
});

describe("ChatsRepository.forkChat", () => {
  it("copies active history up to the fork point and links parent and child", () => {
    const parent = chats.create({
      character_id: characterId,
      persona_id: personaId,
      title: "Main",
    });
    const m1 = messages.insertMessage(parent.id, { role: "user", content: "hello" });
    const m2 = messages.insertMessage(parent.id, { role: "assistant", content: "hi there" });
    messages.insertMessage(parent.id, { role: "user", content: "bye" });

    const fork = chats.forkChat(m2.id);
    expect(fork).toMatchObject({
      character_id: characterId,
      persona_id: personaId,
      branch_root_id: m2.id,
      active_branch: null,
      title: "Main (branch)",
    });
    expect(chats.get(parent.id)?.active_branch).toBe(fork.id);

    const history = messages.listActive(fork.id);
    expect(history.map((m) => [m.seq, m.content])).toEqual([
      [1, "hello"],
      [2, "hi there"],
    ]);
    expect(history.some((m) => m.id === m1.id || m.id === m2.id)).toBe(false);
    expect(history.every((m) => m.variant_of === null && m.active)).toBe(true);

    const fork2 = chats.forkChat(m1.id, { title: "Custom" });
    expect(fork2.title).toBe("Custom");
    expect(chats.get(parent.id)?.active_branch).toBe(fork2.id);
    expect(messages.listActive(fork2.id).length).toBe(1);
  });

  it("copies only the chosen swipe at the fork position", () => {
    const parent = chats.create({ character_id: characterId });
    messages.insertMessage(parent.id, { role: "user", content: "hello" });
    const m2 = messages.insertMessage(parent.id, { role: "assistant", content: "original" });
    const variant = messages.addVariant(parent.id, m2.id, "alternative");
    messages.setActiveVariant(variant.id);
    messages.insertMessage(parent.id, { role: "user", content: "bye" });

    const fork = chats.forkChat(m2.id);
    expect(messages.listActive(fork.id).map((m) => m.content)).toEqual(["hello", "alternative"]);
    expect(messages.listAll(fork.id).length).toBe(2);
  });

  it("rejects unknown fork points", () => {
    expect(() => chats.forkChat("missing")).toThrow();
  });

  it("copies summaries clamped to the fork point with fresh ids", () => {
    const parent = chats.create({ character_id: characterId, title: "Main" });
    messages.insertMessage(parent.id, { role: "user", content: "one" });
    messages.insertMessage(parent.id, { role: "assistant", content: "two" });
    const m3 = messages.insertMessage(parent.id, { role: "user", content: "three" });
    messages.insertMessage(parent.id, { role: "assistant", content: "four" });

    const s1 = summaries.create(parent.id, { level: 0, seq_from: 1, seq_to: 2, summary: "a" });
    const s2 = summaries.create(parent.id, { level: 0, seq_from: 3, seq_to: 4, summary: "b" });
    const s3 = summaries.create(parent.id, { level: 1, seq_from: 1, seq_to: 4, summary: "c" });
    const parentBefore = summaries.list(parent.id);

    const fork = chats.forkChat(m3.id);
    const copied = summaries.list(fork.id);
    expect(copied.map((s) => [s.level, s.seq_from, s.seq_to])).toEqual([
      [0, 1, 2],
      [0, 3, 3],
      [1, 1, 3],
    ]);

    const childIds = new Set(copied.map((s) => s.id));
    const parentIds = new Set([s1.id, s2.id, s3.id]);
    for (const id of childIds) {
      expect(parentIds.has(id)).toBe(false);
    }

    // The parent's rows are untouched.
    expect(summaries.list(parent.id)).toEqual(parentBefore);
  });

  it("drops summaries that start after the fork point", () => {
    const parent = chats.create({ character_id: characterId });
    const m1 = messages.insertMessage(parent.id, { role: "user", content: "one" });
    messages.insertMessage(parent.id, { role: "assistant", content: "two" });
    messages.insertMessage(parent.id, { role: "user", content: "three" });

    summaries.create(parent.id, { level: 0, seq_from: 1, seq_to: 1, summary: "kept" });
    summaries.create(parent.id, { level: 0, seq_from: 3, seq_to: 3, summary: "dropped" });

    const fork = chats.forkChat(m1.id);
    expect(summaries.list(fork.id).map((s) => s.summary)).toEqual(["kept"]);
  });

  it("forks a parent with no summaries without error", () => {
    const parent = chats.create({ character_id: characterId });
    const m1 = messages.insertMessage(parent.id, { role: "user", content: "one" });
    const fork = chats.forkChat(m1.id);
    expect(summaries.list(fork.id)).toEqual([]);
  });

  it("keeps copied summaries independent from the parent", () => {
    const parent = chats.create({ character_id: characterId });
    messages.insertMessage(parent.id, { role: "user", content: "one" });
    const m2 = messages.insertMessage(parent.id, { role: "assistant", content: "two" });
    const original = summaries.create(parent.id, {
      level: 0,
      seq_from: 1,
      seq_to: 2,
      summary: "original",
    });

    const fork = chats.forkChat(m2.id);
    const [copy] = summaries.list(fork.id);
    expect(copy?.summary).toBe("original");

    // Deleting a covered summary in the parent must not touch the child.
    summaries.deleteIntersecting(parent.id, 1);
    expect(summaries.list(parent.id)).toEqual([]);
    expect(summaries.list(fork.id).map((s) => s.summary)).toEqual(["original"]);

    // Editing / adding in the parent must not leak into the child.
    summaries.update(original.id, { summary: "edited" });
    summaries.create(parent.id, { level: 0, seq_from: 1, seq_to: 1, summary: "added" });
    expect(summaries.list(fork.id).map((s) => s.summary)).toEqual(["original"]);
  });

  it("copies only summaries starting at seq 1 when forking the first message", () => {
    const parent = chats.create({ character_id: characterId });
    const m1 = messages.insertMessage(parent.id, { role: "user", content: "one" });
    messages.insertMessage(parent.id, { role: "assistant", content: "two" });
    messages.insertMessage(parent.id, { role: "user", content: "three" });

    summaries.create(parent.id, { level: 0, seq_from: 1, seq_to: 2, summary: "head" });
    summaries.create(parent.id, { level: 0, seq_from: 2, seq_to: 3, summary: "later" });

    const fork = chats.forkChat(m1.id);
    expect(summaries.list(fork.id).map((s) => [s.seq_from, s.seq_to, s.summary])).toEqual([
      [1, 1, "head"],
    ]);
  });
});
