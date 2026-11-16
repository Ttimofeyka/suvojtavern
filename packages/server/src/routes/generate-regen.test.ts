/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { generateRoutes } from "./generate";
import { messagesRoutes } from "./messages";

/** The active greeting's content — distinctive so a prompt leak is obvious. */
const GREETING = "Opening greeting from Aria.";

const sse = (): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        c.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":" there"}}]}\n\n'),
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

/** The upstream request's joined `messages[].content`. */
const promptText = (body: Record<string, unknown>): string =>
  ((body.messages as { content: string }[] | undefined) ?? [])
    .map((message) => message.content)
    .join("\n");

interface Setup {
  app: Hono;
  repos: ReturnType<typeof createRepositories>;
  bodies: Record<string, unknown>[];
  chatId: string;
  greetingId: string;
}

/** Fresh app + a chat whose only message is the active greeting, plus a
 *  request-capturing fetch (`bodies[0]` is the generation). */
async function setup(): Promise<Setup> {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  repos.profiles.create(
    { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
    { is_default: true },
  );
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse();
    },
    { preconnect: () => {} },
  );
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  const app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", generateRoutes(deps));

  const characterId = repos.characters.create({
    name: "Aria",
    first_mes: GREETING,
    alternate_greetings: ["Hi!", "Hey!"],
  }).id;
  const chatRes = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  expect(chatRes.status).toBe(201);
  const { chat, greeting } = (await chatRes.json()) as {
    chat: { id: string };
    greeting: { active_id: string };
  };
  return { app, repos, bodies, chatId: chat.id, greetingId: greeting.active_id };
}

describe("POST /api/chats/:id/generate (regenerate)", () => {
  it("adds the regenerated reply as a new active swipe of the greeting group", async () => {
    const { app, repos, chatId, greetingId: rootId } = await setup();

    const res = await app.request(
      `/api/chats/${chatId}/generate`,
      jsonInit("POST", { regenerate: true }),
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    expect(events.some((e) => e.type === "done")).toBe(true);

    const group = repos.messages
      .listAll(chatId)
      .filter((row) => row.id === rootId || row.variant_of === rootId);
    expect(group).toHaveLength(4);
    expect(new Set(group.map((row) => row.seq)).size).toBe(1);
    const active = group.filter((row) => row.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toBe("Hi there");
    expect(group.find((row) => row.id === rootId)?.active).toBe(false);
  });

  it("regenerating hides the replaced assistant turn; a plain run still sees it", async () => {
    // The replaced greeting must not remain the prompt's final assistant turn,
    // or the model would continue the old option instead of writing a fresh one.
    const regen = await setup();
    const regenRes = await regen.app.request(
      `/api/chats/${regen.chatId}/generate`,
      jsonInit("POST", { regenerate: true }),
    );
    await regenRes.text(); // consume the SSE stream to drive the generation
    expect(regen.bodies).toHaveLength(1);
    expect(promptText(regen.bodies[0] as Record<string, unknown>)).not.toContain(GREETING);

    // A plain (non-regenerate) run assembles the UNCHANGED active history.
    const plain = await setup();
    const plainRes = await plain.app.request(
      `/api/chats/${plain.chatId}/generate`,
      jsonInit("POST", {}),
    );
    await plainRes.text();
    expect(plain.bodies).toHaveLength(1);
    expect(promptText(plain.bodies[0] as Record<string, unknown>)).toContain(GREETING);
  });
});
