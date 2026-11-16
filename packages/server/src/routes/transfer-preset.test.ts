/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { Repositories } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { transferRoutes } from "./transfer";

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  return { app: new Hono().route("/", transferRoutes(deps)), repos };
}

/** A preset with two ordered, explicitly-id'd prompts and engine settings. */
function seedPreset(repos: Repositories) {
  return repos.presets.create({
    name: "My Preset",
    prompts: [
      { id: "main", name: "Main", content: "You are helpful." },
      { id: "chatHistory", name: "Chat history", marker: "chatHistory" },
    ],
    settings: { scan_depth: 5 },
  });
}

/** Minimal SillyTavern chat-completion preset — no disk fixture needed. */
function stFixture() {
  return {
    prompts: [{ identifier: "main", name: "Main", marker: true, content: "hi" }],
    prompt_order: [{ order: [{ identifier: "main", enabled: true }] }],
    new_chat_prompt: "[Start a new Chat]",
  };
}

describe("GET /api/export/preset/:id", () => {
  it("exports the native document without identity fields", async () => {
    const { app, repos } = makeApp();
    const preset = seedPreset(repos);
    const res = await app.request(`/api/export/preset/${preset.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="My_Preset.json"');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.format).toBe("suvoj.preset");
    expect(body.version).toBe(1);
    expect(body.name).toBe("My Preset");
    expect((body.prompts as { id: string }[]).map((prompt) => prompt.id)).toEqual([
      "main",
      "chatHistory",
    ]);
    expect(body.settings).toEqual({ scan_depth: 5 });
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("created_at");
    expect(body).not.toHaveProperty("updated_at");
  });

  it("returns 404 for an unknown preset", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/export/preset/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "preset nope not found" });
  });
});

describe("POST /api/import/preset", () => {
  it("imports a native document", async () => {
    const { app, repos } = makeApp();
    const raw = JSON.stringify({
      format: "suvoj.preset",
      version: 1,
      name: "Imported",
      description: "",
      prompts: [{ id: "main", name: "Main" }],
      settings: {},
    });
    const res = await app.request("/api/import/preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      preset: { id: string; name: string };
      renamed: boolean;
      replaced: boolean;
      source: string;
    };
    expect(body.preset.name).toBe("Imported");
    expect(body.preset.id).toBeTruthy();
    expect(body.renamed).toBe(false);
    expect(body.replaced).toBe(false);
    expect(body.source).toBe("suvoj");
    expect(repos.presets.list().map((preset) => preset.name)).toEqual(["Imported"]);
  });

  it("honors the name override", async () => {
    const { app, repos } = makeApp();
    const raw = JSON.stringify({ name: "Original", prompts: [] });
    const res = await app.request("/api/import/preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw, name: "Custom" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { preset: { name: string } }).toMatchObject({
      preset: { name: "Custom" },
    });
    expect(repos.presets.list()[0]?.name).toBe("Custom");
  });

  it("returns 409 on a same-name conflict", async () => {
    const { app, repos } = makeApp();
    repos.presets.create({ name: "Imported", prompts: [], settings: {} });
    const raw = JSON.stringify({ name: "Imported", prompts: [] });
    const res = await app.request("/api/import/preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Imported");
    expect(repos.presets.list().filter((preset) => preset.name === "Imported")).toHaveLength(1);
  });

  it("renames on conflict and leaves the original untouched", async () => {
    const { app, repos } = makeApp();
    const original = repos.presets.create({ name: "Imported", prompts: [], settings: {} });
    const raw = JSON.stringify({ name: "Imported", prompts: [{ id: "main", name: "Main" }] });
    const res = await app.request("/api/import/preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw, onConflict: "rename" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      preset: { id: string; name: string };
      renamed: boolean;
      replaced: boolean;
    };
    expect(body.renamed).toBe(true);
    expect(body.replaced).toBe(false);
    expect(body.preset.name).toBe("Imported 2");
    expect(body.preset.id).not.toBe(original.id);
    expect(repos.presets.list()).toHaveLength(2);
    expect(repos.presets.get(original.id)?.prompts).toEqual([]);
  });

  it("replaces the same-name row in place", async () => {
    const { app, repos } = makeApp();
    const original = repos.presets.create({
      name: "Imported",
      prompts: [{ id: "main", name: "Main" }],
      settings: {},
    });
    const raw = JSON.stringify({ name: "Imported", prompts: [{ id: "jailbreak", name: "Post" }] });
    const res = await app.request("/api/import/preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw, onConflict: "replace" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      preset: { id: string };
      renamed: boolean;
      replaced: boolean;
    };
    expect(body.replaced).toBe(true);
    expect(body.renamed).toBe(false);
    expect(body.preset.id).toBe(original.id);
    expect(repos.presets.get(original.id)?.prompts.map((prompt) => prompt.id)).toEqual([
      "jailbreak",
    ]);
    expect(repos.presets.list()).toHaveLength(1);
  });

  it("imports a SillyTavern document", async () => {
    const { app, repos } = makeApp();
    const res = await app.request("/api/import/preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: JSON.stringify(stFixture()) }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { preset: { id: string }; source: string };
    expect(body.source).toBe("sillytavern");
    const stored = repos.presets.get(body.preset.id);
    expect(stored?.prompts[0]?.id).toBe("main");
    expect(stored?.prompts[0]?.marker).toBe("main");
  });

  it("rejects malformed bodies", async () => {
    const { app } = makeApp();
    const post = (body: unknown) =>
      app.request("/api/import/preset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await post({ raw: "not json" })).status).toBe(400);
    expect((await post({ raw: JSON.stringify([1, 2, 3]) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });
});
