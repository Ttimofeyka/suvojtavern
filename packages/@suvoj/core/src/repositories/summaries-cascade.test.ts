/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createTestDb } from "../test-utils";
import { ChatHookBus } from "./hooks";
import {
  createRepositories,
  type Repositories,
  type SummaryLifecycleEvent,
  summaryEvents,
} from "./index";
import { applySummaryClear, wireSummaryCascade } from "./summary-cascade";

/**
 * Cascade tests over a full repository set: deleting a covered message
 * position takes every intersecting summary (all levels) with it and
 * un-hides the positions only those summaries were hiding. Each test
 * wires the cascade explicitly (the composition root owns this wiring —
 * see app.ts) on its own hook bus, and collects lifecycle events on the
 * process-wide summary bus.
 *
 * The wiring coalesces deletions into microtask batches (one cascade
 * pass per batch), so every deleting test awaits {@link flushCascade}
 * before asserting — the events fire one microtask after the delete
 * calls return.
 */

let db: Database;
let repos: Repositories;
let chatId: string;
/** Summary ids of the beforeEach fixture rows. */
let fixture: { lowLeft: string; lowRight: string; high: string };
const offs: Array<() => void> = [];

beforeEach(() => {
  db = createTestDb();
  const bus = new ChatHookBus();
  repos = createRepositories(db, bus);
  wireSummaryCascade({ db, repos, hooks: bus });
  const characterId = repos.characters.create({ name: "Cascade" }).id;
  chatId = repos.chats.create({ character_id: characterId }).id;
  for (let i = 0; i < 12; i++) {
    repos.messages.insertMessage(chatId, { role: "user", content: `m${i + 1}` });
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

afterEach(() => {
  for (const off of offs.splice(0)) {
    off();
  }
});

/**
 * Lets the wiring's microtask-batched cascade pass run: the flush was
 * queued before this promise's resolution, so it always lands first.
 */
const flushCascade = async (): Promise<void> => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
};

/** Registers a lifecycle listener collecting events; returns the collector. */
function collectEvents(): SummaryLifecycleEvent[] {
  const events: SummaryLifecycleEvent[] = [];
  offs.push(summaryEvents.register((event) => events.push(event)));
  return events;
}

/** The message row (the active one) at `seq`. */
function at(seq: number): string {
  const message = repos.messages
    .listAll(chatId)
    .find((candidate) => candidate.seq === seq && candidate.variant_of === null);
  if (!message) {
    throw new Error(`no message at position ${seq}`);
  }
  return message.id;
}

describe("SummariesRepository ranges", () => {
  it("listIntersecting matches every level whose range includes the seq", () => {
    const ids = repos.summaries.listIntersecting(chatId, 6).map((row) => row.id);
    expect(ids).toContain(fixture.lowRight);
    expect(ids).toContain(fixture.high);
    expect(ids).not.toContain(fixture.lowLeft);
  });

  it("listIntersecting accepts a set of seqs — one pass over the union of ranges", () => {
    const ids = repos.summaries.listIntersecting(chatId, [2, 6, 40]).map((row) => row.id);
    expect(ids.sort()).toEqual([fixture.lowLeft, fixture.lowRight, fixture.high].sort());
  });

  it("deleteIntersecting removes and returns exactly the intersecting rows", () => {
    const removed = repos.summaries.deleteIntersecting(chatId, [4, 5]);
    expect(removed.map((row) => row.id).sort()).toEqual(
      [fixture.lowLeft, fixture.lowRight, fixture.high].sort(),
    );
    expect(repos.summaries.list(chatId)).toEqual([]);
  });

  it("deleteIntersecting keeps non-intersecting rows and survives empty input", () => {
    expect(repos.summaries.deleteIntersecting(chatId, [])).toEqual([]);
    expect(repos.summaries.deleteIntersecting(chatId, 9)).toEqual([]);
    expect(repos.summaries.list(chatId)).toHaveLength(3);
  });

  it("replaceChatSummaries swaps the chat's rows in one transaction", () => {
    const { deleted, created } = repos.summaries.replaceChatSummaries(chatId, [
      { level: 1, seq_from: 1, seq_to: 8, summary: "imported high", tokens: 4 },
      { level: 0, seq_from: 1, seq_to: 2, summary: "imported low" }, // tokens defaults null
    ]);

    // The fixture rows were removed, exactly the imported rows stored
    // (ids regenerated).
    expect(deleted.map((row) => row.id).sort()).toEqual(
      [fixture.lowLeft, fixture.lowRight, fixture.high].sort(),
    );
    expect(created.map((row) => row.summary).sort()).toEqual(["imported high", "imported low"]);
    const rows = repos.summaries.list(chatId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(created.map((row) => row.id)));
    expect(rows.find((row) => row.summary === "imported low")).toMatchObject({ tokens: null });
  });

  it("replaceChatSummaries rolls the whole swap back when a row is invalid", () => {
    // The route pre-validates rows, but the method guarantees its own
    // atomicity: a failing insert leaves the existing rows untouched.
    expect(() =>
      repos.summaries.replaceChatSummaries(chatId, [
        { level: 0, seq_from: 1, seq_to: 1, summary: "ok", tokens: 1 },
        { level: -1, seq_from: 2, seq_to: 2, summary: "bad", tokens: 1 },
      ]),
    ).toThrow();
    expect(
      repos.summaries
        .list(chatId)
        .map((row) => row.id)
        .sort(),
    ).toEqual([fixture.lowLeft, fixture.lowRight, fixture.high].sort());
  });
});

describe("message-deletion summary cascade", () => {
  it("deleting a covered position removes intersecting summaries at every level", async () => {
    const events = collectEvents();
    repos.messages.deleteMessage(at(6));
    await flushCascade();

    // Both the level-0 range and the level-1 roll-up covering position 6
    // are gone; the non-intersecting 1–4 level-0 survives.
    expect(repos.summaries.list(chatId).map((row) => row.id)).toEqual([fixture.lowLeft]);

    // One event: the deleted rows (both levels) plus the positions 5–8
    // returned to the live window, minus the deleted position itself.
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.chatId).toBe(chatId);
    expect(event?.created).toEqual([]);
    expect(event?.deleted.map((row) => row.id).sort()).toEqual(
      [fixture.lowRight, fixture.high].sort(),
    );
    expect(event?.unhiddenSeqs).toEqual([5, 7, 8]);
  });

  it("a mid-gap deletion unhides the survivors even when the frontier holder lives", async () => {
    // The reviewer's repro shape: [1-4], [5-8], [9-12] (all level 0) and
    // message 6 vanishes. [9-12] holds the old scalar frontier, so a
    // before/after frontier diff derives NOTHING unhidden — 5, 7, 8 would
    // stay hidden with no row covering them. The drop of the fixture's
    // level-1 roll-up mirrors the pure repro.
    repos.summaries.delete(fixture.high);
    const right = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 9,
      seq_to: 12,
      summary: "covers 9-12",
      tokens: null,
    });
    const events = collectEvents();

    repos.messages.deleteMessage(at(6));
    await flushCascade();

    // [5-8] died with the position; [1-4] and [9-12] survive untouched.
    expect(
      repos.summaries
        .list(chatId)
        .map((row) => row.id)
        .sort(),
    ).toEqual([fixture.lowLeft, right.id].sort());
    expect(events).toHaveLength(1);
    expect(events[0]?.deleted.map((row) => row.id)).toEqual([fixture.lowRight]);
    // Exactly the uncovered survivors of the deleted range: 5, 7, 8 (the
    // vanished 6 has no message row to return).
    expect(events[0]?.unhiddenSeqs).toEqual([5, 7, 8]);
  });

  it("deleting a swipe variant whose group survives triggers nothing", async () => {
    const events = collectEvents();
    const variant = repos.messages.addVariant(chatId, at(6), "a swipe");

    repos.messages.deleteMessage(variant.id);
    await flushCascade();

    expect(repos.summaries.list(chatId)).toHaveLength(3);
    expect(events).toEqual([]);
  });

  it("deleteFromSeq collapses into one event with the batch's unhidden diff", async () => {
    const events = collectEvents();

    const deleted = repos.messages.deleteFromSeq(chatId, 6);

    expect(deleted).toBe(7); // positions 6..12
    await flushCascade();
    // The whole batch ran through ONE cascade pass — one lifecycle event
    // for the entire bulk deletion, with every intersecting row deleted
    // and the combined ranges' unhidden diff.
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.deleted.map((row) => row.id).sort()).toEqual(
      [fixture.lowRight, fixture.high].sort(),
    );
    // Positions 7 and 8 lost their messages to the bulk deletion; only 5
    // came back to the live window.
    expect(event?.unhiddenSeqs).toEqual([5]);
    expect(repos.summaries.list(chatId).map((row) => row.id)).toEqual([fixture.lowLeft]);
  });

  it("a bulk delete intersecting several disjoint summaries is one pass, one event", async () => {
    // A second, disjoint chunk: the batch below spans both.
    const right = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 9,
      seq_to: 12,
      summary: "covers 9-12",
      tokens: null,
    });
    const events = collectEvents();

    const deleted = repos.messages.deleteFromSeq(chatId, 2);

    expect(deleted).toBe(11); // positions 2..12
    await flushCascade();
    // Every row intersecting the batch died in the single pass…
    expect(events).toHaveLength(1);
    expect(events[0]?.deleted.map((row) => row.id).sort()).toEqual(
      [fixture.lowLeft, fixture.lowRight, fixture.high, right.id].sort(),
    );
    // …and only position 1 still has a message row inside the deleted
    // ranges — it alone returned to the live window.
    expect(events[0]?.unhiddenSeqs).toEqual([1]);
    expect(repos.summaries.list(chatId)).toEqual([]);
  });

  it("a throwing lifecycle listener neither wedges the queue nor blocks later batches", async () => {
    // The healthy listener runs first; the thrower (registered second)
    // blows up on the FIRST event only. The error escapes the pass
    // (logged, never fatal), and the NEXT batch's pass still runs and
    // emits — the microtask queue never wedges.
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const seen: SummaryLifecycleEvent[] = [];
      offs.push(summaryEvents.register((event) => seen.push(event)));
      let boomed = false;
      offs.push(
        summaryEvents.register(() => {
          if (!boomed) {
            boomed = true;
            throw new Error("listener boom");
          }
        }),
      );

      repos.messages.deleteMessage(at(6)); // covered → the pass throws in its listener
      await flushCascade();
      repos.messages.deleteMessage(at(2)); // still covered by the surviving [1-4]
      await flushCascade();

      expect(seen.map((event) => event.unhiddenSeqs)).toEqual([
        [5, 7, 8],
        [1, 3, 4],
      ]);
      expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("deleting an uncovered tail message emits nothing", async () => {
    const events = collectEvents();
    repos.messages.deleteMessage(at(12));
    await flushCascade();
    expect(repos.summaries.list(chatId)).toHaveLength(3);
    expect(events).toEqual([]);
  });

  it("deleting a whole chat removes its summaries (FK cascade)", async () => {
    const events = collectEvents();
    expect(repos.summaries.list(chatId)).toHaveLength(3);

    repos.chats.delete(chatId);
    await flushCascade();

    expect(repos.summaries.list(chatId)).toEqual([]);
    // Chat deletion is a chat-level operation, not a message afterDelete —
    // the summary-cascade event is not part of its contract.
    expect(events).toEqual([]);
  });
});

describe("applySummaryClear", () => {
  it("wipes every row and unhides each covered position that still has a message", () => {
    const events = collectEvents();

    const event = applySummaryClear({ repos }, chatId);
    if (!event) {
      throw new Error("expected a clear event");
    }

    // All three fixture rows (both levels) are gone in the same wipe…
    expect(event.chatId).toBe(chatId);
    expect(event.created).toEqual([]);
    expect(event.deleted.map((row) => row.id).sort()).toEqual(
      [fixture.lowLeft, fixture.lowRight, fixture.high].sort(),
    );
    // …and every position 1–8 returns to the live window. 9–12 were never
    // covered by a summary, so they were never hidden.
    expect(event.unhiddenSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(repos.summaries.list(chatId)).toEqual([]);

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(event);
  });

  it("returns null and emits nothing on a second clear (already empty)", () => {
    const first = applySummaryClear({ repos }, chatId);
    expect(first).not.toBeNull();

    const events = collectEvents();
    const second = applySummaryClear({ repos }, chatId);

    expect(second).toBeNull();
    expect(events).toEqual([]);
  });

  it("returns null for a chat that never had summaries", () => {
    const events = collectEvents();
    const otherChat = repos.chats.create({
      character_id: repos.characters.create({ name: "Empty" }).id,
    }).id;

    expect(applySummaryClear({ repos }, otherChat)).toBeNull();
    expect(events).toEqual([]);
  });
});
