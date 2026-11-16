/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { stmt } from "../db/sql";
import { createTestDb } from "../test-utils";
import { CharactersRepository } from "./characters";
import { ChatsRepository } from "./chats";
import { MessagesRepository } from "./messages";

let db: Database;
let chatId: string;
let messages: MessagesRepository;

beforeEach(() => {
  db = createTestDb();
  const characters = new CharactersRepository(db);
  const chats = new ChatsRepository(db);
  messages = new MessagesRepository(db);
  chatId = chats.create({ character_id: characters.create({ name: "Seraphina" }).id }).id;
});

describe("MessagesRepository variant chaining (regression)", () => {
  it("anchors swipes added via a variant's id to the group root", () => {
    messages.insertMessage(chatId, { role: "user", content: "hello" });
    const root = messages.insertMessage(chatId, { role: "assistant", content: "hi" });

    // The generate flow passes the last active message's id — after one
    // regenerate that is a variant, not the group root.
    const v1 = messages.addVariant(chatId, root.id, "hi there");
    const v2 = messages.addVariant(chatId, v1.id, "greetings");

    expect(v1.variant_of).toBe(root.id);
    expect(v2.variant_of).toBe(root.id); // star, not root ← v1 ← v2
    expect([v1.seq, v2.seq]).toEqual([root.seq, root.seq]);

    const siblings = messages.listMessageWithSiblings(root.id);
    expect(siblings.map((s) => s.id)).toEqual([root.id, v1.id, v2.id]);
  });

  it("keeps exactly one active row per position when swiping back and forth", () => {
    messages.insertMessage(chatId, { role: "user", content: "hello" });
    const root = messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    const v1 = messages.addVariant(chatId, root.id, "hi there");
    const v2 = messages.addVariant(chatId, v1.id, "greetings");

    const activeIds = () =>
      messages
        .listAll(chatId)
        .filter((m) => m.seq === root.seq && m.active)
        .map((m) => m.id);

    // Swiping back to the root after a chained add used to leave the
    // chained variant active as well ([true, false, true]).
    messages.setActiveVariant(root.id);
    expect(activeIds()).toEqual([root.id]);

    messages.setActiveVariant(v2.id);
    expect(activeIds()).toEqual([v2.id]);
    expect(
      messages
        .listMessageWithSiblings(root.id)
        .filter((s) => s.active)
        .map((s) => s.id),
    ).toEqual([v2.id]);

    // Prompt building sees exactly one row for the group.
    expect(messages.listActive(chatId).map((m) => m.content)).toEqual(["hello", "greetings"]);
  });

  it("deactivates chained legacy rows when activating a variant", () => {
    messages.insertMessage(chatId, { role: "user", content: "hello" });
    const root = messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    const v1 = messages.addVariant(chatId, root.id, "hi there");
    const v2 = messages.addVariant(chatId, root.id, "greetings");

    // Simulate pre-fix data: v2 chained onto v1 (root ← v1 ← v2) with the
    // root and the chained variant both active.
    stmt(db, "UPDATE messages SET variant_of = ? WHERE id = ?").run(v1.id, v2.id);
    stmt(db, "UPDATE messages SET active = 1 WHERE id IN (?, ?)").run(root.id, v2.id);

    const active = messages.setActiveVariant(root.id);
    expect(active.active).toBe(true);
    expect(
      messages
        .listAll(chatId)
        .filter((m) => m.seq === root.seq && m.active)
        .map((m) => m.id),
    ).toEqual([root.id]);
    expect(messages.listActive(chatId).map((m) => m.content)).toEqual(["hello", "hi"]);
  });
});
