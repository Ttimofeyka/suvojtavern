/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations, tracker } from "@suvoj/core";
import { createApp } from "../app";

/**
 * Tracker REST routes (the Suvoj Tracker surface). The fake gateway answers
 * every chat-completions call with a fenced JSON block (the shape the
 * built-in mechanism asks for); per-test `respond` overrides decide
 * failures.
 */

const TRACKER_JSON = {
  time: "10:00:00; 01/01/2026 (Thursday)",
  location: "The tavern, back room",
};

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

/** The happy-path upstream reply: one fenced tracker JSON block. */
const trackerReply = (): Response =>
  sse(`\`\`\`json\n${JSON.stringify(TRACKER_JSON, null, 2)}\n\`\`\``);

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** A two-top-level-field schema used by the split-generation tests. */
const SPLIT_SCHEMA = {
  type: "object",
  properties: { time: { type: "string" }, place: { type: "string" } },
  required: ["time", "place"],
};

/** A tracker config whose active `split` preset assigns `place` to request 2. */
const splitTrackerConfig = (preset: Record<string, unknown> = {}): Record<string, unknown> => ({
  active_schema_key: "split",
  schema_presets: {
    split: { name: "Split", schema: SPLIT_SCHEMA, html: "", css: "", ...preset },
  },
});

/** The part number a captured request BODY carries, from the PART header. */
function partOfBody(body: Record<string, unknown>): number {
  const messages = (body.messages as Array<{ content?: string }> | undefined) ?? [];
  const text = messages.map((message) => message.content ?? "").join("\n");
  if (text.includes("**GENERATION PART 2 OF 2:**")) {
    return 2;
  }
  if (text.includes("**GENERATION PART 1 OF 2:**")) {
    return 1;
  }
  return 0;
}

/** The part number a live fetch request carries (reads its init body). */
function partOf(init?: RequestInit): number {
  return partOfBody(JSON.parse(String(init?.body)) as Record<string, unknown>);
}

/** The final (JSON-prompt) message content of a captured request body. */
function lastMessage(body: Record<string, unknown>): string {
  const messages = (body.messages as Array<{ content: string }> | undefined) ?? [];
  return messages.at(-1)?.content ?? "";
}

interface SetupOpts {
  /** Per-call upstream responses (call 1 is the first request). `init` carries
   *  the captured request body, so a test can answer order-independently. */
  respond?: (call: number, init?: RequestInit) => Response;
  /** Stored under the `tracker_config` settings key before the app builds. */
  trackerConfig?: Record<string, unknown>;
  /** User messages seeded after the greeting (default 2). */
  userMessages?: number;
  /** Whether a default connection profile exists (default true). */
  profiles?: boolean;
}

/**
 * Fresh app over a migrated in-memory db. The app is built through the REAL
 * composition root (`createApp`), so the message-deletion → tracker cascade
 * is wired exactly as in production; `pluginsDir: null` keeps plugin
 * discovery off (hermetic, matching index.test.ts). The test's `repos` set
 * wraps the same db handle, so it seeds and asserts against what the routes
 * see.
 */
async function setup(opts: SetupOpts = {}) {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  if (opts.profiles !== false) {
    repos.profiles.create(
      { name: "Default", model: "tracker-model", base_url: "https://api.example" },
      { is_default: true },
    );
  }
  // The default config is disabled — these tests exercise the tracker
  // surface, so enable it unless a test overrides it.
  repos.settings.set("tracker_config", { enabled: true, ...opts.trackerConfig });

  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetchImpl = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      return opts.respond ? opts.respond(calls, init) : trackerReply();
    },
    { preconnect: () => {} },
  );
  const app = createApp(db, { fetchImpl, pluginsDir: null });

  const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
  const chatRes = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  expect(chatRes.status).toBe(201);
  const chatId = ((await chatRes.json()) as { chat: { id: string } }).chat.id;
  for (let i = 1; i <= (opts.userMessages ?? 2); i++) {
    const res = await app.request(
      `/api/chats/${chatId}/messages`,
      jsonInit("POST", { role: "user", content: `Message ${i}` }),
    );
    expect(res.status).toBe(201);
  }
  return { app, repos, bodies, chatId };
}

afterEach(() => {
  // The tracker mechanism registry is process-global and shared across test
  // files: always drop the fixture registered by the empty-plan test, even
  // when the test fails mid-way.
  tracker.unregisterTrackerMechanism("empty-plan");
});

/** Drops every active message of the chat (leaves it with zero messages). */
function emptyChat(repos: ReturnType<typeof createRepositories>, chatId: string): void {
  for (const message of repos.messages.listActive(chatId)) {
    repos.messages.deleteMessage(message.id);
  }
}

/**
 * Lets the composition root's microtask-batched tracker cascade pass run:
 * the pass was queued before this promise's resolution, so it always lands
 * first.
 */
const flushCascade = async (): Promise<void> => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
};

describe("GET /api/chats/:id/tracker", () => {
  it("reports the disabled state with no snapshot and no render", async () => {
    const { app, chatId } = await setup({ trackerConfig: { enabled: false } });
    const res = await app.request(`/api/chats/${chatId}/tracker`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      chat_enabled: true,
      invisible: false,
      mechanism: "suvoj-tracker",
      snapshot: null,
      render: null,
    });
  });

  it("returns the default render without a snapshot on an enabled empty chat", async () => {
    const { app, repos, chatId } = await setup({ userMessages: 0 });
    emptyChat(repos, chatId);
    const res = await app.request(`/api/chats/${chatId}/tracker`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      snapshot: unknown;
      render: { html: string; css: string };
    };
    expect(body.enabled).toBe(true);
    expect(body.snapshot).toBeNull();
    expect(body.render.html).toBe(tracker.DEFAULT_TRACKER_HTML);
    expect(body.render.css).toBe(tracker.DEFAULT_TRACKER_CSS);
  });

  it("returns the selected swipe's snapshot once one exists", async () => {
    const { app, repos, chatId } = await setup();
    // A manual run attaches to the current tail's active message, not null.
    const tailId = repos.messages.listActive(chatId).at(-1)?.id ?? null;
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    const res = await app.request(`/api/chats/${chatId}/tracker`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshot: { id: string; message_id: string | null; schema_key: string; data: unknown };
    };
    expect(body.snapshot).toMatchObject({
      message_id: tailId,
      schema_key: "default",
      data: TRACKER_JSON,
    });
    expect(typeof body.snapshot.id).toBe("string");
  });

  it("404s for an unknown chat", async () => {
    const { app } = await setup();
    expect((await app.request("/api/chats/nope/tracker")).status).toBe(404);
  });
});

describe("POST /api/chats/:id/tracker/generate", () => {
  it("generates, persists, and prunes to keep_last on the happy path", async () => {
    const { app, repos, bodies, chatId } = await setup({ trackerConfig: { keep_last: 2 } });
    for (let i = 0; i < 3; i++) {
      // Each run attaches to the current tail, so advance the chat between
      // runs: three runs span three POSITIONS and keep_last=2 keeps two.
      if (i > 0) {
        const added = await app.request(
          `/api/chats/${chatId}/messages`,
          jsonInit("POST", { role: "user", content: `Message ${i + 2}` }),
        );
        expect(added.status).toBe(201);
      }
      const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        enabled: boolean;
        snapshot: { data: unknown } | null;
        render: { html: string };
      };
      // The POST response carries the same GET shape, fresh snapshot included:
      expect(body.enabled).toBe(true);
      expect(body.snapshot?.data).toEqual(TRACKER_JSON);
      expect(body.render.html).toBe(tracker.DEFAULT_TRACKER_HTML);
    }
    // Retention: the newest snapshot per swipe across the newest two
    // positions — one exists per generated position, so two survive.
    expect(repos.trackers.listByChat(chatId)).toHaveLength(2);

    // The upstream call: the tracker system prompt + the windowed chat
    // history (all of it by default), on the tracker profile with the 0.3
    // temperature guard and the max_tokens override.
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({
      model: "tracker-model",
      temperature: 0.3,
      max_tokens: 8192,
    });
    const messages = (bodies[0]?.messages as { role: string; content: string }[]) ?? [];
    expect(messages.some((m) => m.content.includes("Scene Tracker Assistant"))).toBe(true);
    expect(messages.some((m) => m.content.includes("Hello!"))).toBe(true);
    expect(messages.some((m) => m.content.includes("Message 2"))).toBe(true);
    // The second call carries the previous POSITION's snapshot along
    // (include_last_trackers); the target's own group is always excluded.
    const messages2 = (bodies[1]?.messages as { content: string }[]) ?? [];
    expect(messages2.some((m) => m.content.includes("Previous tracker snapshot"))).toBe(true);
  });

  it("splits generation across parallel requests and merges the parts", async () => {
    const { app, repos, bodies, chatId } = await setup({
      trackerConfig: splitTrackerConfig({ parts: { count: 2, fields: { place: 2 } } }),
      // Order-independent: answer from the PART header in each request body.
      respond: (_call, init) => {
        const part = partOf(init);
        return sse(
          part === 2
            ? '```json\n{"place": "The market"}\n```'
            : '```json\n{"time": "11:30:00"}\n```',
        );
      },
    });

    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(200);

    // Exactly two upstream requests, one per part.
    expect(bodies).toHaveLength(2);
    // Each request's JSON prompt is scoped to its own part's field only.
    const byPart = new Map(bodies.map((body) => [partOfBody(body), lastMessage(body)]));
    expect(byPart.get(1)).toContain("**GENERATION PART 1 OF 2:**");
    expect(byPart.get(1)).toContain('"time"');
    expect(byPart.get(1)).not.toContain('"place"');
    expect(byPart.get(2)).toContain("**GENERATION PART 2 OF 2:**");
    expect(byPart.get(2)).toContain('"place"');
    expect(byPart.get(2)).not.toContain('"time"');

    // The persisted snapshot is the MERGED object of both parts.
    const rows = repos.trackers.listByChat(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toEqual({ time: "11:30:00", place: "The market" });
    expect(rows[0]?.schema_key).toBe("split");
  });

  it("fails atomically when one split part is unparseable", async () => {
    const { app, repos, bodies, chatId } = await setup({
      trackerConfig: splitTrackerConfig({ parts: { count: 2, fields: { place: 2 } } }),
      // Part 1 succeeds; part 2 (the second field) answers garbage.
      respond: (_call, init) =>
        partOf(init) === 2 ? sse("not json at all") : sse('```json\n{"time": "11:30:00"}\n```'),
    });

    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Failed to parse tracker response");
    // Both requests ran, but nothing was persisted (no partial snapshot).
    expect(bodies).toHaveLength(2);
    expect(repos.trackers.listByChat(chatId)).toEqual([]);
  });

  it("keeps a single request when the preset configures no split", async () => {
    // An explicit preset with no `parts` still resolves to one whole-schema
    // request (the default-config happy path above covers the built-in too).
    const { app, repos, bodies, chatId } = await setup({
      trackerConfig: splitTrackerConfig(),
    });
    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(partOfBody(bodies[0] ?? {})).toBe(0); // no PART header on a whole-schema prompt
    expect(lastMessage(bodies[0] ?? {})).toContain('"time"');
    expect(lastMessage(bodies[0] ?? {})).toContain('"place"');
    expect(repos.trackers.listForActiveMessages(chatId, 1).at(-1)?.data).toEqual(TRACKER_JSON);
  });

  it("fails with 502 and persists nothing when a mechanism resolves an empty plan", async () => {
    // A custom mechanism that declares the multi-request pair but resolves no
    // request — the service's contract guard must refuse to persist an empty
    // snapshot. Registered by hand: the registry is process-global, so the
    // afterEach hook removes it again.
    tracker.registerTrackerMechanism({
      id: "empty-plan",
      name: "Empty Plan",
      buildGenerationMessages: () => [],
      parseResponse: () => ({}),
      buildGenerationRequests: () => [],
      parseResponses: () => ({}),
    });
    const { app, repos, bodies, chatId } = await setup({
      trackerConfig: { mechanism: "empty-plan" },
    });
    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("produced no generation requests");
    // No upstream call and no snapshot — the guard fires before either.
    expect(bodies).toHaveLength(0);
    expect(repos.trackers.listByChat(chatId)).toEqual([]);
  });

  it("falls back to the built-in suvoj-tracker mechanism when the configured one is unknown", async () => {
    const { app, repos, chatId } = await setup({ trackerConfig: { mechanism: "ghost" } });
    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(repos.trackers.listForActiveMessages(chatId, 1).at(-1)?.data).toEqual(TRACKER_JSON);
  });

  it("maps an unparseable tracker response to 502 and persists nothing", async () => {
    const { app, repos, chatId } = await setup({ respond: () => sse("not json at all") });
    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Failed to parse tracker response");
    expect(repos.trackers.listByChat(chatId)).toEqual([]);
  });

  it("is a 400 on an empty chat (nothing to track yet)", async () => {
    const { app, repos, chatId } = await setup({ userMessages: 0 });
    emptyChat(repos, chatId);
    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No messages to track yet" });
  });

  it("is a 400 when the tracker is disabled", async () => {
    const { app, chatId } = await setup({ trackerConfig: { enabled: false } });
    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Tracker is disabled" });
  });

  it("is a 400 when no connection profile exists", async () => {
    const { app, chatId } = await setup({ profiles: false });
    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No connection profile configured" });
  });

  it("maps an unconfigured profile (empty base_url) to a 400, not a 502", async () => {
    // `resolveEndpoint`'s "no endpoint configured" is a client configuration
    // error, so it must not be reported as a bogus upstream 502.
    const { app, repos, chatId } = await setup();
    const profile = repos.profiles.list()[0];
    if (!profile) throw new Error("expected a seeded default profile");
    repos.profiles.update(profile.id, { base_url: "" });

    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No endpoint configured for this profile" });
  });

  it("404s for an unknown chat", async () => {
    const { app } = await setup();
    expect((await app.request("/api/chats/nope/tracker/generate", { method: "POST" })).status).toBe(
      404,
    );
  });
});

describe("PUT /api/chats/:id/tracker/enabled", () => {
  it("flips this chat's switch and reports it in the summary payload", async () => {
    const { app, repos, chatId } = await setup();
    const off = await app.request(
      `/api/chats/${chatId}/tracker/enabled`,
      jsonInit("PUT", { enabled: false }),
    );
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: true, chat_enabled: false });
    expect(repos.chats.get(chatId)?.tracker_enabled).toBe(false);

    const on = await app.request(
      `/api/chats/${chatId}/tracker/enabled`,
      jsonInit("PUT", { enabled: true }),
    );
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ enabled: true, chat_enabled: true });
    expect(repos.chats.get(chatId)?.tracker_enabled).toBe(true);
  });

  it("blocks generation for a chat switched off, without touching other chats", async () => {
    const { app, chatId } = await setup();
    await app.request(`/api/chats/${chatId}/tracker/enabled`, jsonInit("PUT", { enabled: false }));
    const res = await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Tracker is disabled for this chat" });
  });

  it("400s on a malformed body and 404s for an unknown chat", async () => {
    const { app, chatId } = await setup();
    expect(
      (
        await app.request(
          `/api/chats/${chatId}/tracker/enabled`,
          jsonInit("PUT", { enabled: "yes" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request("/api/chats/nope/tracker/enabled", jsonInit("PUT", { enabled: true })))
        .status,
    ).toBe(404);
  });
});

describe("DELETE /api/chats/:id/tracker", () => {
  it("drops every snapshot (204) and GET reflects the empty state", async () => {
    const { app, repos, chatId } = await setup();
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    const del = await app.request(`/api/chats/${chatId}/tracker`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect(repos.trackers.listByChat(chatId)).toEqual([]);

    const body = (await (await app.request(`/api/chats/${chatId}/tracker`)).json()) as {
      snapshot: unknown;
      render: { html: string };
    };
    expect(body.snapshot).toBeNull();
    expect(body.render.html).toBe(tracker.DEFAULT_TRACKER_HTML);
  });

  it("404s for an unknown chat", async () => {
    const { app } = await setup();
    expect((await app.request("/api/chats/nope/tracker", { method: "DELETE" })).status).toBe(404);
  });
});

describe("DELETE /api/messages/:id/tracker", () => {
  it("deletes only that message's tracker (204), leaving other swipes intact", async () => {
    const { app, repos, chatId } = await setup();
    // Track the tail, advance the chat, track again: two positions carry a
    // snapshot (keep_last defaults to 2, so both survive).
    const early = repos.messages.listActive(chatId).at(-1);
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/api/chats/${chatId}/messages`,
          jsonInit("POST", { role: "user", content: "Message 3" }),
        )
      ).status,
    ).toBe(201);
    const later = repos.messages.listActive(chatId).at(-1);
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    expect(repos.trackers.listByChat(chatId)).toHaveLength(2);

    const del = await app.request(`/api/messages/${early?.id}/tracker`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    // Only the early message's snapshot is gone; the later one survives.
    expect(repos.trackers.getForMessage(early?.id ?? "")).toBeNull();
    expect(repos.trackers.getForMessage(later?.id ?? "")?.data).toEqual(TRACKER_JSON);

    // The selected-swipe summary still reports the surviving tracker.
    const body = (await (await app.request(`/api/chats/${chatId}/tracker`)).json()) as {
      snapshot: { message_id: string } | null;
    };
    expect(body.snapshot?.message_id).toBe(later?.id);
  });

  it("is an idempotent 204 for an unknown message and deletes nothing", async () => {
    const { app, repos, chatId } = await setup();
    // Seed one snapshot so "deletes nothing" is observable.
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    expect(repos.trackers.listByChat(chatId)).toHaveLength(1);

    const del = await app.request("/api/messages/nope/tracker", { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    // The unknown id has no snapshots to strand; the chat's own survive.
    expect(repos.trackers.listByChat(chatId)).toHaveLength(1);
  });

  it("is a 204 for a message that was already deleted (stale-client case)", async () => {
    const { app, repos, chatId } = await setup();
    const tail = repos.messages.listActive(chatId).at(-1);
    if (!tail) {
      throw new Error("expected a tail message");
    }
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);

    // Delete the message through the real route: the cascade drops its
    // snapshot a microtask later. A stale client then targeting that dead id
    // must get a harmless no-op, not a 404.
    expect((await app.request(`/api/messages/${tail.id}`, { method: "DELETE" })).status).toBe(200);
    await flushCascade();
    expect(repos.trackers.getForMessage(tail.id)).toBeNull();

    const del = await app.request(`/api/messages/${tail.id}/tracker`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
  });
});

describe("GET /api/messages/:id/tracker", () => {
  it("returns the row's newest snapshot and the active preset's render", async () => {
    const { app, repos, chatId } = await setup();
    const tail = repos.messages.listActive(chatId).at(-1);
    if (!tail) {
      throw new Error("expected a tail message");
    }
    // Two snapshots on the same ROW: the newest (later seq) must win.
    repos.trackers.create(chatId, {
      message_id: tail.id,
      data: { time: "09:00:00" },
      schema_key: "default",
    });
    repos.trackers.create(chatId, {
      message_id: tail.id,
      data: { time: "11:00:00" },
      schema_key: "default",
    });

    const res = await app.request(`/api/messages/${tail.id}/tracker`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshot: { id: string; message_id: string | null; schema_key: string; data: unknown } | null;
      render: { html: string; css: string } | null;
    };
    expect(body.snapshot).toMatchObject({
      message_id: tail.id,
      schema_key: "default",
      data: { time: "11:00:00" },
    });
    expect(typeof body.snapshot?.id).toBe("string");
    expect(body.render).toEqual({
      html: tracker.DEFAULT_TRACKER_HTML,
      css: tracker.DEFAULT_TRACKER_CSS,
    });
  });

  it("is `{ snapshot: null, render: null }` for an untracked or unknown id", async () => {
    const { app, repos, chatId } = await setup();
    const untracked = repos.messages.listActive(chatId).at(-1);
    if (!untracked) {
      throw new Error("expected a tail message");
    }
    for (const id of [untracked.id, "nope"]) {
      const res = await app.request(`/api/messages/${id}/tracker`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ snapshot: null, render: null });
    }
  });

  it("stays readable when the tracker is disabled (snapshot created directly)", async () => {
    // The flag is per-row persisted data, not a live setting: disabling the
    // tracker must not hide a snapshot that was already generated.
    const { app, repos, chatId } = await setup({ trackerConfig: { enabled: false } });
    const tail = repos.messages.listActive(chatId).at(-1);
    if (!tail) {
      throw new Error("expected a tail message");
    }
    repos.trackers.create(chatId, {
      message_id: tail.id,
      data: TRACKER_JSON,
      schema_key: "default",
    });

    const res = await app.request(`/api/messages/${tail.id}/tracker`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshot: { data: unknown } | null;
      render: { html: string } | null;
    };
    expect(body.snapshot?.data).toEqual(TRACKER_JSON);
    expect(body.render?.html).toBe(tracker.DEFAULT_TRACKER_HTML);
  });
});

describe("message-deletion → tracker cascade through createApp", () => {
  it("delete-from drops the removed position's snapshot and keeps the survivor", async () => {
    const { app, repos, chatId } = await setup();
    // Track the tail, advance the chat, track again: two positions carry a
    // snapshot (keep_last defaults to 2, so both survive generation).
    const first = repos.messages.listActive(chatId).at(-1);
    if (!first) {
      throw new Error("expected a tail message");
    }
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    const added = await app.request(
      `/api/chats/${chatId}/messages`,
      jsonInit("POST", { role: "user", content: "Message 3" }),
    );
    expect(added.status).toBe(201);
    const second = repos.messages.listActive(chatId).at(-1);
    if (!second) {
      throw new Error("expected a new tail message");
    }
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    expect(repos.trackers.listByChat(chatId)).toHaveLength(2);

    // Bulk-delete the newer position. Its snapshot was attached to a row
    // that is now gone, so the cascade (one microtask later) must take it.
    const res = await app.request(
      `/api/chats/${chatId}/messages/delete-from`,
      jsonInit("POST", { from_seq: second.seq }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 1 });
    await flushCascade();

    // Only the surviving position's tracker remains, and no row points at a
    // missing message (the migration has no FK, so nothing else would catch
    // a dangling id).
    const rows = repos.trackers.listByChat(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_id).toBe(first.id);
    for (const row of rows) {
      if (row.message_id !== null) {
        expect(repos.messages.get(row.message_id)).not.toBeNull();
      }
    }

    // The summary payload reports the survivor, not the deleted position.
    const body = (await (await app.request(`/api/chats/${chatId}/tracker`)).json()) as {
      snapshot: { message_id: string } | null;
    };
    expect(body.snapshot?.message_id).toBe(first.id);
  });
});

describe("tracker panel fallback window", () => {
  it("falls back to the previous turn's tracker after the trailing reply is deleted", async () => {
    const { app, repos, chatId } = await setup({ userMessages: 0 });
    const post = (role: "user" | "assistant", content: string) =>
      app.request(`/api/chats/${chatId}/messages`, jsonInit("POST", { role, content }));

    // The default after_reply cadence tracks assistant replies only, so build
    // two turns by hand and track each assistant reply (the tail at the time).
    expect((await post("user", "U1")).status).toBe(201);
    expect((await post("assistant", "A1")).status).toBe(201);
    const a1 = repos.messages.listActive(chatId).at(-1);
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    expect(repos.trackers.getForMessage(a1?.id ?? "")?.message_id).toBe(a1?.id);

    expect((await post("user", "U2")).status).toBe(201);
    expect((await post("assistant", "A2")).status).toBe(201);
    const a2 = repos.messages.listActive(chatId).at(-1);
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    expect(repos.trackers.getForMessage(a2?.id ?? "")?.message_id).toBe(a2?.id);

    // Default keep_last = 2, and retention counts POSITIONS THAT CARRY a
    // snapshot, so BOTH A1's and A2's trackers survive — the end-to-end proof
    // of the retention fix (not just the newest one).
    expect(repos.trackers.listByChat(chatId)).toHaveLength(2);

    // Delete the trailing reply: its snapshot goes with it a microtask later.
    expect((await app.request(`/api/messages/${a2?.id}`, { method: "DELETE" })).status).toBe(200);
    await flushCascade();
    expect(repos.trackers.getForMessage(a2?.id ?? "")).toBeNull();

    // The bounded window (the newest two positions = U2 and A1) surfaces A1's
    // surviving tracker — never the deleted A2's id, and never a stale older
    // one.
    const body = (await (await app.request(`/api/chats/${chatId}/tracker`)).json()) as {
      snapshot: { message_id: string | null } | null;
    };
    expect(body.snapshot).not.toBeNull();
    expect(body.snapshot?.message_id).toBe(a1?.id);

    // A1's row is the single survivor after the cascade.
    const rows = repos.trackers.listByChat(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_id).toBe(a1?.id);
  });

  it("is empty when the newest kept tracker sits outside the newest two positions", async () => {
    const { app, repos, chatId } = await setup({ userMessages: 0 });
    const post = (role: "user" | "assistant", content: string) =>
      app.request(`/api/chats/${chatId}/messages`, jsonInit("POST", { role, content }));

    // A tracked assistant reply (A1) followed by two newer UNTRACKED messages:
    // the chat's newest two positions then carry no snapshot at all.
    expect((await post("user", "U1")).status).toBe(201);
    expect((await post("assistant", "A1")).status).toBe(201);
    expect(
      (await app.request(`/api/chats/${chatId}/tracker/generate`, { method: "POST" })).status,
    ).toBe(200);
    expect(repos.trackers.listByChat(chatId)).toHaveLength(1);
    expect((await post("user", "U2")).status).toBe(201);
    expect((await post("assistant", "A2")).status).toBe(201);

    // The panel window is bounded to raw positions, so it is simply empty —
    // even though the tracker row still exists in the DB.
    const body = (await (await app.request(`/api/chats/${chatId}/tracker`)).json()) as {
      snapshot: { message_id: string | null } | null;
    };
    expect(body.snapshot).toBeNull();
    expect(repos.trackers.listByChat(chatId)).toHaveLength(1);
  });
});
