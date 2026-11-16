/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  createRepositories,
  DEFAULT_CHARACTER_GENERATION_PROMPT,
  DEFAULT_LOREBOOK_GENERATION_PROMPT,
  migrations,
  openDatabase,
  runMigrations,
  tracker,
} from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { settingsRoutes } from "./settings";

/** Captured gateway request, asserted by the /api/models tests. */
let fetched: { url: string; auth: string } | null = null;

/** Stand-in fetch (with Bun's `preconnect` member) serving canned models. */
const fetchImpl = Object.assign(
  async (input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response> => {
    fetched = { url: String(input), auth: new Headers(init?.headers).get("Authorization") ?? "" };
    return Response.json({
      data: [{ id: "m1", name: "Model One", context_length: 8192 }, { no_id: true }, { id: "m2" }],
    });
  },
  { preconnect: () => {} },
);

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  return { app: new Hono().route("/", settingsRoutes(deps)), repos };
}

const jsonHeaders = { "Content-Type": "application/json" };

async function put(app: Hono, body: string): Promise<Response> {
  return app.request("/api/settings", { method: "PUT", body, headers: jsonHeaders });
}

describe("GET /api/settings", () => {
  it("returns null for every unset key (structured keys resolve to their full defaults)", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      theme: null,
      layout: null,
      appearance: null,
      message_formatting: null,
      reasoning: null,
      timestamps: null,
      chat_history: null,
      tracker_indicator: null,
      summarization_indicator: null,
      streaming_indicator: null,
      writing_style: null,
      memory_strategy: null,
      memory_config: null,
      default_preset_id: null,
      last_selected_chat_id: null,
      // The tracker config is a structured key: with nothing stored,
      // GET still returns the parsed default config (a complete object the
      // settings form can render as-is).
      tracker_config: {
        enabled: false,
        mechanism: "suvoj-tracker",
        auto_mode: "after_reply",
        profile_id: "",
        system_prompt: tracker.DEFAULT_TRACKER_SYSTEM_PROMPT,
        include_last_messages: 6,
        include_last_trackers: 2,
        keep_last: 2,
        max_response_tokens: 8192,
        invisible: false,
        injection: { include_last: 1, role: "system", format: "plain", header: "Tracker:" },
        schema_presets: {},
        active_schema_key: "default",
      },
      // Same for the character-generation config.
      character_generation: {
        enabled: true,
        profile_id: "",
        system_prompt: DEFAULT_CHARACTER_GENERATION_PROMPT,
        max_response_tokens: 2048,
      },
      // …and for the lorebook-generation config.
      lorebook_generation: {
        enabled: true,
        profile_id: "",
        system_prompt: DEFAULT_LOREBOOK_GENERATION_PROMPT,
        max_response_tokens: 2048,
      },
    });
  });
});

describe("PUT /api/settings", () => {
  it("writes the supplied keys and returns the updated snapshot", async () => {
    const { app } = makeApp();
    const res = await put(
      app,
      JSON.stringify({
        theme: { mode: "dark" },
        last_selected_chat_id: "chat-1",
        memory_config: { summaries: { chunk_size: 4 } },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.theme).toEqual({ mode: "dark" });
    expect(body.last_selected_chat_id).toBe("chat-1");
    expect(body.memory_config).toEqual({ summaries: { chunk_size: 4 } });
    expect(body.layout).toBeNull();
    const after = await app.request("/api/settings");
    expect((await after.json()).last_selected_chat_id).toBe("chat-1");
  });

  it("clears a key when its value is null", async () => {
    const { app } = makeApp();
    await put(app, JSON.stringify({ last_selected_chat_id: "chat-1" }));
    const res = await put(app, JSON.stringify({ last_selected_chat_id: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).last_selected_chat_id).toBeNull();
  });

  it("round-trips the appearance object", async () => {
    const { app } = makeApp();
    const appearance = { accent: "#8f8af6", motion: "off", surfaces: "glass" };
    const res = await put(app, JSON.stringify({ appearance }));
    expect(res.status).toBe(200);
    expect((await res.json()).appearance).toEqual(appearance);
    const after = await app.request("/api/settings");
    expect((await after.json()).appearance).toEqual(appearance);
  });

  it("clears the appearance object when its value is null", async () => {
    const { app } = makeApp();
    await put(app, JSON.stringify({ appearance: { accent: "#8f8af6" } }));
    const res = await put(app, JSON.stringify({ appearance: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).appearance).toBeNull();
    const after = await app.request("/api/settings");
    expect((await after.json()).appearance).toBeNull();
  });

  it("round-trips the tracker_indicator object", async () => {
    const { app, repos } = makeApp();
    const trackerIndicator = { show: false, label: "x", dot: false };
    const res = await put(app, JSON.stringify({ tracker_indicator: trackerIndicator }));
    expect(res.status).toBe(200);
    expect((await res.json()).tracker_indicator).toEqual(trackerIndicator);
    const after = await app.request("/api/settings");
    expect((await after.json()).tracker_indicator).toEqual(trackerIndicator);
    expect(repos.settings.get("tracker_indicator")).toEqual(trackerIndicator);
  });

  it("round-trips the summarization_indicator object", async () => {
    const { app, repos } = makeApp();
    const summarizationIndicator = { show: true, label: "Summarizing…", dot: true };
    const res = await put(app, JSON.stringify({ summarization_indicator: summarizationIndicator }));
    expect(res.status).toBe(200);
    expect((await res.json()).summarization_indicator).toEqual(summarizationIndicator);
    const after = await app.request("/api/settings");
    expect((await after.json()).summarization_indicator).toEqual(summarizationIndicator);
    expect(repos.settings.get("summarization_indicator")).toEqual(summarizationIndicator);
  });

  it("round-trips the streaming_indicator object", async () => {
    const { app, repos } = makeApp();
    const streamingIndicator = { show: true, label: "Streaming…", dot: true };
    const res = await put(app, JSON.stringify({ streaming_indicator: streamingIndicator }));
    expect(res.status).toBe(200);
    expect((await res.json()).streaming_indicator).toEqual(streamingIndicator);
    const after = await app.request("/api/settings");
    expect((await after.json()).streaming_indicator).toEqual(streamingIndicator);
    expect(repos.settings.get("streaming_indicator")).toEqual(streamingIndicator);
  });

  it("round-trips the writing_style string", async () => {
    const { app, repos } = makeApp();
    const res = await put(app, JSON.stringify({ writing_style: "typewriter" }));
    expect(res.status).toBe(200);
    expect((await res.json()).writing_style).toBe("typewriter");
    const after = await app.request("/api/settings");
    expect((await after.json()).writing_style).toBe("typewriter");
    expect(repos.settings.get("writing_style")).toBe("typewriter");
  });

  it("rejects a non-object body with 400", async () => {
    const { app } = makeApp();
    const res = await put(app, JSON.stringify([1, 2]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body", details: expect.any(Array) });
  });

  it("rejects an unparseable JSON body with 400", async () => {
    const { app } = makeApp();
    const res = await put(app, "not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });
});

describe("PUT /api/settings (tracker_config)", () => {
  it("round-trips a valid config, storing it defaults-filled", async () => {
    const { app, repos } = makeApp();
    const res = await put(
      app,
      JSON.stringify({ tracker_config: { enabled: false, keep_last: 2 } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracker_config: Record<string, unknown> };
    // Partial input → complete stored config (core's schema fills defaults):
    expect(body.tracker_config).toMatchObject({ enabled: false, keep_last: 2 });
    expect(body.tracker_config.auto_mode).toBe("after_reply");
    expect(body.tracker_config.injection).toEqual({
      include_last: 1,
      role: "system",
      format: "plain",
      header: "Tracker:",
    });
    // GET returns the stored value back:
    const after = await app.request("/api/settings");
    expect(((await after.json()) as { tracker_config: unknown }).tracker_config).toEqual(
      body.tracker_config,
    );
    expect(repos.settings.get("tracker_config")).toEqual(body.tracker_config);
  });

  it("rejects a non-object tracker_config with 400 and details", async () => {
    const { app, repos } = makeApp();
    const res = await put(app, JSON.stringify({ tracker_config: "garbage" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.error).toBe("Invalid tracker_config");
    expect(Array.isArray(body.details)).toBe(true);
    // Nothing was stored:
    expect(repos.settings.get("tracker_config")).toBeNull();
  });

  it("clearing with null restores the full default config on the next GET", async () => {
    const { app } = makeApp();
    await put(app, JSON.stringify({ tracker_config: { enabled: false } }));
    const res = await put(app, JSON.stringify({ tracker_config: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracker_config: { enabled: boolean } };
    expect(body.tracker_config.enabled).toBe(false); // the schema default again
  });
});

describe("PUT /api/settings (character_generation)", () => {
  it("round-trips a valid config, storing it defaults-filled", async () => {
    const { app, repos } = makeApp();
    const res = await put(
      app,
      JSON.stringify({ character_generation: { max_response_tokens: 4096, profile_id: "p1" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { character_generation: Record<string, unknown> };
    expect(body.character_generation).toMatchObject({
      profile_id: "p1",
      max_response_tokens: 4096,
    });
    // The system prompt default fills in on write:
    expect(body.character_generation.system_prompt).toBe(DEFAULT_CHARACTER_GENERATION_PROMPT);
    // GET returns the stored value back:
    const after = await app.request("/api/settings");
    expect(
      ((await after.json()) as { character_generation: unknown }).character_generation,
    ).toEqual(body.character_generation);
    expect(repos.settings.get("character_generation")).toEqual(body.character_generation);
  });

  it("rejects a non-object character_generation with 400 and details", async () => {
    const { app, repos } = makeApp();
    const res = await put(app, JSON.stringify({ character_generation: "garbage" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.error).toBe("Invalid character_generation");
    expect(Array.isArray(body.details)).toBe(true);
    // Nothing was stored:
    expect(repos.settings.get("character_generation")).toBeNull();
  });

  it("clearing with null restores the full default config on the next GET", async () => {
    const { app } = makeApp();
    await put(app, JSON.stringify({ character_generation: { max_response_tokens: 1 } }));
    const res = await put(app, JSON.stringify({ character_generation: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { character_generation: { max_response_tokens: number } };
    expect(body.character_generation.max_response_tokens).toBe(2048); // the schema default again
  });
});

describe("PUT /api/settings (lorebook_generation)", () => {
  it("round-trips a valid config, storing it defaults-filled", async () => {
    const { app, repos } = makeApp();
    const res = await put(
      app,
      JSON.stringify({ lorebook_generation: { max_response_tokens: 4096, profile_id: "p1" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lorebook_generation: Record<string, unknown> };
    expect(body.lorebook_generation).toMatchObject({
      profile_id: "p1",
      max_response_tokens: 4096,
    });
    // The system prompt default fills in on write:
    expect(body.lorebook_generation.system_prompt).toBe(DEFAULT_LOREBOOK_GENERATION_PROMPT);
    // GET returns the stored value back:
    const after = await app.request("/api/settings");
    expect(((await after.json()) as { lorebook_generation: unknown }).lorebook_generation).toEqual(
      body.lorebook_generation,
    );
    expect(repos.settings.get("lorebook_generation")).toEqual(body.lorebook_generation);
  });

  it("rejects a non-object lorebook_generation with 400 and details", async () => {
    const { app, repos } = makeApp();
    const res = await put(app, JSON.stringify({ lorebook_generation: "garbage" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.error).toBe("Invalid lorebook_generation");
    expect(Array.isArray(body.details)).toBe(true);
    // Nothing was stored:
    expect(repos.settings.get("lorebook_generation")).toBeNull();
  });

  it("clearing with null restores the full default config on the next GET", async () => {
    const { app } = makeApp();
    await put(app, JSON.stringify({ lorebook_generation: { max_response_tokens: 1 } }));
    const res = await put(app, JSON.stringify({ lorebook_generation: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lorebook_generation: { max_response_tokens: number } };
    expect(body.lorebook_generation.max_response_tokens).toBe(2048); // the schema default again
  });
});

describe("GET /api/models", () => {
  it("returns the gateway models, authorized by the active profile's key", async () => {
    const { app, repos } = makeApp();
    const profile = repos.profiles.create({
      name: "Test",
      base_url: "https://api.example",
      api_key: "sk-test",
    });
    repos.settings.set("active_connection_profile_id", profile.id);
    const res = await app.request("/api/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [{ id: "m1", name: "Model One", context_length: 8192 }, { id: "m2" }],
    });
    expect(fetched?.url).toBe("https://api.example/v1/models");
    expect(fetched?.auth).toBe("Bearer sk-test");
  });

  it("fetches from the active profile's own base url", async () => {
    const { app, repos } = makeApp();
    const profile = repos.profiles.create({ name: "Custom", base_url: "https://custom.example" });
    repos.settings.set("active_connection_profile_id", profile.id);
    const res = await app.request("/api/models");
    expect(res.status).toBe(200);
    expect(fetched?.url).toBe("https://custom.example/v1/models");
    expect(fetched?.auth).toBe("");
  });
});
