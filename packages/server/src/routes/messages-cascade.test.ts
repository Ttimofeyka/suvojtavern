/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Chat, Summary } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createApp } from "../app";

/**
 * End-to-end proof that the message-deletion → summary cascade is wired at
 * the REAL composition root (`createApp`), not just inside the repository
 * tests. Deleting a chat POSITION through the HTTP routes must take every
 * intersecting summary (any level) with it, while non-intersecting ranges
 * survive. The cascade runs one microtask after the delete commits, so every
 * deleting test awaits {@link flushCascade} before asserting.
 *
 * `pluginsDir: null` keeps plugin discovery off (hermetic, matching
 * index.test.ts). Each `createApp` wires one cascade listener on the
 * process-wide hook bus; listeners from earlier tests stay registered but
 * act on their own closed-over in-memory db for a foreign chat id, so they
 * no-op. There is no unregister surface on createApp by design.
 */

let db: Database;
let app: ReturnType<typeof createApp>;
let repos: ReturnType<typeof createRepositories>;
let chatId: string;
/** Summary ids of the beforeEach fixture rows. */
let fixture: { lowLeft: string; lowRight: string; high: string };

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  db = openDatabase(":memory:");
  runMigrations(db, migrations);
  app = createApp(db, { pluginsDir: null });
  // Same db, default bus — repository wrappers are stateless over the
  // handle, so this set is only for deterministic seeding and assertions.
  repos = createRepositories(db);
  const characterId = repos.characters.create({
    name: "Sera",
    first_mes: "Hi {{user}}.",
  }).id;
  // Creating the chat through the route inserts the greeting at seq 1.
  const res = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { chat: Chat };
  chatId = body.chat.id;
  // 11 more messages land at seq 2..12, so the chat has 12 positions.
  for (let i = 0; i < 11; i++) {
    repos.messages.insertMessage(chatId, { role: "user", content: `m${i + 2}` });
  }
  const lowLeft = repos.summaries.create(chatId, {
    level: 0,
    seq_from: 1,
    seq_to: 4,
    summary: "covers 1-4",
    tokens: null,
  });
  const lowRight = repos.summaries.create(chatId, {
    level: 0,
    seq_from: 5,
    seq_to: 8,
    summary: "covers 5-8",
    tokens: null,
  });
  const high = repos.summaries.create(chatId, {
    level: 1,
    seq_from: 1,
    seq_to: 8,
    summary: "covers 1-8",
    tokens: null,
  });
  fixture = { lowLeft: lowLeft.id, lowRight: lowRight.id, high: high.id };
});

/**
 * Lets the wiring's microtask-batched cascade pass run: the pass was queued
 * before this promise's resolution, so it always lands first.
 */
const flushCascade = async (): Promise<void> => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
};

/** The active (variant_of-null) message row at `seq`. */
function at(seq: number): string {
  const message = repos.messages
    .listAll(chatId)
    .find((candidate) => candidate.seq === seq && candidate.variant_of === null);
  if (!message) {
    throw new Error(`no message at position ${seq}`);
  }
  return message.id;
}

/** Reads the chat's summaries through the real GET route (expects 200). */
async function routeSummaries(): Promise<Summary[]> {
  const res = await app.request(`/api/chats/${chatId}/summaries`);
  expect(res.status).toBe(200);
  return (await res.json()) as Summary[];
}

describe("message-deletion → summary cascade through createApp", () => {
  it("DELETE /api/messages/:id on a covered position removes intersecting summaries at every level", async () => {
    const res = await app.request(`/api/messages/${at(6)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    await flushCascade();

    // The level-0 [5-8] range and the level-1 [1-8] roll-up both cover
    // position 6; only the non-intersecting [1-4] row survives.
    expect((await routeSummaries()).map((row) => row.id)).toEqual([fixture.lowLeft]);
  });

  it("POST /api/chats/:id/messages/delete-from removes every intersecting summary in one batch", async () => {
    const res = await app.request(
      `/api/chats/${chatId}/messages/delete-from`,
      jsonInit("POST", { from_seq: 6 }),
    );
    expect(res.status).toBe(200);
    // Positions 6..12, one row each.
    expect(await res.json()).toEqual({ ok: true, deleted: 7 });

    await flushCascade();

    // The single batched pass drops [5-8] and [1-8]; [1-4] is untouched.
    expect((await routeSummaries()).map((row) => row.id)).toEqual([fixture.lowLeft]);
  });

  it("deleting an uncovered tail message removes nothing", async () => {
    const res = await app.request(`/api/messages/${at(12)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    await flushCascade();

    // Position 12 sits outside every fixture range.
    expect((await routeSummaries()).map((row) => row.id).sort()).toEqual(
      [fixture.lowLeft, fixture.lowRight, fixture.high].sort(),
    );
  });

  it("deleting a whole chat removes its summaries (FK cascade)", async () => {
    expect(repos.summaries.list(chatId)).toHaveLength(3);

    const res = await app.request(`/api/chats/${chatId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    await flushCascade();

    expect(repos.summaries.list(chatId)).toEqual([]);
    // The chat is gone, so its summaries endpoint 404s.
    expect((await app.request(`/api/chats/${chatId}/summaries`)).status).toBe(404);
  });
});
