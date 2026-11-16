/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  createRepositories,
  engine,
  type Message,
  migrations,
  openDatabase,
  registerSummaryHooks,
  runMigrations,
  type Summary,
  type SummaryLifecycleEvent,
} from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { generateRoutes } from "./generate";
import { type SummariesConfig, summariesConfigFor, uncoveredChunks } from "./generate-summaries";
import { messagesRoutes } from "./messages";
import { summariesRoutes } from "./summaries";

const sse = (text: string): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
          ),
        );
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
  );

/** Every upstream request body the gateway sent (generation + summaries). */
const bodies: Record<string, unknown>[] = [];

const mockFetch: typeof fetch = Object.assign(
  async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body !== undefined) {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    return sse("Summary of events.");
  },
  { preconnect: () => {} },
);

const db = openDatabase(":memory:");
runMigrations(db, migrations);
const repos = createRepositories(db);
repos.profiles.create(
  { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
  { is_default: true },
);
const gateway = createGateway({ repos, fetchImpl: mockFetch });
const deps: RouteDeps = { repos, gateway };
const app = new Hono();
app.route("/", chatsRoutes(deps));
app.route("/", messagesRoutes(deps));
app.route("/", generateRoutes(deps));
app.route("/", summariesRoutes(deps));

interface SummaryRow {
  seq_from: number;
  seq_to: number;
  summary: string;
}

async function seedChat(userMessages = 8): Promise<string> {
  const character = repos.characters.create({ name: "Aria", first_mes: "Hello!" });
  const res = await app.request("/api/chats", {
    method: "POST",
    body: JSON.stringify({ character_id: character.id }),
  });
  expect(res.status).toBe(201);
  const chatId = ((await res.json()) as { chat: { id: string } }).chat.id;
  for (let i = 1; i <= userMessages; i++) {
    const role = i % 2 === 1 ? "user" : "assistant";
    const msg = await app.request(`/api/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ role, content: `Message ${i}` }),
    });
    expect(msg.status).toBe(201);
  }
  return chatId;
}

describe("chat summaries", () => {
  it("summarizes uncovered messages (partial chunk included), then finds nothing new to cover", async () => {
    const chatId = await seedChat(32);
    const res = await app.request(`/api/chats/${chatId}/summarize`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const created = (await res.json()) as SummaryRow[];
    expect(created.length).toBeGreaterThanOrEqual(1);
    const first = created[0];
    expect(first?.seq_from).toBe(1); // covers the oldest messages
    // 33 messages (first_mes + 32), defaults chunk_size 8 / summarize_after 30:
    // only 3 candidates — a partial chunk the manual route still covers.
    expect(created.length).toBe(1);
    expect(first?.seq_to).toBe(3); // newest 30 stay uncovered
    expect(first?.summary).toBe("Summary of events.");
    expect(repos.summaries.list(chatId).length).toBe(created.length);

    const again = await app.request(`/api/chats/${chatId}/summarize`, {
      method: "POST",
      body: "{}",
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual([]);
    expect(repos.summaries.list(chatId).length).toBe(created.length);

    const listRes = await app.request(`/api/chats/${chatId}/summaries`);
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as SummaryRow[]).length).toBe(created.length);
  });

  it("honors the global memory settings like generation would", async () => {
    const chatId = await seedChat();
    // Global strategy + config (Settings page): summaries with
    // summarize_after 4 instead of the schema default 30 — POST /summarize
    // must resolve the config the same way prepareGeneration does.
    repos.settings.set("memory_strategy", "summaries");
    repos.settings.set("memory_config", { summaries: { summarize_after: 4 } });
    const res = await app.request(`/api/chats/${chatId}/summarize`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const created = (await res.json()) as SummaryRow[];
    expect(created.length).toBe(1);
    expect(created[0]?.seq_from).toBe(1);
    // 9 messages (first_mes + 8): the newest 4 stay uncovered, so the
    // chunk stops at message 5.
    expect(created[0]?.seq_to).toBe(5);
    // Restore the shared repos for the other tests of this file.
    repos.settings.delete("memory_strategy");
    repos.settings.delete("memory_config");
  });

  it("keeps the oldest message via the summary block after a manual summarize", async () => {
    // Exactly 31 active messages (first_mes + 30): with the defaults
    // (chunk_size 8, summarize_after 30) the manual route covers the lone
    // candidate as a summary row 1..1 — the frontier then equals the
    // history's first seq.
    const chatId = await seedChat(30);
    const res = await app.request(`/api/chats/${chatId}/summarize`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const created = (await res.json()) as SummaryRow[];
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ seq_from: 1, seq_to: 1 });

    // The next generation must keep message 1 via the summary block, not
    // silently drop it from the prompt.
    repos.settings.set("memory_strategy", "summaries");
    bodies.length = 0;
    const genRes = await app.request(`/api/chats/${chatId}/generate`, {
      method: "POST",
      body: "{}",
    });
    expect(genRes.status).toBe(200);
    await genRes.text(); // drain the SSE stream so the route fully runs
    const prompt = JSON.stringify(bodies[0]);
    expect(prompt).toContain("[Summary of past events: Summary of events.]");
    expect(prompt).toContain("Summary of events.");
    expect(prompt).not.toContain("Hello!"); // covered → never verbatim again
    // Restore the shared repos for the other tests of this file.
    repos.settings.delete("memory_strategy");
  });

  it("summarizes at most 8 chunks per call, catching up on the next", async () => {
    // 12 active messages with chunk_size 1 / summarize_after 1 → 11
    // uncovered single-message chunks — the per-call cap (8) takes the
    // oldest 8, the rest wait for the next call.
    const chatId = await seedChat(11);
    repos.settings.set("memory_strategy", "summaries");
    repos.settings.set("memory_config", { summaries: { chunk_size: 1, summarize_after: 1 } });

    const first = await app.request(`/api/chats/${chatId}/summarize`, {
      method: "POST",
      body: "{}",
    });
    expect(first.status).toBe(200);
    const createdFirst = (await first.json()) as SummaryRow[];
    expect(createdFirst).toHaveLength(8);
    expect(createdFirst[0]).toMatchObject({ seq_from: 1, seq_to: 1 });
    expect(createdFirst.at(-1)).toMatchObject({ seq_from: 8, seq_to: 8 });

    // The second call catches up the remaining chunks (9–11)…
    const second = await app.request(`/api/chats/${chatId}/summarize`, {
      method: "POST",
      body: "{}",
    });
    expect(second.status).toBe(200);
    const createdSecond = (await second.json()) as SummaryRow[];
    expect(createdSecond).toHaveLength(3);
    expect(createdSecond[0]).toMatchObject({ seq_from: 9, seq_to: 9 });
    expect(createdSecond.at(-1)).toMatchObject({ seq_from: 11, seq_to: 11 });

    // …and a third finds nothing left to cover.
    const third = await app.request(`/api/chats/${chatId}/summarize`, {
      method: "POST",
      body: "{}",
    });
    expect(third.status).toBe(200);
    expect(await third.json()).toEqual([]);

    // Restore the shared repos for the other tests of this file.
    repos.settings.delete("memory_strategy");
    repos.settings.delete("memory_config");
  });

  it("repairs a mid-gap hole with a fresh level-0 row, without double-covering", async () => {
    // Post-cascade state of the reviewer's repro: [1-4] and [9-12]
    // summarized, message 6 deleted together with its covering [5-8] row
    // (this file's app does not wire the cascade, so the state is built
    // by hand — deleting the row exactly as the cascade would).
    const chatId = await seedChat(11); // first_mes + 11 → seqs 1..12
    const gone = repos.messages.listAll(chatId).find((message) => message.seq === 6);
    if (!gone) {
      throw new Error("fixture message missing");
    }
    repos.messages.deleteMessage(gone.id);
    repos.summaries.deleteIntersecting(chatId, 6);
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 4,
      summary: "covers 1-4",
      tokens: 1,
    });
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 9,
      seq_to: 12,
      summary: "covers 9-12",
      tokens: 1,
    });
    repos.settings.set("memory_strategy", "summaries");
    // The 11 surviving messages: newest 3 (10–12) stay verbatim, 1–4 and
    // 9 are covered → exactly 5, 7, 8 re-eligible as one chunk.
    repos.settings.set("memory_config", { summaries: { chunk_size: 4, summarize_after: 3 } });

    const res = await app.request(`/api/chats/${chatId}/summarize`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const created = (await res.json()) as SummaryRow[];
    expect(created).toHaveLength(1);
    // The repaired level-0 row spans the hole — the first survivor to the
    // last (the deleted position simply stays absent from the chunk).
    expect(created[0]).toMatchObject({ seq_from: 5, seq_to: 8 });

    // The survivors [1-4] and [9-12] were not re-summarized (no
    // double-cover): exactly the three ranges now exist.
    expect(
      repos.summaries
        .list(chatId)
        .map((row) => `${row.seq_from}-${row.seq_to}`)
        .sort(),
    ).toEqual(["1-4", "5-8", "9-12"]);

    // Restore the shared repos for the other tests of this file.
    repos.settings.delete("memory_strategy");
    repos.settings.delete("memory_config");
  });

  it("returns 404 for an unknown chat", async () => {
    expect((await app.request("/api/chats/nope/summaries")).status).toBe(404);
    expect(
      (await app.request("/api/chats/nope/summarize", { method: "POST", body: "{}" })).status,
    ).toBe(404);
  });
});

describe("summariesConfigFor", () => {
  // Fresh repos per case: preset resolution reads global settings
  // (`default_preset_id`), which must not leak into the shared repos above.
  const makeRepos = (): ReturnType<typeof createRepositories> => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    return createRepositories(db);
  };

  it("resolves the default_preset_id preset like generation would", () => {
    const repos = makeRepos();
    const first = repos.presets.create({
      name: "A first by name",
      settings: { memory: { strategy: "summaries", config: { chunk_size: 2 } } },
    });
    const starred = repos.presets.create({
      name: "B starred default",
      settings: { memory: { strategy: "summaries", config: { chunk_size: 5 } } },
    });
    repos.settings.set("default_preset_id", starred.id);

    // The starred default wins over the first-by-name preset, and an
    // explicit id still beats the setting — the same chain loadPreset
    // applies at generation time (chat.test.ts).
    expect(summariesConfigFor(repos).chunk_size).toBe(5);
    expect(summariesConfigFor(repos, first.id).chunk_size).toBe(2);
  });

  it("falls back to the first stored preset when the default id is stale", () => {
    const repos = makeRepos();
    repos.presets.create({
      name: "A first by name",
      settings: { memory: { strategy: "summaries", config: { chunk_size: 3 } } },
    });
    repos.presets.create({
      name: "B never resolved",
      settings: { memory: { strategy: "summaries", config: { chunk_size: 9 } } },
    });
    repos.settings.set("default_preset_id", "deleted-preset");

    // A default_preset_id naming no live preset is skipped, not fatal.
    expect(summariesConfigFor(repos).chunk_size).toBe(3);
  });
});

describe("uncoveredChunks", () => {
  const config = (overrides: Record<string, unknown> = {}): SummariesConfig =>
    engine.summariesConfigSchema.parse(overrides);

  const message = (seq: number): Message => ({
    id: `m${seq}`,
    chat_id: "chat",
    role: "user",
    content: "x",
    name: null,
    metadata: null,
    seq,
    variant_of: null,
    active: true,
    created_at: "2026-01-01T00:00:00Z",
  });

  const summary = (seqFrom: number, seqTo: number): Summary => ({
    id: `s${seqFrom}`,
    chat_id: "chat",
    level: 0,
    seq_from: seqFrom,
    seq_to: seqTo,
    summary: "s",
    tokens: 1,
    created_at: "2026-01-01T00:00:00Z",
  });

  it("chunks uncovered messages oldest-first, excluding the newest summarize_after", () => {
    const history = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(message);
    const chunks = uncoveredChunks(history, [], config({ chunk_size: 3, summarize_after: 2 }));
    // Newest 2 excluded → candidates 1–8 → chunks [1-3] [4-6] [7-8].
    expect(chunks.map((chunk) => chunk.map((m) => m.seq))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8],
    ]);
  });

  it("starts past the covered positions of existing summaries", () => {
    const history = [1, 2, 3, 4, 5, 6].map(message);
    const chunks = uncoveredChunks(history, [summary(1, 2)], config({ chunk_size: 6 }), {
      fullOnly: true,
    });
    // Defaults: summarize_after 30 → no candidates at all.
    expect(chunks).toEqual([]);
    const tighter = uncoveredChunks(
      history,
      [summary(1, 2)],
      config({ chunk_size: 2, summarize_after: 2 }),
    );
    expect(tighter.map((chunk) => chunk.map((m) => m.seq))).toEqual([[3, 4]]);
  });

  it("re-opens the mid-gap survivors of a deleted covering row", () => {
    // Post-cascade state of the reviewer's repro: [1-4] and [9-12]
    // survive a mid-range deletion that took [5-8] with message 6, so
    // 5, 7, 8 are uncovered again — under the old frontier rule they sat
    // below the [9-12] frontier and were never re-summarizable.
    const history = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12].map(message);
    const chunks = uncoveredChunks(
      history,
      [summary(1, 4), summary(9, 12)],
      config({ chunk_size: 4, summarize_after: 3 }),
    );
    expect(chunks.map((chunk) => chunk.map((m) => m.seq))).toEqual([[5, 7, 8]]);
  });

  it("drops the trailing partial chunk in fullOnly mode", () => {
    const history = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(message);
    const rows: Summary[] = [];
    const cfg = config({ chunk_size: 4, summarize_after: 3 });
    // Candidates 1–6: chunks [1-4] [5-6] — the partial one drops.
    expect(
      uncoveredChunks(history, rows, cfg, { fullOnly: true }).map((c) => c.map((m) => m.seq)),
    ).toEqual([[1, 2, 3, 4]]);
    // Manual mode keeps it.
    expect(uncoveredChunks(history, rows, cfg).map((c) => c.map((m) => m.seq))).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ]);
  });

  it("drops everything when only a partial chunk exists in fullOnly mode", () => {
    const history = [1, 2, 3, 4, 5, 6, 7].map(message);
    expect(
      uncoveredChunks(history, [], config({ chunk_size: 6, summarize_after: 6 }), {
        fullOnly: true,
      }),
    ).toEqual([]);
  });
});

describe("summaries import/export", () => {
  const summaryRow = (level: number, seqFrom: number, seqTo: number, summary: string): Summary => ({
    id: `s-${level}-${seqFrom}`,
    chat_id: "chat",
    level,
    seq_from: seqFrom,
    seq_to: seqTo,
    summary,
    tokens: 1,
    created_at: "2026-01-01T00:00:00Z",
  });

  it("exports a versioned snapshot in the repository list order", async () => {
    const chatId = await seedChat(2);
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 2,
      summary: "low",
      tokens: 1,
    });
    repos.summaries.create(chatId, {
      level: 1,
      seq_from: 1,
      seq_to: 2,
      summary: "high",
      tokens: 1,
    });

    const res = await app.request(`/api/chats/${chatId}/summaries/export`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      chat_id: string;
      exported_at: string;
      summaries: Summary[];
    };
    expect(body.version).toBe(1);
    expect(body.chat_id).toBe(chatId);
    expect(new Date(body.exported_at).toISOString()).toBe(body.exported_at); // ISO-shaped
    // The repository list order (level, then range) round-trips.
    expect(body.summaries.map((row) => row.summary)).toEqual(["low", "high"]);
    expect(body.summaries[0]).toMatchObject({ level: 0, seq_from: 1, seq_to: 2 });
  });

  it("404s the export of an unknown chat", async () => {
    expect((await app.request("/api/chats/nope/summaries/export")).status).toBe(404);
  });

  it("replaces every existing summary on import, regenerating ids, and emits the lifecycle event", async () => {
    const chatId = await seedChat(2);
    const old1 = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 1,
      summary: "old1",
      tokens: 1,
    });
    const old2 = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 2,
      seq_to: 2,
      summary: "old2",
      tokens: 1,
    });

    const events: SummaryLifecycleEvent[] = [];
    // The listener is scoped to this chat: other tests of this file run
    // summarize routes that emit on the same process-wide default bus.
    const off = registerSummaryHooks((event) => {
      if (event.chatId === chatId) {
        events.push(event);
      }
    });
    try {
      const res = await app.request(`/api/chats/${chatId}/summaries/import`, {
        method: "POST",
        body: JSON.stringify({
          summaries: [
            summaryRow(1, 1, 2, "new high"),
            { level: 0, seq_from: 1, seq_to: 1, summary: "new low" }, // tokens defaults to null
          ],
        }),
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as Summary[];
      expect(created).toHaveLength(2);

      // Exactly the imported rows remain, with regenerated ids.
      const rows = repos.summaries.list(chatId);
      expect(rows.map((row) => row.summary).sort()).toEqual(["new high", "new low"]);
      const ids = new Set(rows.map((row) => row.id));
      expect(ids.has(old1.id)).toBe(false);
      expect(ids.has(old2.id)).toBe(false);
      for (const row of created) {
        expect(ids.has(row.id)).toBe(true);
      }
      expect(rows.find((row) => row.summary === "new low")).toMatchObject({ tokens: null });

      // One lifecycle event: the imported rows created, the old ones deleted.
      expect(events).toHaveLength(1);
      expect(events[0]?.created.map((row) => row.summary).sort()).toEqual(["new high", "new low"]);
      expect(events[0]?.deleted.map((row) => row.id).sort()).toEqual([old1.id, old2.id].sort());
      expect(events[0]?.unhiddenSeqs).toEqual([]);
    } finally {
      off();
    }
  });

  it("clears the chat's summaries on an empty import, still emitting the deletions", async () => {
    const chatId = await seedChat(1);
    const existing = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 1,
      summary: "old",
      tokens: 1,
    });

    const events: SummaryLifecycleEvent[] = [];
    const off = registerSummaryHooks((event) => {
      if (event.chatId === chatId) {
        events.push(event);
      }
    });
    try {
      const res = await app.request(`/api/chats/${chatId}/summaries/import`, {
        method: "POST",
        body: JSON.stringify({ summaries: [] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      expect(repos.summaries.list(chatId)).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]?.created).toEqual([]);
      expect(events[0]?.deleted.map((row) => row.id)).toEqual([existing.id]);
    } finally {
      off();
    }
  });

  it("validates import rows and rejects unknown chats", async () => {
    const chatId = await seedChat(1);
    const post = async (body: unknown): Promise<number> =>
      (
        await app.request(`/api/chats/${chatId}/summaries/import`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).status;

    expect(await post({ summaries: [summaryRow(-1, 1, 1, "x")] })).toBe(400); // level < 0
    expect(await post({ summaries: [summaryRow(0, 5, 2, "x")] })).toBe(400); // seq_from > seq_to
    expect(await post({ summaries: [{ level: 0, seq_from: 1, seq_to: 1 }] })).toBe(400); // no summary
    expect(
      await post({ summaries: [{ level: 0, seq_from: 1, seq_to: 1, summary: "x", tokens: "n" }] }),
    ).toBe(400); // tokens not a nullable number
    expect(await post({})).toBe(400); // missing summaries
    expect(
      (
        await app.request(`/api/chats/${chatId}/summaries/import`, {
          method: "POST",
          body: "not json",
        })
      ).status,
    ).toBe(400);
    // The 5000-row sanity cap.
    expect(
      await post({
        summaries: Array.from({ length: 5001 }, (_, i) => summaryRow(0, i + 1, i + 1, "x")),
      }),
    ).toBe(400);
    // Nothing was stored by the rejected imports.
    expect(repos.summaries.list(chatId)).toEqual([]);

    expect(
      (
        await app.request("/api/chats/nope/summaries/import", {
          method: "POST",
          body: JSON.stringify({ summaries: [] }),
        })
      ).status,
    ).toBe(404);
  });
});

/**
 * Clear-all and single-row edit. This file's shared `app` does NOT wire the
 * message-deletion cascade, so clear-all's unhide set comes directly from
 * `applySummaryClear` (which derives it from the deleted rows' ranges) —
 * not from a cascade pass. The listener is chat-scoped because the shared
 * process-wide bus also carries other tests' summarize/import events.
 */
describe("summaries clear/edit", () => {
  it("clears every summary, emits one lifecycle event, and 404s an unknown chat", async () => {
    const chatId = await seedChat(8); // first_mes + 8 → seqs 1..9
    const low = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 3,
      summary: "low",
      tokens: 1,
    });
    const high = repos.summaries.create(chatId, {
      level: 1,
      seq_from: 5,
      seq_to: 8,
      summary: "high",
      tokens: 1,
    });

    const events: SummaryLifecycleEvent[] = [];
    const off = registerSummaryHooks((event) => {
      if (event.chatId === chatId) {
        events.push(event);
      }
    });
    try {
      const res = await app.request(`/api/chats/${chatId}/summaries`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        deleted: Summary[];
        unhidden_seqs: number[];
      };
      expect(body.ok).toBe(true);
      expect(body.deleted.map((row) => row.id).sort()).toEqual([low.id, high.id].sort());
      // Covered positions only: 1–3 and 5–8 return; 4 and 9 were never
      // hidden by a summary.
      expect(body.unhidden_seqs).toEqual([1, 2, 3, 5, 6, 7, 8]);
      expect(repos.summaries.list(chatId)).toEqual([]);

      // One lifecycle event, carrying the same deletions and unhide set.
      expect(events).toHaveLength(1);
      expect(events[0]?.created).toEqual([]);
      expect(events[0]?.deleted.map((row) => row.id).sort()).toEqual([low.id, high.id].sort());
      expect(events[0]?.unhiddenSeqs).toEqual([1, 2, 3, 5, 6, 7, 8]);

      // A second clear deletes nothing: still 200, empty payload, no event.
      const again = await app.request(`/api/chats/${chatId}/summaries`, { method: "DELETE" });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, deleted: [], unhidden_seqs: [] });
      expect(events).toHaveLength(1);
    } finally {
      off();
    }

    expect((await app.request("/api/chats/nope/summaries", { method: "DELETE" })).status).toBe(404);
  });

  it("edits a summary's text and tokens without touching its level or range", async () => {
    const chatId = await seedChat(4);
    const row = repos.summaries.create(chatId, {
      level: 1,
      seq_from: 1,
      seq_to: 4,
      summary: "original",
      tokens: 1,
    });

    const res = await app.request(`/api/chats/${chatId}/summaries/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ summary: "rewritten" }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Summary;
    expect(updated.summary).toBe("rewritten");
    expect(updated.tokens).toBe(engine.countTokens("rewritten"));
    // Text-only: coverage and level are immutable through this route.
    expect(updated).toMatchObject({ level: 1, seq_from: 1, seq_to: 4 });

    const stored = repos.summaries.get(row.id);
    expect(stored).toMatchObject({
      summary: "rewritten",
      tokens: engine.countTokens("rewritten"),
      level: 1,
      seq_from: 1,
      seq_to: 4,
    });
  });

  it("404s an unknown summary id and a summary id from a different chat", async () => {
    const chatId = await seedChat(2);
    const otherChatId = await seedChat(2);
    const foreign = repos.summaries.create(otherChatId, {
      level: 0,
      seq_from: 1,
      seq_to: 1,
      summary: "foreign",
      tokens: 1,
    });

    const patch = async (summaryId: string, body: unknown): Promise<Response> =>
      await app.request(`/api/chats/${chatId}/summaries/${summaryId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

    expect((await patch("no-such-summary", { summary: "x" })).status).toBe(404);
    // A row that exists, but belongs to another chat — never a cross-chat edit.
    expect((await patch(foreign.id, { summary: "x" })).status).toBe(404);
    // Unknown chat id.
    expect(
      (
        await app.request(`/api/chats/nope/summaries/${foreign.id}`, {
          method: "PATCH",
          body: JSON.stringify({ summary: "x" }),
        })
      ).status,
    ).toBe(404);
  });

  it("rejects invalid edit bodies with 400", async () => {
    const chatId = await seedChat(2);
    const row = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 1,
      summary: "keep",
      tokens: 1,
    });

    const patch = async (body: string): Promise<Response> =>
      await app.request(`/api/chats/${chatId}/summaries/${row.id}`, { method: "PATCH", body });

    expect((await patch(JSON.stringify({ summary: 5 }))).status).toBe(400);
    expect((await patch(JSON.stringify({}))).status).toBe(400);
    expect((await patch("not json")).status).toBe(400);
    // Nothing changed on any rejected request.
    expect(repos.summaries.get(row.id)?.summary).toBe("keep");
  });
});
