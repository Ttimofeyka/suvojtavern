/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createApp } from "../app";

/**
 * `POST /api/lorebooks/generate-entry` (AI-assisted lorebook entry
 * generation). The tests compose the REAL app through `createApp` so route
 * registration, the settings-backed config accessor, the profile resolver and
 * the gateway error mapping are all exercised end to end.
 *
 * `pluginsDir: null` keeps plugin discovery off (hermetic, matching the other
 * app-level tests). The upstream is stubbed via `fetchImpl`; because the
 * gateway always streams, every fake reply is an SSE body.
 */

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** One SSE completion chunk carrying `text`, then the terminator. */
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

/** An SSE body whose sole chunk is an upstream error — the gateway throws. */
const errorSse = (message: string): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: { message } })}\n\n`));
        c.close();
      },
    }),
  );

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface SetupOpts {
  /** Whether to seed the default + writer profiles (default true). */
  profiles?: boolean;
  /** Per-call upstream response; defaults to a one-chunk completion. */
  respond?: () => Response;
}

/**
 * Builds the app over a fresh in-memory DB. With `profiles` (the default),
 * seeds a default profile plus a custom-endpoint "Writer" profile and points
 * the stored lorebook-generation config at the Writer — so a passing happy
 * path proves the config's `profile_id` wins over the default profile.
 */
function setup(opts: SetupOpts = {}) {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  let writerId: string | null = null;
  if (opts.profiles !== false) {
    repos.profiles.create(
      { name: "Default", model: "default-model", base_url: "https://llm.example.com" },
      { is_default: true },
    );
    writerId = repos.profiles.create({
      name: "Writer",
      model: "writer-model",
      base_url: "https://llm.example.com",
      api_key: "sk-writer",
      // A profile sampler a creative writer would override: the route must
      // carry `top_p` through while pinning temperature to 0.9.
      sampling: { temperature: 0.2, top_p: 0.5, stream: true },
    }).id;
    repos.settings.set("lorebook_generation", {
      profile_id: writerId,
      system_prompt: "You write lore.",
      max_response_tokens: 1234,
    });
  }

  const bodies: Captured[] = [];
  const fetchImpl = Object.assign(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return opts.respond ? opts.respond() : sse("The ruined cathedral looms.");
    },
    { preconnect: () => {} },
  );

  const app = createApp(db, { fetchImpl, pluginsDir: null });
  return { app, repos, bodies, writerId };
}

describe("POST /api/lorebooks/generate-entry", () => {
  it("generates entry content through the configured profile", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/lorebooks/generate-entry",
      jsonInit("POST", {
        description: "A ruined cathedral",
        instructions: "Keep it short",
        current_content: "An old entry.",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "The ruined cathedral looms." });

    // Exactly one upstream call, against the Writer profile's own endpoint
    // and key.
    expect(bodies).toHaveLength(1);
    const sent = bodies[0];
    expect(sent?.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(sent?.headers.Authorization).toBe("Bearer sk-writer");
    expect(sent?.body).toMatchObject({
      // The profile's model, not the default profile's.
      model: "writer-model",
      // Creative-writing temperature is pinned; the profile's other samplers
      // survive and `stream` is re-added by the gateway.
      temperature: 0.9,
      top_p: 0.5,
      max_tokens: 1234,
      stream: true,
    });

    const messages = (sent?.body.messages as { role: string; content: string }[]) ?? [];
    expect(messages[0]).toEqual({ role: "system", content: "You write lore." });
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("DESCRIPTION: A ruined cathedral");
    expect(messages[1]?.content).toContain("INSTRUCTIONS: Keep it short");
    expect(messages[1]?.content).toContain("CURRENT CONTENT: An old entry.");
  });

  it("is a 400 when description is missing", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/lorebooks/generate-entry",
      jsonInit("POST", { instructions: "Keep it short" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request body" });
    // The body was rejected before any upstream call.
    expect(bodies).toHaveLength(0);
  });

  it("is a 400 when the stored config disables the feature", async () => {
    const { app, repos, bodies } = setup();
    repos.settings.set("lorebook_generation", { enabled: false });
    const res = await app.request(
      "/api/lorebooks/generate-entry",
      jsonInit("POST", { description: "A ruined cathedral" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Lorebook entry generation is disabled" });
    expect(bodies).toHaveLength(0);
  });

  it("is a 400 when no connection profile exists", async () => {
    const { app, bodies } = setup({ profiles: false });
    const res = await app.request(
      "/api/lorebooks/generate-entry",
      jsonInit("POST", { description: "A ruined cathedral" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No connection profile configured" });
    expect(bodies).toHaveLength(0);
  });

  it("maps an upstream failure through GatewayError to 502", async () => {
    const { app } = setup({ respond: () => errorSse("upstream boom") });
    const res = await app.request(
      "/api/lorebooks/generate-entry",
      jsonInit("POST", { description: "A ruined cathedral" }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream boom" });
  });

  it("defaults instructions/current_content when omitted", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/lorebooks/generate-entry",
      jsonInit("POST", { description: "Solo" }),
    );
    expect(res.status).toBe(200);
    const messages = (bodies[0]?.body.messages as { content: string }[]) ?? [];
    expect(messages[1]?.content).toContain("DESCRIPTION: Solo");
    expect(messages[1]?.content).toContain("INSTRUCTIONS: (none)");
    expect(messages[1]?.content).toContain("CURRENT CONTENT: (none)");
  });
});
