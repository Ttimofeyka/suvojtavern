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
import { trackerRoutes } from "./tracker";

/**
 * The generate SSE route's tracker integration: before_reply / after_reply
 * auto modes, manual mode, and the failure-isolation contract (a tracker
 * failure NEVER breaks the main generation stream).
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

/** The model reply for a generation call. */
const generationReply = (): Response => sse("Hi there");

/** The model reply for a tracker call: one fenced JSON block. */
const trackerReply = (data: Record<string, unknown> = TRACKER_JSON): Response =>
  sse(`\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);

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

interface SetupOpts {
  trackerConfig?: Record<string, unknown>;
  respond?: (call: number) => Response;
}

/** Fresh app + profile + chat + a request-capturing fetch. Call 1 is the
 *  generation, later calls the tracker (before_reply flips that order). */
async function setup(opts: SetupOpts = {}) {
  const db: Database = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  repos.profiles.create(
    { name: "Default", model: "tracker-model", base_url: "https://api.example" },
    { is_default: true },
  );
  // The default config is disabled — these tests exercise the tracker
  // integration, so enable it unless a test overrides it.
  repos.settings.set("tracker_config", { enabled: true, ...opts.trackerConfig });

  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetchImpl = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      return opts.respond ? opts.respond(calls) : generationReply();
    },
    { preconnect: () => {} },
  );
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  const app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", generateRoutes(deps));
  app.route("/", trackerRoutes(deps));

  const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
  const chatRes = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  expect(chatRes.status).toBe(201);
  const chatId = ((await chatRes.json()) as { chat: { id: string } }).chat.id;
  const res = await app.request(
    `/api/chats/${chatId}/messages`,
    jsonInit("POST", { role: "user", content: "Hi Aria" }),
  );
  expect(res.status).toBe(201);
  return { app, repos, bodies, chatId };
}

async function generate(
  app: Hono,
  chatId: string,
  body: Record<string, unknown> = {},
): Promise<{ events: Record<string, unknown>[]; text: string }> {
  const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", body));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { events: parseEvents(text), text };
}

describe("POST /api/chats/:id/generate (tracker auto modes)", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // The route logs (never throws) tracker failures.
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("after_reply: tracks after the reply, before done, linking the persisted message", async () => {
    const { app, repos, bodies, chatId } = await setup({
      // Call 1 is the generation, call 2 the tracker.
      respond: (call) => (call === 1 ? generationReply() : trackerReply()),
    });

    const { events } = await generate(app, chatId);
    expect(stagesOf(events)).toEqual(["preparing", "prompt", "tracking"]);

    const trackerIdx = events.findIndex((e) => e.type === "tracker");
    const doneIdx = events.findIndex((e) => e.type === "done");
    expect(trackerIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBe(events.length - 1); // done stays the last event
    expect(trackerIdx).toBeLessThan(doneIdx);

    const trackerEvent = events[trackerIdx] as {
      ok: boolean;
      snapshot: { message_id: string | null; data: unknown };
      render: { html: string };
    };
    expect(trackerEvent.ok).toBe(true);
    expect(trackerEvent.snapshot.data).toEqual(TRACKER_JSON);
    expect(trackerEvent.render.html).toContain("tracker-card");
    // The snapshot follows the persisted assistant reply:
    const done = events[doneIdx] as { message_id: string };
    expect(trackerEvent.snapshot.message_id).toBe(done.message_id);

    const rows = repos.trackers.listByChat(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ message_id: done.message_id, schema_key: "default" });
    // One generation call + one tracker call.
    expect(bodies).toHaveLength(2);
  });

  it("before_reply: tracks the tail before prompt assembly and injects the fresh snapshot", async () => {
    const { app, repos, bodies, chatId } = await setup({
      trackerConfig: { auto_mode: "before_reply" },
      // Call 1 is the tracker, call 2 the generation.
      respond: (call) => (call === 1 ? trackerReply() : generationReply()),
    });
    // The reply does not exist yet, so the snapshot attaches to the current
    // tail's ACTIVE message (the latest user turn).
    const tailId = repos.messages.listActive(chatId).at(-1)?.id ?? null;

    const { events } = await generate(app, chatId);
    const trackerIdx = events.findIndex((e) => e.type === "tracker");
    const promptIdx = events.findIndex((e) => e.stage === "prompt");
    expect(trackerIdx).toBeGreaterThan(-1);
    expect(trackerIdx).toBeLessThan(promptIdx); // BEFORE the prompt status
    expect((events[trackerIdx] as { ok: boolean }).ok).toBe(true);
    expect(
      (events[trackerIdx] as { snapshot: { message_id: string | null } }).snapshot.message_id,
    ).toBe(tailId);

    // The generation prompt (upstream call 2) carries the fresh tracker
    // snapshot through the pipeline's injection stage.
    expect(bodies).toHaveLength(2);
    const prompt = JSON.stringify(bodies[1]);
    expect(prompt).toContain("Tracker:");
    expect(prompt).toContain("The tavern, back room");
  });

  it("manual mode: no tracker events, no tracker calls during generation", async () => {
    const { app, repos, bodies, chatId } = await setup({
      trackerConfig: { auto_mode: "manual" },
    });

    const { events } = await generate(app, chatId);
    expect(events.find((e) => e.type === "tracker")).toBeUndefined();
    expect(stagesOf(events)).toEqual(["preparing", "prompt"]);
    expect(bodies).toHaveLength(1);
    expect(repos.trackers.listByChat(chatId)).toEqual([]);
  });

  it("a failing tracker generation never breaks the main stream", async () => {
    const { app, repos, chatId } = await setup({
      // The tracker call (2) answers with unparseable garbage.
      respond: (call) => (call === 1 ? generationReply() : sse("garbage not json")),
    });

    const { events } = await generate(app, chatId);
    expect(events.find((e) => e.type === "done")).toMatchObject({ content: "Hi there" });
    const trackerEvent = events.find((e) => e.type === "tracker") as {
      ok: boolean;
      error: string;
    };
    expect(trackerEvent.ok).toBe(false);
    expect(trackerEvent.error).toContain("Failed to parse tracker response");
    expect(repos.trackers.listByChat(chatId)).toEqual([]);
    expect(repos.messages.listActive(chatId).at(-1)?.content).toBe("Hi there");
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("regenerate: a new swipe's tracker generates from zero and reads follow the selected swipe", async () => {
    // Two distinct tracker states so the assertions can tell them apart.
    const t1 = TRACKER_JSON; // location "The tavern, back room"
    const t2 = { time: "11:00:00; 01/01/2026 (Thursday)", location: "The market" };
    const { app, repos, bodies, chatId } = await setup({
      respond: (call) => {
        if (call === 1) return generationReply(); // append reply A
        if (call === 2) return trackerReply(t1); // tracker attached to A
        if (call === 3) return sse("Second reply"); // regenerate → swipe B
        if (call === 4) return trackerReply(t2); // tracker attached to B
        if (call === 5) return sse("Third reply"); // append reply C
        return trackerReply(); // tracker attached to C
      },
    });

    // First generation: reply A, with T1 attached to it.
    const first = await generate(app, chatId);
    const aId = (first.events.find((e) => e.type === "done") as { message_id: string }).message_id;

    // Regenerate: a new swipe B of A's group, with T2 attached to B.
    const second = await generate(app, chatId, { regenerate: true });
    const bId = (second.events.find((e) => e.type === "done") as { message_id: string }).message_id;
    expect(bId).not.toBe(aId);
    expect(repos.messages.get(bId)?.seq).toBe(repos.messages.get(aId)?.seq);

    // (1) B's tracker REQUEST never carried T1: `listForMessagesBefore` excludes
    // the target's whole sibling group, so a fresh swipe generates from zero.
    expect(JSON.stringify(bodies[3])).not.toContain("The tavern, back room");
    // ...and T1's request predates T2 (sanity on the captured call order).
    expect(JSON.stringify(bodies[1])).not.toContain("The market");

    // (2) The SSE tracker event for B points at the selected swipe.
    const bTrackerEvent = second.events.find((e) => e.type === "tracker") as {
      snapshot: { message_id: string | null; data: unknown };
    };
    expect(bTrackerEvent.snapshot.message_id).toBe(bId);
    expect(bTrackerEvent.snapshot.data).toEqual(t2);

    // (3) T1's row still exists, attached to A (the now-inactive sibling).
    expect(repos.trackers.getForMessage(aId)?.data).toEqual(t1);
    expect(repos.trackers.getForMessage(bId)?.data).toEqual(t2);

    // (4) The summary reports the SELECTED swipe's tracker, not A's.
    const summary = (await (await app.request(`/api/chats/${chatId}/tracker`)).json()) as {
      snapshot: { message_id: string } | null;
    };
    expect(summary.snapshot?.message_id).toBe(bId);

    // (5) A subsequent generation's prompt injects only B's tracker — the
    // inactive sibling's T1 is never fed to the main model.
    await generate(app, chatId);
    const cPrompt = JSON.stringify(bodies[4]);
    expect(cPrompt).toContain("The market");
    expect(cPrompt).not.toContain("The tavern, back room");
  });

  it("before_reply: a regenerate's snapshot attaches to the replaced swipe, so the panel goes empty", async () => {
    const t1 = TRACKER_JSON; // location "The tavern, back room"
    const t2 = { time: "11:00:00; 01/01/2026 (Thursday)", location: "The market" };
    const { app, repos, bodies, chatId } = await setup({
      respond: (call) => {
        if (call === 1) return generationReply(); // append reply A
        if (call === 2) return trackerReply(t1); // after_reply tracker attached to A
        if (call === 3) return trackerReply(t2); // before_reply tracker, pre-regeneration
        return sse("Regenerated reply"); // regenerate → swipe B
      },
    });

    // First generation (default after_reply) gives assistant A a tracker.
    const first = await generate(app, chatId);
    const aId = (first.events.find((e) => e.type === "done") as { message_id: string }).message_id;

    // Switch to before_reply: the regenerate tracks the tail BEFORE the new
    // swipe is persisted, so the snapshot is generated and attached to A — the
    // swipe being replaced. It is NOT fed into the regenerate's own prompt:
    // injection skips the replaced position's whole sibling group.
    repos.settings.set("tracker_config", { enabled: true, auto_mode: "before_reply" });
    const second = await generate(app, chatId, { regenerate: true });
    const trackerIdx = second.events.findIndex((e) => e.type === "tracker");
    const promptIdx = second.events.findIndex((e) => e.stage === "prompt");
    expect(trackerIdx).toBeGreaterThan(-1);
    expect(trackerIdx).toBeLessThan(promptIdx); // snapshot precedes prompt assembly

    const bId = (second.events.find((e) => e.type === "done") as { message_id: string }).message_id;
    expect(bId).not.toBe(aId);

    // The SSE tracker event points at A (the pre-regeneration tail), and A's
    // row now holds the freshly generated data.
    const trackerEvent = second.events[trackerIdx] as {
      ok: boolean;
      snapshot: { message_id: string | null; data: unknown };
    };
    expect(trackerEvent.ok).toBe(true);
    expect(trackerEvent.snapshot.message_id).toBe(aId);
    expect(trackerEvent.snapshot.data).toEqual(t2);
    expect(repos.trackers.getForMessage(aId)?.data).toEqual(t2);
    // The fresh snapshot is NOT injected into the regenerate's prompt: it is
    // attached to A, the swipe being replaced, and injection excludes the
    // replaced position's whole sibling group.
    expect(JSON.stringify(bodies[3])).not.toContain("The market");

    // B is the new active swipe and owns no tracker — A is now inactive — so
    // the panel reports the empty state.
    const summary = (await (await app.request(`/api/chats/${chatId}/tracker`)).json()) as {
      snapshot: unknown | null;
    };
    expect(summary.snapshot).toBeNull();
  });

  it("a new swipe's tracker prompt is blind to sibling swipes and their trackers", async () => {
    // Distinctive markers: the inactive siblings' content, their trackers'
    // data, and the target position's own tracker must all stay out of the
    // tracker's OWN generation prompt.
    const aMarker = { time: "10:00:00; 01/01/2026 (Thursday)", location: "sibling-A-marker" };
    const bMarker = { time: "11:00:00; 01/01/2026 (Thursday)", location: "sibling-B-marker" };
    const { app, bodies, chatId } = await setup({
      respond: (call) => {
        if (call === 1) return sse("Reply A"); // append assistant A @ seq 3
        if (call === 2) return trackerReply(aMarker); // tracker T_A on A
        if (call === 3) return sse("Reply B"); // regenerate → swipe B @ seq 3
        if (call === 4) return trackerReply(bMarker); // tracker T_B on B
        if (call === 5) return sse("Reply C"); // regenerate → swipe C @ seq 3
        return trackerReply(); // tracker T_C on C
      },
    });

    await generate(app, chatId); // A + T_A
    await generate(app, chatId, { regenerate: true }); // B + T_B
    await generate(app, chatId, { regenerate: true }); // C + T_C

    // Captured calls: [0]=gen A, [1]=tracker T_A, [2]=gen B, [3]=tracker T_B,
    // [4]=gen C, [5]=tracker T_C.
    expect(bodies).toHaveLength(6);
    const trackerC = JSON.stringify(bodies[5]);
    // C's tracker sees only the active history (the user turn + C's own reply)
    // and no previous-tracker snapshot: the whole sibling group is excluded.
    expect(trackerC).not.toContain("sibling-A-marker");
    expect(trackerC).not.toContain("sibling-B-marker");
    expect(trackerC).not.toContain("Reply A");
    expect(trackerC).not.toContain("Reply B");
    // Sanity: B's tracker was already blind to A's tracker (same position).
    expect(JSON.stringify(bodies[3])).not.toContain("sibling-A-marker");
    // The active user turn is still part of the tracker's context.
    expect(trackerC).toContain("Hi Aria");
  });
});
