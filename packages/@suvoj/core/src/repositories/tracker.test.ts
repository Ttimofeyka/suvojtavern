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
import { TrackerRepository } from "./tracker";

let db: Database;
let chats: ChatsRepository;
let messages: MessagesRepository;
let trackers: TrackerRepository;
let chatId: string;
let otherChatId: string;

beforeEach(() => {
  db = createTestDb();
  const characters = new CharactersRepository(db);
  chats = new ChatsRepository(db);
  messages = new MessagesRepository(db);
  trackers = new TrackerRepository(db);
  const characterId = characters.create({ name: "Tracked" }).id;
  chatId = chats.create({ character_id: characterId }).id;
  otherChatId = chats.create({ character_id: characterId }).id;
});

/** Inserts an assistant message and returns its id (its own new position). */
function addMessage(chat = chatId, content = "m"): string {
  return messages.insertMessage(chat, { role: "assistant", content }).id;
}

/** Attaches a snapshot carrying a `marker` payload to `messageId`. */
function attach(messageId: string | null, marker: string, chat = chatId) {
  return trackers.create(chat, { message_id: messageId, data: { marker } });
}

/** The marker payloads of a snapshot list, in order. */
function markers(snapshots: { data: Record<string, unknown> }[]): unknown[] {
  return snapshots.map((snapshot) => snapshot.data.marker);
}

describe("migrations 005/009 (tracker indexes)", () => {
  it("creates the table with its chat and message indexes", () => {
    const rows = stmt<{ name: string; type: string }>(
      db,
      `SELECT name, type FROM sqlite_master WHERE name IN (
         'tracker_snapshots',
         'idx_tracker_snapshots_chat',
         'idx_tracker_snapshots_message'
       )`,
    ).all();
    expect(rows).toContainEqual({ name: "tracker_snapshots", type: "table" });
    expect(rows).toContainEqual({ name: "idx_tracker_snapshots_chat", type: "index" });
    expect(rows).toContainEqual({ name: "idx_tracker_snapshots_message", type: "index" });
  });
});

describe("TrackerRepository", () => {
  it("creates snapshots with per-chat monotonic seq and defaults", () => {
    const first = trackers.create(chatId, { data: { time: "10:00:00" } });
    expect(first).toMatchObject({
      chat_id: chatId,
      message_id: null,
      seq: 1,
      data: { time: "10:00:00" },
      schema_key: "default",
    });
    expect(typeof first.id).toBe("string");
    expect(typeof first.created_at).toBe("string");

    const second = trackers.create(chatId, {
      data: { time: "10:00:05" },
      message_id: "m1",
      schema_key: "custom",
    });
    expect(second.seq).toBe(2);
    expect(second.message_id).toBe("m1");
    expect(second.schema_key).toBe("custom");

    // Cross-chat isolation: the other chat starts its own chain at 1.
    expect(trackers.create(otherChatId, { data: {} }).seq).toBe(1);
  });

  it("lists by chat ascending by seq", () => {
    for (let i = 0; i < 3; i++) {
      trackers.create(chatId, { data: { i } });
    }
    trackers.create(otherChatId, { data: {} });
    expect(trackers.listByChat(chatId).map((snapshot) => snapshot.seq)).toEqual([1, 2, 3]);
  });

  it("deleteByChat removes only that chat's snapshots", () => {
    for (let i = 0; i < 2; i++) {
      trackers.create(chatId, { data: {} });
    }
    trackers.create(otherChatId, { data: {} });
    expect(trackers.deleteByChat(chatId)).toBe(2);
    expect(trackers.listByChat(chatId)).toEqual([]);
    expect(trackers.listByChat(otherChatId).length).toBe(1);
    expect(trackers.deleteByChat(chatId)).toBe(0);
  });

  it("cascades with the chat", () => {
    trackers.create(chatId, { data: {} });
    trackers.create(otherChatId, { data: {} });
    expect(chats.delete(chatId)).toBe(true);
    expect(trackers.listByChat(chatId)).toEqual([]);
    expect(trackers.listByChat(otherChatId).length).toBe(1);
  });
});

describe("TrackerRepository swipe-aware reads", () => {
  it("listForActiveMessages: newest snapshot per active position, oldest → newest", () => {
    const m1 = addMessage(chatId, "m1");
    const m2 = addMessage(chatId, "m2");
    const m3 = addMessage(chatId, "m3");
    const otherMessage = addMessage(otherChatId, "other");

    attach(m1, "m1");
    attach(m2, "m2-old");
    const m2Newest = attach(m2, "m2-new");
    attach(m3, "m3");
    attach(otherMessage, "other", otherChatId);
    attach(null, "orphan");

    // One row per active position: the older m2 snapshot and the
    // unattached/other-chat rows are excluded.
    expect(markers(trackers.listForActiveMessages(chatId, 10))).toEqual(["m1", "m2-new", "m3"]);
    // `limit` counts POSITIONS, paging from the newest down.
    expect(markers(trackers.listForActiveMessages(chatId, 2))).toEqual(["m2-new", "m3"]);
    expect(markers(trackers.listForActiveMessages(chatId, 1))).toEqual(["m3"]);
    expect(trackers.listForActiveMessages(chatId, 0)).toEqual([]);
    expect(trackers.listForActiveMessages(chatId, -3)).toEqual([]);
    expect(markers(trackers.listForActiveMessages(otherChatId, 10))).toEqual(["other"]);
    expect(trackers.getForMessage(m2)?.id).toBe(m2Newest.id);
  });

  it("listForActiveMessages: follows the selected swipe, ignoring inactive siblings", () => {
    const root = addMessage(chatId, "root");
    const swipe = messages.addVariant(chatId, root, "swipe");
    attach(root, "root-snapshot");
    attach(swipe.id, "swipe-snapshot");

    // The root is the active swipe until the switch, so its snapshot wins.
    expect(markers(trackers.listForActiveMessages(chatId, 10))).toEqual(["root-snapshot"]);
    messages.setActiveVariant(swipe.id);
    expect(markers(trackers.listForActiveMessages(chatId, 10))).toEqual(["swipe-snapshot"]);
  });

  it("listForMessagesBefore: excludes the target position's whole sibling group", () => {
    const m1 = addMessage(chatId, "m1");
    const m2 = addMessage(chatId, "m2");
    const m3Root = addMessage(chatId, "m3");
    const m3Swipe = messages.addVariant(chatId, m3Root, "m3 swipe");
    attach(m1, "m1");
    attach(m2, "m2");
    attach(m3Root, "m3-root");
    attach(m3Swipe.id, "m3-swipe");

    // Positions strictly before seq 3: m1 and m2 — the m3 group (root AND
    // its swipe share seq 3) is excluded entirely.
    expect(markers(trackers.listForMessagesBefore(chatId, 3, 10))).toEqual(["m1", "m2"]);
    // The newest `limit` positions below the target.
    expect(markers(trackers.listForMessagesBefore(chatId, 3, 1))).toEqual(["m2"]);
    // Nothing precedes the first position.
    expect(trackers.listForMessagesBefore(chatId, 1, 10)).toEqual([]);
    expect(trackers.listForMessagesBefore(chatId, 3, 0)).toEqual([]);
  });

  it("getForMessage returns the newest snapshot for a message or null", () => {
    const message = addMessage(chatId);
    expect(trackers.getForMessage(message)).toBe(null);
    attach(message, "old");
    const newest = attach(message, "new");
    expect(trackers.getForMessage(message)?.data.marker).toBe("new");
    expect(trackers.getForMessage(message)?.id).toBe(newest.id);
    expect(trackers.getForMessage("nope")).toBe(null);
  });

  it("deleteForMessage removes only that message's snapshots", () => {
    const a = addMessage(chatId);
    const b = addMessage(chatId);
    attach(a, "a1");
    attach(a, "a2");
    attach(b, "b");
    expect(trackers.deleteForMessage(a)).toBe(2);
    expect(markers(trackers.listByChat(chatId))).toEqual(["b"]);
    expect(trackers.deleteForMessage(a)).toBe(0);
  });
});

describe("TrackerRepository.pruneTo (swipe-aware retention)", () => {
  it("keeps the newest snapshot per swipe for the newest positions", () => {
    const m1 = addMessage(chatId, "m1");
    const m2 = addMessage(chatId, "m2");
    const m3 = addMessage(chatId, "m3");
    attach(m1, "m1-old");
    attach(m1, "m1-new");
    attach(m2, "m2");
    attach(m3, "m3");
    attach(null, "orphan");
    attach(null, "other-orphan", otherChatId);

    // Positions 2 and 3 survive: the seq-1 pair and the unattached row go.
    expect(trackers.pruneTo(chatId, 2)).toBe(3);
    expect(markers(trackers.listByChat(chatId))).toEqual(["m2", "m3"]);
    // The other chat is untouched by this chat's prune.
    expect(markers(trackers.listByChat(otherChatId))).toEqual(["other-orphan"]);

    // A stale duplicate at a retained position is dropped; the newest
    // snapshot of that swipe survives.
    const m2Newest = attach(m2, "m2-new");
    expect(trackers.pruneTo(chatId, 2)).toBe(1);
    expect(markers(trackers.listByChat(chatId))).toEqual(["m3", "m2-new"]);
    expect(trackers.getForMessage(m2)?.id).toBe(m2Newest.id);

    // keepLast ≤ 0 is treated as 1: only the newest position survives.
    expect(trackers.pruneTo(chatId, 0)).toBe(1);
    expect(markers(trackers.listByChat(chatId))).toEqual(["m3"]);

    // Keeping more positions than exist deletes nothing.
    expect(trackers.pruneTo(chatId, 10)).toBe(0);
  });

  it("keeps a tracked position across untracked newer positions", () => {
    const m1 = addMessage(chatId, "m1");
    addMessage(chatId, "m2");
    const m3 = addMessage(chatId, "m3");
    addMessage(chatId, "m4");
    attach(m1, "m1");
    attach(m3, "m3");

    // The two newest TRACKED positions are 3 and 1, so both survive even
    // though the raw window (4, 3) would have dropped m1's snapshot.
    expect(trackers.pruneTo(chatId, 2)).toBe(0);
    expect(markers(trackers.listByChat(chatId))).toEqual(["m1", "m3"]);

    // With only the newest tracked position retained, the older one goes.
    expect(trackers.pruneTo(chatId, 1)).toBe(1);
    expect(markers(trackers.listByChat(chatId))).toEqual(["m3"]);
  });
});
