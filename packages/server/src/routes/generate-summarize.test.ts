/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { generateRoutes } from "./generate";
import { messagesRoutes } from "./messages";
import { summariesRoutes } from "./summaries";

const sse = (): Response => sseText("Hi");

const sseText = (text: string): Response =>
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

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const parseEvents = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

const stagesOf = (events: Record<string, unknown>[]): string[] =>
  events.filter((e) => e.type === "status").map((e) => (e as { stage: string }).stage);

/**
 * Fresh app + summaries-strategy chat + a request-capturing fetch. The
 * optional `respond` factory decides each upstream response (call 1 is the
 * generation, later calls are summarization).
 */
async function setup(
  userMessages: number,
  respond?: (call: number) => Response,
): Promise<{
  app: Hono;
  repos: ReturnType<typeof createRepositories>;
  bodies: Record<string, unknown>[];
  chatId: string;
}> {
  const db: Database = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  repos.profiles.create(
    { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
    { is_default: true },
  );
  repos.settings.set("memory_strategy", "summaries");

  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetchImpl = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      return respond ? respond(calls) : sse();
    },
    { preconnect: () => {} },
  );
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  const app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", generateRoutes(deps));
  app.route("/", summariesRoutes(deps));

  const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
  const chatRes = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  expect(chatRes.status).toBe(201);
  const chatId = ((await chatRes.json()) as { chat: { id: string } }).chat.id;
  for (let i = 1; i <= userMessages; i++) {
    const res = await app.request(
      `/api/chats/${chatId}/messages`,
      jsonInit("POST", { role: "user", content: `Message ${i}` }),
    );
    expect(res.status).toBe(201);
  }
  return { app, repos, bodies, chatId };
}

describe("POST /api/chats/:id/generate (post-response summarization)", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // The route logs (never throws) summarization failures.
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("summarizes a full pending chunk after the reply, before done", async () => {
    // first_mes + 37 user messages + reply = 39: with the defaults
    // (chunk_size 8, summarize_after 30) exactly one full chunk is pending.
    const { app, repos, bodies, chatId } = await setup(37);
    repos.settings.set("tracker_config", { enabled: true });

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    // The summarizing status precedes done; done stays the last event.
    // The tracker (explicitly enabled, after_reply) tracks after the
    // summarize step through the default profile — the stub's plain "Hi"
    // reply fails to parse, so it emits a `tracker` {ok:false} event.
    expect(stagesOf(events)).toEqual(["preparing", "prompt", "summarizing", "tracking"]);
    expect(events.findIndex((e) => e.type === "done")).toBe(events.length - 1);

    // One generation call + one summarization call (templated system/user
    // pair, oldest chunk first) + one after_reply tracker call; a level-0 row
    // now covers messages 1–8. The two tail calls run CONCURRENTLY, so the
    // summarization body is located by its own system prompt rather than by
    // index — the completion order is not part of the contract.
    expect(bodies).toHaveLength(3);
    const summarizeBody = bodies.find((body) =>
      JSON.stringify(body.messages).includes("precise narrative-state tracker"),
    );
    const summarizeMessages =
      (summarizeBody?.messages as { role: string; content: string }[]) ?? [];
    expect(summarizeMessages).toHaveLength(2);
    expect(summarizeMessages[0]?.role).toBe("system");
    expect(summarizeMessages[0]?.content).toContain("precise narrative-state tracker");
    expect(summarizeMessages[1]?.role).toBe("user");
    // No persona on the chat → {{player_name}} falls back to "User"; no
    // level-0 summaries yet → empty prior context; the chunk's stripped
    // range text rides in {{story_txt}}.
    expect(summarizeMessages[1]?.content).toContain("<player_name>User</player_name>");
    expect(summarizeMessages[1]?.content).toContain("<prior_context></prior_context>");
    expect(summarizeMessages[1]?.content).toContain("<passage_in_question>");
    expect(summarizeMessages[1]?.content).toContain("Aria: Hello!");
    const rows = repos.summaries.list(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 0, seq_from: 1, seq_to: 8, summary: "Hi" });
  });

  it("caps the post-response catch-up at 8 chunks, catching up over turns", async () => {
    // chunk_size 1 / summarize_after 1: after the reply, 12 single-message
    // chunks wait — only the first 8 summarize per response.
    const { app, repos, bodies, chatId } = await setup(11);
    repos.settings.set("memory_config", { summaries: { chunk_size: 1, summarize_after: 1 } });

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    expect(events.find((e) => e.type === "done")).toBeDefined();

    // One generation call + exactly 8 summarization calls before done.
    expect(bodies).toHaveLength(9);
    const rows = repos.summaries.list(chatId);
    expect(rows).toHaveLength(8);
    expect(rows.at(-1)).toMatchObject({ level: 0, seq_from: 8, seq_to: 8 });

    // The next response catches up the rest (9–13).
    const res2 = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res2.status).toBe(200);
    await res2.text();
    const rowsAfter = repos.summaries.list(chatId);
    expect(rowsAfter).toHaveLength(13);
    expect(rowsAfter.at(-1)).toMatchObject({ seq_from: 13, seq_to: 13 });
  });

  it("makes no summarization call when only a partial chunk is pending", async () => {
    // first_mes + 29 user messages + reply = 31: only ONE candidate message
    // — a partial chunk no call is worth.
    const { app, repos, bodies, chatId } = await setup(29);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    // No summarizing stage either: without a full chunk the post-response
    // step has nothing to do, so the pill must not flash.
    expect(stagesOf(events)).toEqual(["preparing", "prompt"]);
    // Only the generation call happened; nothing was summarized.
    expect(bodies).toHaveLength(1);
    expect(repos.summaries.list(chatId)).toEqual([]);
    expect(events.find((e) => e.type === "done")).toMatchObject({ content: "Hi" });
  });

  it("does not announce summarizing when a fresh chat has nothing to summarize", async () => {
    // The reported regression: the stage was announced from the strategy
    // alone, so the very first reply flashed the "Summarizing…" pill while
    // every message still sat inside the summarize_after verbatim window.
    const { app, repos, bodies, chatId } = await setup(1);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    expect(stagesOf(events)).toEqual(["preparing", "prompt"]);
    expect(bodies).toHaveLength(1);
    expect(repos.summaries.list(chatId)).toEqual([]);
    expect(events.find((e) => e.type === "done")).toMatchObject({ content: "Hi" });
  });

  it("announces summarizing when only a promotion is pending", async () => {
    // 17 pre-existing level-0 snippets (over the default cap of 15) and no
    // uncovered chunk: the promotion pass still calls the summarizer, so
    // the stage must be announced.
    const { app, repos, bodies, chatId } = await setup(1);
    for (let i = 1; i <= 17; i++) {
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: i,
        seq_to: i,
        summary: `s${i}`,
        tokens: 1,
      });
    }

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    expect(stagesOf(events)).toEqual(["preparing", "prompt", "summarizing"]);
    // Generation + one promotion call (seeding the new layer makes none).
    expect(bodies).toHaveLength(2);
  });

  it("keeps the stream alive when summarization fails", async () => {
    const { app, repos, bodies, chatId } = await setup(37, (call) =>
      // The summarization call fails with a non-retryable 401.
      call === 1
        ? sse()
        : new Response(JSON.stringify({ error: { message: "no auth" } }), { status: 401 }),
    );

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    // done still fires after the failure: the reply is already persisted,
    // the failure only logs.
    expect(events.find((e) => e.type === "done")).toMatchObject({ content: "Hi" });
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    // The summarization call was attempted (and failed) before done.
    expect(bodies).toHaveLength(2);
    expect(repos.summaries.list(chatId)).toEqual([]);
    expect(repos.messages.listAll(chatId).at(-1)?.content).toBe("Hi");
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("routes the summarizer through the config's profile_id", async () => {
    const { app, repos, bodies, chatId } = await setup(37);
    // The setup's seeded default stays the ACTIVE (chat) profile; only the
    // summarizer follows its own config `profile_id`.
    const sum = repos.profiles.create({
      name: "Summarizer",
      model: "sum-model",
      base_url: "https://api.example",
      sampling: { temperature: 0.9, top_p: 0.8 },
    });
    repos.settings.set("memory_config", { summaries: { profile_id: sum.id } });

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    expect(parseEvents(await res.text()).find((e) => e.type === "done")).toBeDefined();

    // The generation ran on the default (active) profile; the summarizer
    // followed the config's profile_id with the 0.3 temperature guard. The
    // tracker is off here, so the tail holds this one call and the index is
    // deterministic (the generation is awaited before the tail starts).
    expect(bodies[0]).toMatchObject({ model: "test-model" });
    expect(bodies[1]).toMatchObject({ model: "sum-model", temperature: 0.3, top_p: 0.8 });
  });

  it("defaults the summarizer to the default profile, never the active one", async () => {
    const { app, repos, bodies, chatId } = await setup(37);
    // A second, explicitly ACTIVE profile: the setup's default stays the
    // DEFAULT one the summarizer falls back to.
    const active = repos.profiles.create({
      name: "Active",
      model: "active-model",
      base_url: "https://api.example",
      sampling: {},
    });
    repos.settings.set("active_connection_profile_id", active.id);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    expect(parseEvents(await res.text()).find((e) => e.type === "done")).toBeDefined();

    // The generation used the active profile; the summarizer — with no
    // profile_id configured — used the DEFAULT profile instead.
    expect(bodies[0]).toMatchObject({ model: "active-model" });
    expect(bodies[1]).toMatchObject({ model: "test-model" });
  });

  it("skips the summarizing stage for non-summaries strategies", async () => {
    const { app, repos, bodies, chatId } = await setup(10);
    repos.settings.delete("memory_strategy"); // default preset: trim
    repos.settings.set("tracker_config", { enabled: true });

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    // No summarizing stage without the strategy; the tracker's after_reply
    // `tracking` stage still runs (explicitly enabled) through the default
    // profile (one extra upstream call).
    expect(stagesOf(events)).toEqual(["preparing", "prompt", "tracking"]);
    expect(bodies).toHaveLength(2);
    expect(repos.summaries.list(chatId)).toEqual([]);
  });

  it("streams a plain reply when the default profile has no endpoint configured", async () => {
    // Regression: the summarizer endpoint used to be resolved EAGERLY during
    // "preparing", so an unconfigured DEFAULT profile (empty base_url — the
    // seeded shape) aborted generation even when the memory strategy never
    // summarizes. A configured ACTIVE profile must still get a reply.
    const { app, repos, bodies, chatId } = await setup(1);
    for (const profile of repos.profiles.list()) {
      repos.profiles.delete(profile.id);
    }
    repos.profiles.create({ name: "Default", model: "default-model" }, { is_default: true });
    const active = repos.profiles.create({
      name: "Active",
      model: "active-model",
      base_url: "https://api.example",
    });
    repos.settings.set("active_connection_profile_id", active.id);
    repos.settings.delete("memory_strategy"); // default preset: trim — no summarization

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    // No error event: the reply streamed to completion on the active profile.
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.find((e) => e.type === "delta")).toMatchObject({ content: "Hi" });
    expect(events.find((e) => e.type === "done")).toMatchObject({ content: "Hi" });
    expect(stagesOf(events)).toEqual(["preparing", "prompt"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "active-model" });
  });
});

/** The user message of a summarize request body (system is index 0). */
const userPromptOf = (body: Record<string, unknown> | undefined): string => {
  const messages = (body?.messages as { role: string; content: string }[] | undefined) ?? [];
  return messages.find((message) => message.role === "user")?.content ?? "";
};

describe("summaries prompting, markers, and layer promotion (manual route)", () => {
  it("applies strip patterns to the summarizer input only, ignoring invalid lines", async () => {
    const { app, repos, bodies, chatId } = await setup(2, (call) => sseText(`S${call}`));
    // One valid pattern per line plus an unparseable one that must be
    // skipped, never fatal.
    repos.settings.set("memory_config", {
      summaries: {
        chunk_size: 1,
        summarize_after: 1,
        strip_patterns: "Message \\d+\n([invalid\n!",
      },
    });

    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const created = (await res.json()) as { summary: string }[];
    expect(created).toHaveLength(2); // chunks [seq 1], [seq 2] (chunk_size 1)

    // Chunk 1: "Aria: Hello!" with "!" stripped; chunk 2: "Message 1"
    // fully stripped. The stored messages are untouched.
    expect(userPromptOf(bodies[0])).toContain(
      "<passage_in_question>Aria: Hello</passage_in_question>",
    );
    expect(userPromptOf(bodies[1])).toContain("<passage_in_question>user: </passage_in_question>");
    // The prior context grows with the rows created in this run.
    expect(userPromptOf(bodies[1])).toContain("<prior_context>S1</prior_context>");
    expect(repos.messages.listActive(chatId).map((message) => message.content)).toContain(
      "Message 1",
    );
  });

  it("stores a no-content marker row verbatim: covered, never injected, never re-summarized", async () => {
    const { app, repos, bodies, chatId } = await setup(37, (call) =>
      call === 1 ? sseText("[NO SIGNIFICANT CONTENT]") : sse(),
    );

    // One full chunk (seqs 1–8) whose model answer is the marker: the row
    // is still stored so the frontier advances past the chunk.
    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const created = (await res.json()) as { summary: string }[];
    expect(created).toHaveLength(1);
    expect(created[0]?.summary).toBe("[NO SIGNIFICANT CONTENT]");
    const rows = repos.summaries.list(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      level: 0,
      seq_from: 1,
      seq_to: 8,
      summary: "[NO SIGNIFICANT CONTENT]",
    });

    // Never re-summarized: nothing is uncovered anymore.
    const again = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(await again.json()).toEqual([]);

    // Never injected: the next generation prompt holds neither the marker
    // nor the covered messages — marker rows inject nothing, so no
    // summary block appears at all.
    bodies.length = 0;
    const gen = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(gen.status).toBe(200);
    await gen.text();
    expect(bodies).toHaveLength(1); // generation only — no summarize, no promotion
    const prompt = JSON.stringify(bodies[0]);
    expect(prompt).not.toContain("NO SIGNIFICANT CONTENT");
    expect(prompt).not.toContain("Hello!"); // covered → never verbatim again
  });

  it("never feeds a stored marker row back as chunk prior context", async () => {
    // Chunks 1 and 2 are answered with the marker; chunk 3's prompt must
    // not carry it into <prior_context> (the template's own instruction
    // text mentions the marker, so the segment is matched exactly).
    const { app, repos, bodies, chatId } = await setup(3, (call) =>
      call === 3 ? sseText("S") : sseText("[NO SIGNIFICANT CONTENT]"),
    );
    repos.settings.set("memory_config", { summaries: { chunk_size: 1, summarize_after: 1 } });

    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const created = (await res.json()) as { summary: string }[];
    // 4 messages (first_mes + 3), newest 1 verbatim → 3 chunks.
    expect(created).toHaveLength(3);
    // Chunk 2 saw an EMPTY prior context (chunk 1's stored marker was
    // skipped by the seeding filter)…
    expect(userPromptOf(bodies[1])).toContain("<prior_context></prior_context>");
    // …and chunk 3 saw neither marker — the seeding skip AND the in-run
    // append both leave it empty.
    expect(userPromptOf(bodies[2])).toContain("<prior_context></prior_context>");
  });

  it("never feeds a stored marker row back as promotion prior context", async () => {
    const { app, repos, bodies, chatId } = await setup(0, () => sseText("P"));
    repos.settings.set("memory_config", {
      summaries: { max_snippets_per_layer: 1, snippets_per_promotion: 2 },
    });
    // Level 1 holds a marker row next to a real one; level 0 holds three
    // uncovered snippets (over the cap of 1) → one LLM promotion whose
    // prior context must be the real snippet only.
    const rows: Array<[number, number, number, string]> = [
      [1, 1, 1, "[NO SIGNIFICANT CONTENT]"],
      [1, 2, 2, "r1"],
      [0, 3, 3, "s3"],
      [0, 4, 4, "s4"],
      [0, 5, 5, "s5"],
    ];
    for (const [level, seqFrom, seqTo, summary] of rows) {
      repos.summaries.create(chatId, {
        level,
        seq_from: seqFrom,
        seq_to: seqTo,
        summary,
        tokens: 1,
      });
    }

    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(userPromptOf(bodies[0])).toContain("<prior_context>r1</prior_context>");
    expect(userPromptOf(bodies[0])).toContain(
      "<passage_in_question>s3\n\ns4</passage_in_question>",
    );
  });

  it("promotes the oldest snippets once a layer exceeds its cap (defaults: 15 → 3)", async () => {
    const { app, repos, bodies, chatId } = await setup(0, () => sseText("P"));
    // 17 level-0 rows, one over the default cap of 15 — the rows predate
    // this call (the manual route only promotes them).
    for (let i = 1; i <= 17; i++) {
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: i,
        seq_to: i,
        summary: `s${i}`,
        tokens: 1,
      });
    }

    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const created = (await res.json()) as { summary: string }[];
    // 17 > 15: the brand-new level 1 is SEEDED from the oldest single
    // snippet (no LLM call), then still 16 > 15 → one LLM promotion of
    // the oldest 3 snippets.
    const level1 = repos.summaries.list(chatId).filter((row) => row.level === 1);
    expect(level1).toHaveLength(2);
    expect(level1[0]).toMatchObject({ seq_from: 1, seq_to: 1, summary: "s1" });
    expect(level1[1]).toMatchObject({ seq_from: 2, seq_to: 4, summary: "P" });
    expect(created).toHaveLength(2);
    expect(bodies).toHaveLength(1); // the seed made no gateway call
    // The promotion prompt: the seeded layer is the prior context, the
    // batch's texts the passage.
    expect(userPromptOf(bodies[0])).toContain("<prior_context>s1</prior_context>");
    expect(userPromptOf(bodies[0])).toContain(
      "<passage_in_question>s2\n\ns3\n\ns4</passage_in_question>",
    );
    // Level 0 keeps all its rows (promotions cover, never delete) and
    // 13 uncovered snippets stay within the cap.
    expect(repos.summaries.list(chatId).filter((row) => row.level === 0)).toHaveLength(17);
  });

  it("caps LLM promotions at 8 per call, picking the overflow up on the next", async () => {
    const { app, repos, bodies, chatId } = await setup(0, () => sseText("P"));
    // Depth 2 keeps the test on one promotion layer (a level-1 overflow
    // would cascade seeds into level 2 otherwise).
    repos.settings.set("memory_config", {
      summaries: {
        max_snippets_per_layer: 1,
        snippets_per_promotion: 2,
        max_layer_depth: 2,
      },
    });
    for (let i = 1; i <= 20; i++) {
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: i,
        seq_to: i,
        summary: `s${i}`,
        tokens: 1,
      });
    }

    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    // Seed (row 1) + exactly 8 LLM promotions before the cap stops the
    // pass: rows 18–20 remain uncovered, waiting for the next run.
    expect(bodies).toHaveLength(8);
    const level1 = repos.summaries.list(chatId).filter((row) => row.level === 1);
    expect(level1).toHaveLength(9);
    expect(level1.at(-1)).toMatchObject({ seq_from: 16, seq_to: 17 });

    bodies.length = 0;
    const res2 = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res2.status).toBe(200);
    // The next call promotes the remaining overflow (rows 18–19; row 20
    // alone stays under the cap of 1... uncovered 1 ≤ 1 stops).
    expect(bodies).toHaveLength(1);
    const level1After = repos.summaries.list(chatId).filter((row) => row.level === 1);
    expect(level1After).toHaveLength(10);
    expect(level1After.at(-1)).toMatchObject({ seq_from: 18, seq_to: 19 });
  });

  it("excludes marker rows from promotion batches", async () => {
    const { app, repos, bodies, chatId } = await setup(0, () => sseText("P"));
    repos.settings.set("memory_config", {
      summaries: { max_snippets_per_layer: 1, snippets_per_promotion: 2 },
    });
    // Four level-0 rows, the second a marker: it covers its range but
    // carries nothing worth promoting.
    const texts = ["s1", "[NO SIGNIFICANT CONTENT]", "s3", "s4"];
    for (const [i, summary] of texts.entries()) {
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: i + 1,
        seq_to: i + 1,
        summary,
        tokens: 1,
      });
    }

    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    // Uncovered non-marker snippets: s1, s3, s4 (3 > 1) → level 1 is
    // empty → seed from s1, then one LLM promotion of [s3, s4]. The
    // level-1 overflow (2 > 1) cascades one more seed into level 2 —
    // from the OLDEST level-1 snippet, again without an LLM call.
    expect(bodies).toHaveLength(1);
    // The exact context/passage matches prove the marker row is in
    // neither (the template's own instruction text mentions the marker,
    // so a broad not.toContain would be meaningless).
    expect(userPromptOf(bodies[0])).toContain("<prior_context>s1</prior_context>");
    expect(userPromptOf(bodies[0])).toContain(
      "<passage_in_question>s3\n\ns4</passage_in_question>",
    );
    const level1 = repos.summaries.list(chatId).filter((row) => row.level === 1);
    expect(level1).toHaveLength(2);
    expect(level1[0]).toMatchObject({ seq_from: 1, seq_to: 1, summary: "s1" }); // the seed
    expect(level1[1]).toMatchObject({ seq_from: 3, seq_to: 4, summary: "P" }); // the batch
    // The cascade seed at level 2 (the marker row never reached it).
    expect(repos.summaries.list(chatId).find((row) => row.level === 2)).toMatchObject({
      seq_from: 1,
      seq_to: 1,
      summary: "s1",
    });
  });

  it("never promotes beyond max_layer_depth", async () => {
    const { app, repos, bodies, chatId } = await setup(0, () => sseText("P"));
    repos.settings.set("memory_config", {
      summaries: {
        max_snippets_per_layer: 1,
        snippets_per_promotion: 2,
        max_layer_depth: 2,
      },
    });
    for (let i = 1; i <= 10; i++) {
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: i,
        seq_to: i,
        summary: `s${i}`,
        tokens: 1,
      });
    }

    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    // Level 0 → 1: seed + 4 LLM promotions (10 rows → 1 uncovered);
    // level 1 sits 5 rows over its cap but depth 2 forbids level 2.
    expect(bodies).toHaveLength(4);
    const rows = repos.summaries.list(chatId);
    expect(rows.filter((row) => row.level === 1)).toHaveLength(5);
    expect(rows.every((row) => row.level <= 1)).toBe(true);
  });
});

describe("POST /api/chats/:id/summarize failure mapping", () => {
  it("surfaces an unconfigured summarizer profile as a 400, not a 502", async () => {
    // `resolveEndpoint`'s "no endpoint configured" is a client configuration
    // error, so it must not be reported as a bogus upstream 502.
    const { app, repos, chatId } = await setup(2);
    const empty = repos.profiles.create({ name: "Unconfigured", model: "m" });
    repos.settings.set("memory_config", { summaries: { profile_id: empty.id } });

    const res = await app.request(`/api/chats/${chatId}/summarize`, jsonInit("POST", {}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No endpoint configured for this profile" });
  });
});
