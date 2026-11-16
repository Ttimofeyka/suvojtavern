/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createTestDb } from "../test-utils";
import { ChatHookBus } from "./hooks";
import { createRepositories, type Repositories } from "./index";
import { wireTrackerCascade } from "./tracker-cascade";

/**
 * Cascade tests over a full repository set: deleting a message row takes
 * EVERY snapshot attached to that exact row with it (no per-position gate —
 * snapshots attach to one row, not one chat position). Each test wires the
 * cascade explicitly (the composition root owns this wiring — see app.ts) on
 * its own hook bus.
 *
 * The wiring coalesces deletions into microtask batches (one pass per batch),
 * so every deleting test awaits {@link flushCascade} before asserting.
 */

let db: Database;
let repos: Repositories;
let chatId: string;
let otherChatId: string;
const offs: Array<() => void> = [];

beforeEach(() => {
  db = createTestDb();
  const bus = new ChatHookBus();
  repos = createRepositories(db, bus);
  offs.push(wireTrackerCascade({ repos, hooks: bus }));
  const characterId = repos.characters.create({ name: "Cascade" }).id;
  chatId = repos.chats.create({ character_id: characterId }).id;
  otherChatId = repos.chats.create({ character_id: characterId }).id;
});

afterEach(() => {
  for (const off of offs.splice(0)) {
    off();
  }
});

/**
 * Lets the wiring's microtask-batched cascade pass run: the flush was queued
 * before this promise's resolution, so it always lands first.
 */
const flushCascade = async (): Promise<void> => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
};

/** Appends a message and returns its id (its own new position). */
function insert(chat = chatId, content = "m"): string {
  return repos.messages.insertMessage(chat, { role: "assistant", content }).id;
}

/** Attaches a snapshot carrying a `marker` payload to `messageId`. */
function attach(messageId: string | null, marker: string, chat = chatId): void {
  repos.trackers.create(chat, { message_id: messageId, data: { marker } });
}

/** The marker payloads of a chat's snapshots, oldest → newest. */
function markers(chat = chatId): unknown[] {
  return repos.trackers.listByChat(chat).map((snapshot) => snapshot.data.marker);
}

describe("message-deletion tracker cascade", () => {
  it("deleting one swipe drops only that row's snapshots", async () => {
    const root = insert();
    const swipe = repos.messages.addVariant(chatId, root, "swipe").id;
    attach(root, "root");
    attach(swipe, "swipe");

    expect(repos.messages.deleteMessage(swipe)).toBe(true);
    await flushCascade();

    // The sibling row keeps the position (and its own snapshot) alive.
    expect(markers()).toEqual(["root"]);
  });

  it("deleteMessageGroup drops every swipe's snapshots at the position", async () => {
    const root = insert();
    const swipe = repos.messages.addVariant(chatId, root, "swipe").id;
    const tail = insert(chatId, "tail");
    attach(root, "root");
    attach(swipe, "swipe");
    attach(tail, "tail");

    expect(repos.messages.deleteMessageGroup(root)).toBe(true);
    await flushCascade();

    expect(markers()).toEqual(["tail"]);
  });

  it("deleteFromSeq drops all snapshots in the deleted range", async () => {
    const first = insert(chatId, "m1");
    const second = insert(chatId, "m2");
    const third = insert(chatId, "m3");
    attach(first, "m1");
    attach(second, "m2");
    attach(third, "m3");

    expect(repos.messages.deleteFromSeq(chatId, 2)).toBe(2);
    await flushCascade();

    expect(markers()).toEqual(["m1"]);
  });

  it("leaves another chat's snapshots untouched", async () => {
    const mine = insert(chatId, "mine");
    const theirs = insert(otherChatId, "theirs");
    attach(mine, "mine");
    attach(theirs, "theirs", otherChatId);

    repos.messages.deleteMessage(mine);
    await flushCascade();

    expect(markers()).toEqual([]);
    expect(markers(otherChatId)).toEqual(["theirs"]);
  });

  it("leaves an unattached (legacy/manual) snapshot untouched", async () => {
    const message = insert(chatId, "m");
    attach(null, "orphan");
    attach(message, "attached");

    repos.messages.deleteMessage(message);
    await flushCascade();

    expect(markers()).toEqual(["orphan"]);
  });

  it("collapses a bulk delete into one batched pass", async () => {
    for (let i = 0; i < 5; i++) {
      attach(insert(chatId, `m${i}`), `m${i}`);
    }
    // A `deleteFromSeq` emits one afterDelete per row, but the wiring must
    // coalesce them: one batched delete for the whole bulk.
    const spy = spyOn(repos.trackers, "deleteForMessages");

    expect(repos.messages.deleteFromSeq(chatId, 1)).toBe(5);
    await flushCascade();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(5);
    expect(markers()).toEqual([]);
    spy.mockRestore();
  });
});
