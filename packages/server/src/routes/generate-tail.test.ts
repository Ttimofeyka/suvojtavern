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

/**
 * The post-response TAIL of a generation: level-0 summarization and the
 * after_reply tracker snapshot.
 *
 * These two are independent (different tables, different prompts, different
 * connection profiles), so the route runs them CONCURRENTLY. The tests below
 * pin that concurrency rather than just the final state: a regression to
 * sequential awaits would still produce the right rows and the right final
 * event, so only an overlap assertion can catch it.
 */

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

const TRACKER_JSON = { location: "The tavern", charactersPresent: ["Aria"] };

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

/** True when the body belongs to a summarization call (its templated prompts). */
const isSummarizeBody = (body: Record<string, unknown>): boolean =>
  JSON.stringify(body.messages).includes("Narrative Compression Specialist");

/** True when the body belongs to a tracker call (its schema prompt). */
const isTrackerBody = (body: Record<string, unknown>): boolean =>
  JSON.stringify(body.messages).includes("scene-state") ||
  JSON.stringify(body.messages).includes("JSON");

/**
 * Fresh app over a chat long enough for one full summary chunk, with a
 * deferred summarization response so the test can hold that call open.
 */
async function setup(): Promise<{
  app: Hono;
  repos: ReturnType<typeof createRepositories>;
  bodies: Record<string, unknown>[];
  chatId: string;
  /** Resolves the held summarization call; the request proceeds. */
  releaseSummarize: () => void;
  /** Resolves once the summarization request has actually started. */
  summarizeStarted: Promise<void>;
}> {
  const db: Database = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  repos.profiles.create(
    { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
    { is_default: true },
  );
  repos.settings.set("memory_strategy", "summaries");
  repos.settings.set("tracker_config", { enabled: true, auto_mode: "after_reply" });

  const bodies: Record<string, unknown>[] = [];
  let releaseSummarize = (): void => {};
  let markSummarizeStarted = (): void => {};
  const summarizeStarted = new Promise<void>((resolve) => {
    markSummarizeStarted = resolve;
  });
  // The summarization call parks on this promise until the test releases it.
  const held = new Promise<void>((resolve) => {
    releaseSummarize = resolve;
  });

  const fetchImpl = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (isSummarizeBody(body)) {
        markSummarizeStarted();
        await held;
        return sse("A condensed summary line.");
      }
      if (isTrackerBody(body)) {
        return sse(`\`\`\`json\n${JSON.stringify(TRACKER_JSON, null, 2)}\n\`\`\``);
      }
      // The main generation call.
      return sse("Hi there");
    },
    { preconnect: () => {} },
  );

  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  const app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", generateRoutes(deps));

  const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
  const chatRes = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  const chatId = ((await chatRes.json()) as { chat: { id: string } }).chat.id;
  // first_mes + 37 user messages + reply = 39 rows: with summarize_after 30
  // and chunk_size 8, exactly one full chunk (seqs 1–8) is pending.
  for (let i = 1; i <= 37; i++) {
    await app.request(
      `/api/chats/${chatId}/messages`,
      jsonInit("POST", { role: "user", content: `Message ${i}` }),
    );
  }
  return { app, repos, bodies, chatId, releaseSummarize, summarizeStarted };
}

describe("post-response tail concurrency", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("runs the tracker while summarization is still in flight", async () => {
    const { app, bodies, chatId, releaseSummarize, summarizeStarted } = await setup();

    // The SSE handler runs while the body is consumed, so the read must be in
    // flight before the held summarization call can start.
    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    const text = res.text();
    // Wait until the summarizer request is genuinely in flight.
    await summarizeStarted;

    // The tracker call must have STARTED and finished while summarization is
    // parked. Sequentially it could not exist yet.
    const waitFor = Date.now() + 2_000;
    while (!bodies.some(isTrackerBody) && Date.now() < waitFor) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(bodies.some(isTrackerBody)).toBe(true);

    releaseSummarize();
    const events = parseEvents(await text);
    // Both stages were announced up front, in a fixed order, and done is last.
    expect(stagesOf(events)).toEqual(["preparing", "prompt", "summarizing", "tracking"]);
    expect(events.findIndex((e) => e.type === "done")).toBe(events.length - 1);
  });

  it("announces both stages before either tail task starts", async () => {
    const { app, bodies, chatId, releaseSummarize, summarizeStarted } = await setup();

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    const text = res.text();
    await summarizeStarted;
    releaseSummarize();
    const events = parseEvents(await text);

    // The status events are written before the tasks, so the order is the
    // declaration order regardless of which upstream call wins the race.
    const statusEvents = events.filter((e) => e.type === "status");
    expect(statusEvents.map((e) => (e as { stage: string }).stage)).toEqual([
      "preparing",
      "prompt",
      "summarizing",
      "tracking",
    ]);
    // The tracker's own body arrived (it is not swallowed by the race).
    expect(bodies.some(isTrackerBody)).toBe(true);
  });

  it("still emits done when summarization fails while the tracker succeeds", async () => {
    const db: Database = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    repos.profiles.create(
      { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
      { is_default: true },
    );
    repos.settings.set("memory_strategy", "summaries");
    repos.settings.set("tracker_config", { enabled: true, auto_mode: "after_reply" });

    const fetchImpl = Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (isSummarizeBody(body)) {
          return new Response(JSON.stringify({ error: { message: "no auth" } }), { status: 401 });
        }
        if (isTrackerBody(body)) {
          return sse(`\`\`\`json\n${JSON.stringify(TRACKER_JSON, null, 2)}\n\`\`\``);
        }
        return sse("Hi there");
      },
      { preconnect: () => {} },
    );
    const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
    const app = new Hono();
    app.route("/", chatsRoutes(deps));
    app.route("/", messagesRoutes(deps));
    app.route("/", generateRoutes(deps));

    const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    const chatId = ((await chatRes.json()) as { chat: { id: string } }).chat.id;
    for (let i = 1; i <= 37; i++) {
      await app.request(
        `/api/chats/${chatId}/messages`,
        jsonInit("POST", { role: "user", content: `Message ${i}` }),
      );
    }

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    // allSettled: one task's failure neither cancels the sibling nor the
    // stream. The tracker event still lands and done still closes the run.
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const trackerEvent = events.find((e) => e.type === "tracker") as
      | { ok: boolean; snapshot: { data: unknown } }
      | undefined;
    expect(trackerEvent?.ok).toBe(true);
    expect(trackerEvent?.snapshot.data).toEqual(TRACKER_JSON);
    expect(events.findIndex((e) => e.type === "done")).toBe(events.length - 1);
    expect(repos.summaries.list(chatId)).toEqual([]);
  });
});
