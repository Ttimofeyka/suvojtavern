/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createApp } from "../app";

/**
 * `POST /api/characters/generate-description` (AI-assisted character-card
 * field generation). The tests compose the REAL app through `createApp` so
 * route registration, the settings-backed config accessor, the profile
 * resolver and the gateway error mapping are all exercised end to end.
 *
 * `pluginsDir: null` keeps plugin discovery off (hermetic, matching the
 * other app-level tests). The upstream is stubbed via `fetchImpl`; because
 * the gateway always streams, every fake reply is an SSE body.
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
 * the stored character-generation config at the Writer — so a passing happy
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
    repos.settings.set("character_generation", {
      profile_id: writerId,
      system_prompt: "You write worlds.",
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
      return opts.respond ? opts.respond() : sse("A striking floating city.");
    },
    { preconnect: () => {} },
  );

  const app = createApp(db, { fetchImpl, pluginsDir: null });
  return { app, repos, bodies };
}

describe("POST /api/characters/generate-field", () => {
  it("uses the field-specific prompt and carries the context block", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/characters/generate-field",
      jsonInit("POST", {
        field: "personality",
        name: "Aria",
        tags: ["mage"],
        idea: "Make her guarded.",
        current_text: "Calm.",
        context: "DESCRIPTION:\nA floating city.",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "A striking floating city." });

    const messages = (bodies[0]?.body.messages as { role: string; content: string }[]) ?? [];
    // The personality prompt is fixed in core, not the configured description
    // prompt, and the user block names the target field.
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("personality");
    expect(messages[0]?.content).not.toBe("You write worlds.");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("NAME: Aria");
    expect(user).toContain("FIELD: personality");
    expect(user).toContain("DIRECTION: Make her guarded.");
    expect(user).toContain("CONTEXT:\nDESCRIPTION:\nA floating city.");
    expect(user).toContain("CURRENT PERSONALITY:\nCalm.");

    // The same profile/model/sampling path as the description route.
    expect(bodies[0]?.body).toMatchObject({
      model: "writer-model",
      temperature: 0.9,
      max_tokens: 1234,
      stream: true,
    });
  });

  it("keeps the configured description prompt for the description field", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/characters/generate-field",
      jsonInit("POST", { field: "description", name: "Aria", current_text: "Old." }),
    );
    expect(res.status).toBe(200);
    const messages = (bodies[0]?.body.messages as { content: string }[]) ?? [];
    expect(messages[0]?.content).toBe("You write worlds.");
    expect(messages[1]?.content).toContain("CURRENT DESCRIPTION: Old.");
  });

  it("is a 400 for an unknown field", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/characters/generate-field",
      jsonInit("POST", { field: "backstory", name: "Aria" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request body" });
    expect(bodies).toHaveLength(0);
  });

  it("is a 400 when the stored config disables generation", async () => {
    const { app, repos, bodies } = setup();
    repos.settings.set("character_generation", { enabled: false });
    const res = await app.request(
      "/api/characters/generate-field",
      jsonInit("POST", { field: "scenario", name: "Aria" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Character generation is disabled" });
    expect(bodies).toHaveLength(0);
  });

  it("defaults tags/direction/text/context when omitted", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/characters/generate-field",
      jsonInit("POST", { field: "scenario", name: "Solo" }),
    );
    expect(res.status).toBe(200);
    const messages = (bodies[0]?.body.messages as { content: string }[] | undefined) ?? [];
    const user = messages[1]?.content ?? "";
    expect(user).toContain("TAGS: (none)");
    expect(user).toContain("DIRECTION: (none");
    expect(user).toContain("CONTEXT:\n(none)");
    expect(user).toContain("CURRENT SCENARIO:\n(none)");
  });
});

describe("POST /api/characters/generate-seed", () => {
  it("runs one batch pass with the seed prompt and returns only generated fields", async () => {
    const { app, bodies } = setup({
      respond: () =>
        sse(
          JSON.stringify({
            name: "Nerissa",
            description: "A drowned city.",
            alternate_greetings: ["The tide comes in.", "The bells are ringing."],
            creator_notes: "Not requested.",
          }),
        ),
    });
    const res = await app.request(
      "/api/characters/generate-seed",
      jsonInit("POST", {
        notes: "A drowned cathedral city.",
        name: "",
        generate: ["name", "description", "alternate_greetings"],
        directions: { description: "Lean into the tides." },
        alternate_count: 2,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fields: {
        name: "Nerissa",
        description: "A drowned city.",
        alternate_greetings: ["The tide comes in.", "The bells are ringing."],
      },
    });

    const messages = (bodies[0]?.body.messages as { role: string; content: string }[]) ?? [];
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("GENERATE");
    expect(messages[0]?.content).not.toBe("You write worlds.");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("CONCEPT NOTES:\nA drowned cathedral city.");
    expect(user).toContain("GENERATE: name, description, alternate_greetings");
    expect(user).toContain("DESCRIPTION: Lean into the tides.");
    expect(user).toContain("NAME: (none — follow the concept and the other fields)");
    expect(user).toContain("ALTERNATE GREETINGS COUNT: 2");

    expect(bodies[0]?.body).toMatchObject({
      model: "writer-model",
      temperature: 0.9,
      max_tokens: 4096,
      stream: true,
    });
  });

  it("caps alternate greetings at the requested count", async () => {
    const { app } = setup({
      respond: () =>
        sse(
          JSON.stringify({
            alternate_greetings: ["One opening.", "Two openings.", "Three openings."],
          }),
        ),
    });
    const res = await app.request(
      "/api/characters/generate-seed",
      jsonInit("POST", {
        generate: ["alternate_greetings"],
        alternate_count: 1,
        notes: "A drowned city.",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fields: { alternate_greetings: ["One opening."] },
    });
  });

  it("is a 400 when generate is empty", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/characters/generate-seed",
      jsonInit("POST", { generate: [], description: "Only context." }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request body" });
    expect(bodies).toHaveLength(0);
  });

  it("is a 400 when generation is disabled or no profile exists", async () => {
    const disabled = setup();
    disabled.repos.settings.set("character_generation", { enabled: false });
    const disabledRes = await disabled.app.request(
      "/api/characters/generate-seed",
      jsonInit("POST", { generate: ["name"] }),
    );
    expect(disabledRes.status).toBe(400);
    expect(await disabledRes.json()).toEqual({ error: "Character generation is disabled" });
    expect(disabled.bodies).toHaveLength(0);

    const noProfile = setup({ profiles: false });
    const noProfileRes = await noProfile.app.request(
      "/api/characters/generate-seed",
      jsonInit("POST", { generate: ["name"] }),
    );
    expect(noProfileRes.status).toBe(400);
    expect(await noProfileRes.json()).toEqual({ error: "No connection profile configured" });
    expect(noProfile.bodies).toHaveLength(0);
  });

  it("is a 502 when the model does not return the requested JSON", async () => {
    const { app } = setup({ respond: () => sse("not json at all") });
    const res = await app.request(
      "/api/characters/generate-seed",
      jsonInit("POST", { generate: ["description"], notes: "A city." }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "The model returned an invalid response. Try again.",
    });
  });
});

describe("POST /api/characters/generate-description", () => {
  it("generates a description through the configured profile", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/characters/generate-description",
      jsonInit("POST", { name: "Aria", tags: ["fantasy", "mage"], idea: "a floating city" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "A striking floating city." });

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
    expect(messages[0]).toEqual({ role: "system", content: "You write worlds." });
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("NAME: Aria");
    expect(messages[1]?.content).toContain("TAGS: fantasy, mage");
    expect(messages[1]?.content).toContain("IDEA: a floating city");
  });

  it("is a 400 when name is missing", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/characters/generate-description",
      jsonInit("POST", { tags: ["fantasy"] }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request body" });
    // The body was rejected before any upstream call.
    expect(bodies).toHaveLength(0);
  });

  it("is a 400 when the stored config disables the feature", async () => {
    const { app, repos, bodies } = setup();
    repos.settings.set("character_generation", { enabled: false });
    const res = await app.request(
      "/api/characters/generate-description",
      jsonInit("POST", { name: "Aria" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Character description generation is disabled" });
    expect(bodies).toHaveLength(0);
  });

  it("is a 400 when no connection profile exists", async () => {
    const { app, bodies } = setup({ profiles: false });
    const res = await app.request(
      "/api/characters/generate-description",
      jsonInit("POST", { name: "Aria" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No connection profile configured" });
    expect(bodies).toHaveLength(0);
  });

  it("maps an upstream failure through GatewayError to 502", async () => {
    const { app } = setup({ respond: () => errorSse("upstream boom") });
    const res = await app.request(
      "/api/characters/generate-description",
      jsonInit("POST", { name: "Aria" }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream boom" });
  });

  it("defaults tags/idea/current_description when omitted", async () => {
    const { app, bodies } = setup();
    const res = await app.request(
      "/api/characters/generate-description",
      jsonInit("POST", { name: "Solo" }),
    );
    expect(res.status).toBe(200);
    const messages = (bodies[0]?.body.messages as { content: string }[]) ?? [];
    expect(messages[1]?.content).toContain("TAGS: (none)");
    expect(messages[1]?.content).toContain("IDEA: (none provided — invent a fitting concept)");
    expect(messages[1]?.content).toContain("CURRENT DESCRIPTION: (none)");
  });
});
