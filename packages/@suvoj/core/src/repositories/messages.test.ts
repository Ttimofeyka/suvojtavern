/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { stmt } from "../db/sql";
import { createTestDb } from "../test-utils";
import { CharactersRepository } from "./characters";
import { ChatsRepository } from "./chats";
import type { ChatHookPayload } from "./hooks";
import { ChatHookBus } from "./hooks";
import { MessagesRepository } from "./messages";

let db: Database;
let chats: ChatsRepository;
let chatId: string;
let messages: MessagesRepository;

beforeEach(() => {
  db = createTestDb();
  const characters = new CharactersRepository(db);
  chats = new ChatsRepository(db);
  messages = new MessagesRepository(db);
  chatId = chats.create({ character_id: characters.create({ name: "Seraphina" }).id }).id;
});

describe("MessagesRepository", () => {
  it("appends messages with increasing seq and lists the active history", () => {
    const m1 = messages.insertMessage(chatId, { role: "user", content: "hello" });
    const m2 = messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    messages.insertMessage(chatId, { role: "user", content: "again" });
    expect([m1.seq, m2.seq]).toEqual([1, 2]);
    expect(messages.listActive(chatId).map((m) => [m.seq, m.role, m.content])).toEqual([
      [1, "user", "hello"],
      [2, "assistant", "hi"],
      [3, "user", "again"],
    ]);
  });

  it("adds swipes as inactive siblings sharing the group seq", () => {
    const m1 = messages.insertMessage(chatId, { role: "user", content: "hello" });
    const m2 = messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    const v1 = messages.addVariant(chatId, m2.id, "hi there");
    const v2 = messages.addVariant(chatId, m2.id, "greetings");

    const siblings = messages.listMessageWithSiblings(m2.id);
    expect(siblings.map((s) => s.id)).toEqual([m2.id, v1.id, v2.id]);
    expect(siblings.map((s) => s.seq)).toEqual([2, 2, 2]);
    expect(siblings.filter((s) => s.active).map((s) => s.id)).toEqual([m2.id]);
    expect(v1.variant_of).toBe(m2.id);
    expect(messages.listMessageWithSiblings(m1.id).length).toBe(1);
    expect(() => messages.addVariant(chatId, "missing", "x")).toThrow();
  });

  it("switches the active swipe, keeping exactly one active per group", () => {
    messages.insertMessage(chatId, { role: "user", content: "hello" });
    const m2 = messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    messages.addVariant(chatId, m2.id, "hi there");
    const v2 = messages.addVariant(chatId, m2.id, "greetings");

    const switched = messages.setActiveVariant(v2.id);
    expect(switched.active).toBe(true);
    const siblings = messages.listMessageWithSiblings(m2.id);
    expect(siblings.filter((s) => s.active)).toEqual([switched]);
    expect(messages.listActive(chatId).map((m) => m.content)).toEqual(["hello", "greetings"]);
  });

  it("edits message content", () => {
    const m = messages.insertMessage(chatId, { role: "user", content: "hello" });
    expect(messages.editMessageContent(m.id, "hello there")?.content).toBe("hello there");
    expect(messages.get(m.id)?.content).toBe("hello there");
    expect(messages.editMessageContent("missing", "x")).toBe(null);
  });

  it("updates metadata when passed, leaves it untouched when omitted", () => {
    const m = messages.insertMessage(chatId, {
      role: "assistant",
      content: "hi",
      metadata: { reasoning: "think" },
    });

    // Omitted → the stored metadata survives (the text-edit PATCH path).
    const edited = messages.editMessageContent(m.id, "hi there");
    expect(edited?.metadata).toEqual({ reasoning: "think" });
    expect(messages.get(m.id)?.metadata).toEqual({ reasoning: "think" });

    // Passed → the metadata column is replaced wholesale.
    const replaced = messages.editMessageContent(m.id, "hi there", {
      reasoning: "think",
      regex_applied: true,
    });
    expect(replaced?.metadata).toEqual({ reasoning: "think", regex_applied: true });
    expect(messages.get(m.id)?.metadata).toEqual({ reasoning: "think", regex_applied: true });

    // Explicit null clears the column rather than leaving it untouched.
    const cleared = messages.editMessageContent(m.id, "hi there", null);
    expect(cleared?.metadata).toBe(null);
    expect(messages.get(m.id)?.metadata).toBe(null);
  });

  it("reports the pre- and post-edit rows to the hook bus, metadata included", () => {
    const bus = new ChatHookBus();
    const hooked = new MessagesRepository(db, bus);
    const inserted = hooked.insertMessage(chatId, {
      role: "assistant",
      content: "hi",
      metadata: { reasoning: "think" },
    });
    const payloads: ChatHookPayload[] = [];
    bus.register({
      beforeEdit: (payload) => payloads.push(payload),
      afterEdit: (payload) => payloads.push(payload),
    });

    hooked.editMessageContent(inserted.id, "hi there", { reasoning: "think", regex_applied: true });

    expect(payloads).toHaveLength(2);
    const [before, after] = payloads;
    expect(before?.chatId).toBe(chatId);
    // beforeEdit carries the pre-edit row as `message` (not `previous`).
    expect(before?.message?.content).toBe("hi");
    expect(before?.message?.metadata).toEqual({ reasoning: "think" });
    expect(before?.previous).toBeUndefined();
    expect(after?.previous?.content).toBe("hi");
    expect(after?.previous?.metadata).toEqual({ reasoning: "think" });
    expect(after?.message?.content).toBe("hi there");
    expect(after?.message?.metadata).toEqual({ reasoning: "think", regex_applied: true });
  });

  it("deletes messages while keeping the group consistent", () => {
    messages.insertMessage(chatId, { role: "user", content: "hello" });
    const m2 = messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    const v1 = messages.addVariant(chatId, m2.id, "hi there");
    const v2 = messages.addVariant(chatId, m2.id, "greetings");

    // deleting the active swipe falls back to the group root
    messages.setActiveVariant(v1.id);
    expect(messages.deleteMessage(v1.id)).toBe(true);
    expect(messages.get(m2.id)?.active).toBe(true);

    // deleting the root promotes the oldest sibling and keeps it active
    expect(messages.deleteMessage(m2.id)).toBe(true);
    expect(messages.get(v2.id)).toMatchObject({ variant_of: null, active: true });
    expect(messages.listActive(chatId).map((m) => m.content)).toEqual(["hello", "greetings"]);
    expect(messages.deleteMessage("missing")).toBe(false);
  });

  it("deletes a whole message position, every swipe included", () => {
    messages.insertMessage(chatId, { role: "user", content: "hello" });
    const m2 = messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    const v1 = messages.addVariant(chatId, m2.id, "hi there");
    const v2 = messages.addVariant(chatId, m2.id, "greetings");
    messages.insertMessage(chatId, { role: "user", content: "again" });

    expect(messages.deleteMessageGroup(m2.id)).toBe(true);
    // The target row AND both swipes are gone — the position disappears.
    for (const id of [m2.id, v1.id, v2.id]) {
      expect(messages.get(id)).toBeNull();
    }
    // Neighbouring positions are untouched.
    expect(messages.listAll(chatId).map((m) => [m.seq, m.content])).toEqual([
      [1, "hello"],
      [3, "again"],
    ]);
    // An unknown id is a no-op, not an error.
    expect(messages.deleteMessageGroup("missing")).toBe(false);
  });

  it("deletes every swipe variant from a position to the end of the chat", () => {
    messages.insertMessage(chatId, { role: "user", content: "one" });
    const m2 = messages.insertMessage(chatId, { role: "assistant", content: "two" });
    const v2 = messages.addVariant(chatId, m2.id, "two (swipe)");
    const m3 = messages.insertMessage(chatId, { role: "user", content: "three" });

    // Backdate the chat so the activity refresh is observable even within
    // the same millisecond as the previous timestamp.
    const backdated = "2020-01-01T00:00:00.000Z";
    stmt(db, "UPDATE chats SET updated_at = ? WHERE id = ?").run(backdated, chatId);

    expect(messages.deleteFromSeq(chatId, m2.seq)).toBe(3); // m2 + v2 + m3
    expect(messages.listAll(chatId).map((m) => [m.seq, m.content])).toEqual([[1, "one"]]);
    expect(messages.get(v2.id)).toBeNull();
    expect(messages.get(m3.id)).toBeNull();
    expect((chats.get(chatId)?.updated_at ?? "") > backdated).toBe(true);

    // A position beyond the last one matches nothing and is not an error.
    expect(messages.deleteFromSeq(chatId, 99)).toBe(0);
    expect(messages.listAll(chatId).length).toBe(1);
  });

  it("refreshes the chat's updated_at on insert, variant, edit and delete", () => {
    // Backdate before each mutation so the bump is observable even when it
    // lands within the same millisecond as the previous timestamp.
    const backdated = "2020-01-01T00:00:00.000Z";
    const backdate = (): void => {
      stmt(db, "UPDATE chats SET updated_at = ? WHERE id = ?").run(backdated, chatId);
    };
    const bumped = (): boolean => (chats.get(chatId)?.updated_at ?? "") > backdated;

    backdate();
    const m1 = messages.insertMessage(chatId, { role: "user", content: "hello" });
    expect(bumped()).toBe(true);

    backdate();
    const m2 = messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    expect(bumped()).toBe(true);

    backdate();
    messages.addVariant(chatId, m2.id, "hi there");
    expect(bumped()).toBe(true);

    backdate();
    messages.editMessageContent(m1.id, "hello there");
    expect(bumped()).toBe(true);

    backdate();
    messages.deleteMessage(m2.id);
    expect(bumped()).toBe(true);
  });
});
