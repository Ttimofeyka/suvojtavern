/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, engine, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { generateRoutes } from "./generate";
import { messagesRoutes } from "./messages";

/**
 * Generation × regex rules: an active `ai`-placement rule must transform the
 * PERSISTED reply and the `done` event content (identically), mark the row
 * `regex_applied`, and apply exactly once per generation — while the no-rules
 * path stays byte-identical to the pre-regex behaviour.
 */

/** A stubbed upstream streaming `text` as one delta. */
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

interface SetupOpts {
  /** The model's reply for a generation call (default "Hi there"). */
  reply?: string;
}

async function setup(opts: SetupOpts = {}) {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  repos.profiles.create(
    { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
    { is_default: true },
  );
  const fetchImpl: typeof fetch = Object.assign(async () => sse(opts.reply ?? "Hi there"), {
    preconnect: () => {},
  });
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  const app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", generateRoutes(deps));
  const characterId = repos.characters.create({
    name: "Aria",
    first_mes: "Hello!",
    alternate_greetings: ["Hi!", "Hey!"],
  }).id;
  return { app, repos, characterId };
}

/** A minimal rule with overridable fields. */
function rule(overrides: Partial<engine.RegexRule> = {}): engine.RegexRule {
  return {
    id: "r1",
    name: "Rule",
    find: "/Hi/g",
    replace: "Yo",
    placement: ["ai"],
    enabled: true,
    ...overrides,
  };
}

/** Stores rules under the settings key the engine reads. */
function storeRules(repos: ReturnType<typeof createRepositories>, rules: engine.RegexRule[]): void {
  repos.settings.set(engine.REGEX_RULES_KEY, rules);
}

/** Creates a chat through the API; returns its id. */
async function newChat(app: Hono, characterId: string): Promise<string> {
  const res = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  expect(res.status).toBe(201);
  const { chat } = (await res.json()) as { chat: { id: string } };
  return chat.id;
}

/** The last persisted assistant message of a chat. */
function lastAssistant(repos: ReturnType<typeof createRepositories>, chatId: string) {
  return repos.messages
    .listActive(chatId)
    .filter((message) => message.role === "assistant")
    .at(-1);
}

describe("POST /api/chats/:id/generate with ai regex rules", () => {
  it("transforms the persisted reply and the done content, and marks the row", async () => {
    const { app, repos, characterId } = await setup();
    storeRules(repos, [rule()]);
    const chatId = await newChat(app, characterId);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    const done = events.find((event) => event.type === "done");
    expect(done?.content).toBe("Yo there");
    const persisted = lastAssistant(repos, chatId);
    expect(persisted?.content).toBe("Yo there");
    expect(done?.content).toBe(persisted?.content);
    expect(persisted?.metadata).toMatchObject({ regex_applied: true });
  });

  it("leaves the reply untransformed and unmarked when no rules are stored", async () => {
    const { app, repos, characterId } = await setup();
    const chatId = await newChat(app, characterId);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    expect(events.find((event) => event.type === "done")?.content).toBe("Hi there");
    const persisted = lastAssistant(repos, chatId);
    expect(persisted?.content).toBe("Hi there");
    expect(persisted?.metadata).toBeNull();
    expect(persisted?.metadata?.regex_applied).toBeUndefined();
  });

  it("ignores a user-placement rule when persisting the reply", async () => {
    const { app, repos, characterId } = await setup();
    storeRules(repos, [rule({ placement: ["user"] })]);
    const chatId = await newChat(app, characterId);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    expect(events.find((event) => event.type === "done")?.content).toBe("Hi there");
    const persisted = lastAssistant(repos, chatId);
    expect(persisted?.content).toBe("Hi there");
    // No ai pass ran, so no marker — the assembly side will still apply its
    // own `user` pass where appropriate.
    expect(persisted?.metadata).toBeNull();
  });

  it("marks the row even when the text was unchanged by the pass", async () => {
    const { app, repos, characterId } = await setup();
    // A rule that matches nothing in the reply: the flag means "went through
    // the ai pass", not "the text changed".
    storeRules(repos, [rule({ find: "/zzz/g", replace: "x" })]);
    const chatId = await newChat(app, characterId);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    await res.text();

    const persisted = lastAssistant(repos, chatId);
    expect(persisted?.content).toBe("Hi there");
    expect(persisted?.metadata).toMatchObject({ regex_applied: true });
  });

  it("transforms a regenerate swipe and marks it", async () => {
    const { app, repos, characterId } = await setup();
    storeRules(repos, [rule()]);
    const chatId = await newChat(app, characterId);

    const res = await app.request(
      `/api/chats/${chatId}/generate`,
      jsonInit("POST", { regenerate: true }),
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    expect(events.find((event) => event.type === "done")?.content).toBe("Yo there");
    const persisted = lastAssistant(repos, chatId);
    expect(persisted?.content).toBe("Yo there");
    expect(persisted?.metadata).toMatchObject({ regex_applied: true });
    // The swipe is a fresh row in the greeting's group; the original greeting
    // text was never touched.
    expect(repos.messages.listAll(chatId).find((row) => row.content === "Hello!")).toBeDefined();
  });

  it("applies a non-idempotent rule exactly once (persisted, not doubled)", async () => {
    const { app, repos, characterId } = await setup({ reply: "x" });
    storeRules(repos, [rule({ find: "/x/g", replace: "xx" })]);
    const chatId = await newChat(app, characterId);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    // "x" → "xx", never "xxxx".
    expect(events.find((event) => event.type === "done")?.content).toBe("xx");
    expect(lastAssistant(repos, chatId)?.content).toBe("xx");
  });
});

describe("POST /api/chats/:id/generate (continue) with ai regex rules", () => {
  it("transforms the merged text of an unmarked row and marks it", async () => {
    const { app, repos, characterId } = await setup();
    storeRules(repos, [rule({ find: "/x/g", replace: "xx" })]);
    const chatId = await newChat(app, characterId);
    // A legacy, untransformed assistant row: the continuation must clean the
    // WHOLE merged text, not just the appended fragment.
    const seeded = repos.messages.insertMessage(chatId, {
      role: "assistant",
      name: "Aria",
      content: "x",
    });

    const res = await app.request(
      `/api/chats/${chatId}/generate`,
      jsonInit("POST", { continue: true }),
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    expect(events.find((event) => event.type === "done")?.content).toBe("xx Hi there");
    const merged = repos.messages.get(seeded.id);
    expect(merged?.content).toBe("xx Hi there");
    expect(merged?.metadata).toMatchObject({ regex_applied: true });
  });

  it("never double-applies when continuing an already-marked row", async () => {
    const { app, repos, characterId } = await setup();
    storeRules(repos, [rule({ find: "/x/g", replace: "xx" })]);
    const chatId = await newChat(app, characterId);
    // Already through the ai pass: re-running the non-idempotent rule over the
    // existing half would turn "x" into "xx" a second time.
    const seeded = repos.messages.insertMessage(chatId, {
      role: "assistant",
      name: "Aria",
      content: "x",
      metadata: { regex_applied: true, reasoning: "first-half thinking" },
    });

    const res = await app.request(
      `/api/chats/${chatId}/generate`,
      jsonInit("POST", { continue: true }),
    );
    expect(res.status).toBe(200);
    await res.text();

    const merged = repos.messages.get(seeded.id);
    expect(merged?.content).toBe("x Hi there");
    // The first half's reasoning survives (only the flag is folded in).
    expect(merged?.metadata).toEqual({ regex_applied: true, reasoning: "first-half thinking" });
  });

  it("keeps the pre-regex behaviour when no ai rule is active", async () => {
    const { app, repos, characterId } = await setup();
    const chatId = await newChat(app, characterId);
    const seeded = repos.messages.insertMessage(chatId, {
      role: "assistant",
      name: "Aria",
      content: "Half a ",
      metadata: { reasoning: "first-half thinking" },
    });

    const res = await app.request(
      `/api/chats/${chatId}/generate`,
      jsonInit("POST", { continue: true }),
    );
    expect(res.status).toBe(200);
    await res.text();

    const merged = repos.messages.get(seeded.id);
    expect(merged?.content).toBe("Half a Hi there");
    expect(merged?.metadata).toEqual({ reasoning: "first-half thinking" });
  });
});
