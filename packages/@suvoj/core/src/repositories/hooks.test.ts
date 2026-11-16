/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { at, createTestDb } from "../test-utils";
import { CharactersRepository } from "./characters";
import { ChatsRepository } from "./chats";
import { ChatHookBus, type ChatHookPayload, registerChatHooks } from "./hooks";
import { MessagesRepository } from "./messages";

let db: Database;

/** Chat fixture wired to an isolated hook bus. */
function freshChat(bus: ChatHookBus): { chatId: string; messages: MessagesRepository } {
  const characters = new CharactersRepository(db);
  const chats = new ChatsRepository(db);
  const chat = chats.create({ character_id: characters.create({ name: "Hooky" }).id });
  return { chatId: chat.id, messages: new MessagesRepository(db, bus) };
}

beforeEach(() => {
  db = createTestDb();
});

describe("chat hooks", () => {
  it("fires lifecycle events before and after each write, in order", () => {
    const bus = new ChatHookBus();
    const { chatId, messages } = freshChat(bus);
    const events: string[] = [];
    bus.register({
      beforeInsert: (p) => events.push(`beforeInsert:${p.message?.id}`),
      afterInsert: (p) => events.push(`afterInsert:${p.message?.id}`),
      beforeEdit: (p) => events.push(`beforeEdit:${p.message?.id}`),
      afterEdit: (p) => events.push(`afterEdit:${p.message?.id}`),
      beforeDelete: (p) => events.push(`beforeDelete:${p.message?.id}`),
      afterDelete: (p) => events.push(`afterDelete:${p.message?.id}`),
    });
    const inserted = messages.insertMessage(chatId, { role: "user", content: "hi" });
    messages.editMessageContent(inserted.id, "edited");
    messages.deleteMessage(inserted.id);
    expect(events).toEqual([
      `beforeInsert:${inserted.id}`,
      `afterInsert:${inserted.id}`,
      `beforeEdit:${inserted.id}`,
      `afterEdit:${inserted.id}`,
      `beforeDelete:${inserted.id}`,
      `afterDelete:${inserted.id}`,
    ]);
  });

  it("fires afterDelete only after the deletion is persisted", () => {
    const bus = new ChatHookBus();
    const { chatId, messages } = freshChat(bus);
    const first = messages.insertMessage(chatId, { role: "user", content: "one" });
    const second = messages.insertMessage(chatId, { role: "user", content: "two" });
    messages.insertMessage(chatId, { role: "user", content: "three" });
    // Inside the listener the row (and its whole position) must already be
    // gone — listeners observe the committed state.
    const observed: boolean[] = [];
    bus.register({
      afterDelete: (p) => {
        if (p.message) {
          observed.push(
            messages.get(p.message.id) === null && !messages.positionExists(chatId, p.message.seq),
          );
        }
      },
    });
    expect(messages.deleteMessage(first.id)).toBe(true);
    expect(messages.deleteFromSeq(chatId, second.seq)).toBe(2);
    expect(observed).toEqual([true, true, true]);
  });

  it("fires afterDelete for every row a bulk delete removed", () => {
    const bus = new ChatHookBus();
    const { chatId, messages } = freshChat(bus);
    const first = messages.insertMessage(chatId, { role: "user", content: "one" });
    const variant = messages.addVariant(chatId, first.id, "one (swipe)");
    const second = messages.insertMessage(chatId, { role: "user", content: "two" });
    const deleted: string[] = [];
    bus.register({
      afterDelete: (p) => deleted.push(p.message?.id ?? "?"),
    });
    // The swipe variant is a separate row: bulk deletion removes it too.
    expect(messages.deleteFromSeq(chatId, first.seq)).toBe(3);
    expect(deleted).toEqual([first.id, variant.id, second.id]);
  });

  it("carries chatId, full message rows, and the pre-edit row", () => {
    const bus = new ChatHookBus();
    const { chatId, messages } = freshChat(bus);
    const payloads: ChatHookPayload[] = [];
    bus.register({
      afterInsert: (p) => payloads.push(p),
      afterEdit: (p) => payloads.push(p),
      beforeDelete: (p) => payloads.push(p),
    });
    const inserted = messages.insertMessage(chatId, {
      role: "assistant",
      content: "hi",
      metadata: { token_count: 2 },
    });
    messages.editMessageContent(inserted.id, "edited");
    messages.deleteMessage(inserted.id);

    expect(payloads.every((p) => p.chatId === chatId && p.message?.id === inserted.id)).toBe(true);
    expect(payloads.map((p) => p.message?.metadata)).toEqual([
      { token_count: 2 },
      { token_count: 2 },
      { token_count: 2 },
    ]);
    const afterEdit = at(payloads, 1);
    expect(afterEdit.previous?.content).toBe("hi");
    expect(afterEdit.message?.content).toBe("edited");
  });

  it("lets beforeInsert listeners mutate the row before it is stored", () => {
    const bus = new ChatHookBus();
    const { chatId, messages } = freshChat(bus);
    bus.register({
      beforeInsert: (p) => {
        if (p.message) {
          p.message.content = `${p.message.content}!`;
        }
      },
    });
    const inserted = messages.insertMessage(chatId, { role: "user", content: "hi" });
    expect(inserted.content).toBe("hi!");
    expect(messages.get(inserted.id)?.content).toBe("hi!");
  });

  it("registers on the default bus through registerChatHooks", () => {
    const { chatId, messages } = freshChat(new ChatHookBus());
    // This repo deliberately uses the default bus:
    const defaultMessages = new MessagesRepository(db);
    const inserted: string[] = [];
    const unregister = registerChatHooks({
      afterInsert: (p) => inserted.push(p.message?.id ?? "?"),
    });
    try {
      const m = defaultMessages.insertMessage(chatId, { role: "user", content: "hi" });
      expect(inserted).toEqual([m.id]);
      unregister();
      defaultMessages.insertMessage(chatId, { role: "user", content: "again" });
      expect(inserted).toEqual([m.id]);
      expect(messages.listActive(chatId).length).toBe(2);
    } finally {
      unregister();
    }
  });
});
