/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Preset } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { PluginHost } from "../plugins/host";
import type { RouteDeps } from "../routes-deps";
import { presetsRoutes } from "./presets";

let app: Hono;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = {
    repos,
    gateway: createGateway({ repos }),
  };
  app = new Hono();
  app.route("/", presetsRoutes(deps));
});

async function createPreset(body: unknown): Promise<Preset> {
  const res = await app.request("/api/presets", jsonInit("POST", body));
  expect(res.status).toBe(201);
  return (await res.json()) as Preset;
}

describe("preset CRUD (native v2 format)", () => {
  it("creates a preset with prompts and settings, lists and gets it", async () => {
    const preset = await createPreset({
      name: "Native",
      description: "a test preset",
      prompts: [{ id: "main", name: "Main prompt", marker: "main", enabled: true }],
      settings: { scan_depth: 4 },
    });
    expect(preset).toMatchObject({
      name: "Native",
      description: "a test preset",
      prompts: [{ id: "main", marker: "main" }],
      settings: { scan_depth: 4 },
    });

    const list = (await (await app.request("/api/presets")).json()) as Preset[];
    expect(list.map((row) => row.id)).toEqual([preset.id]);

    const got = (await (await app.request(`/api/presets/${preset.id}`)).json()) as Preset;
    expect(got).toMatchObject({ id: preset.id, name: "Native" });
  });

  it("defaults description, prompts and settings on create", async () => {
    const preset = await createPreset({ name: "Bare" });
    expect(preset).toMatchObject({
      name: "Bare",
      description: "",
      prompts: [],
      settings: {},
    });
  });

  it("patches partially and 404s on unknown ids", async () => {
    const preset = await createPreset({
      name: "Native",
      description: "d",
      settings: { scan_depth: 2 },
      prompts: [{ id: "main", marker: "main" }],
    });
    const res = await app.request(
      `/api/presets/${preset.id}`,
      jsonInit("PATCH", { name: "N2", description: "d2", settings: { scan_depth: 9 } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: preset.id,
      name: "N2",
      description: "d2",
      settings: { scan_depth: 9 },
      // Absent fields are left untouched.
      prompts: [{ id: "main", marker: "main" }],
    });

    const missing = await app.request("/api/presets/missing", jsonInit("PATCH", { name: "X" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "preset not found" });
  });

  it("deletes a preset and then it is gone", async () => {
    const preset = await createPreset({ name: "Native" });
    const res = await app.request(`/api/presets/${preset.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await app.request(`/api/presets/${preset.id}`)).status).toBe(404);
  });

  it("no longer exposes the SillyTavern import route", async () => {
    const res = await app.request("/api/presets/import", jsonInit("POST", { raw: "{}" }));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/presets/:id/controls", () => {
  /** A preset declaring one select control (pov: first | third). */
  async function createWithControls(): Promise<Preset> {
    return createPreset({
      name: "POV",
      prompts: [
        { id: "main", marker: "main" },
        { id: "pov-first", name: "First" },
        { id: "pov-third", name: "Third", enabled: false },
      ],
      settings: {
        scan_depth: 7,
        memory: { strategy: "trim", config: {} },
        controls: [
          {
            id: "pov",
            label: "Point of view",
            options: [
              { id: "first", label: "First", prompts: ["pov-first"] },
              { id: "third", label: "Third", prompts: ["pov-third"] },
            ],
          },
        ],
      },
    });
  }

  it("stores the chosen values, merges over existing ones, and flips the governed rows", async () => {
    const preset = await createWithControls();
    const res = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: "third" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { control_values: unknown; prompts: Preset["prompts"] };
    expect(body.control_values).toEqual({ pov: "third" });
    // The response carries the UPDATED stored rows, so the Presets view's
    // cached row (which the editor opens from) cannot render stale switches.
    const flags = Object.fromEntries(
      (body.prompts as Array<{ id: string; enabled?: boolean }>)
        .filter((row) => row.id.startsWith("pov-"))
        .map((row) => [row.id, row.enabled]),
    );
    expect(flags).toEqual({ "pov-first": false, "pov-third": true });

    const got = (await (await app.request(`/api/presets/${preset.id}`)).json()) as Preset;
    expect(got.settings.control_values).toEqual({ pov: "third" });
    // Every other settings key survives the write.
    expect(got.settings.scan_depth).toBe(7);
    expect(got.settings.memory).toEqual({ strategy: "trim", config: {} });
    // The choice is MATERIALIZED onto the governed rows: the follow-up GET
    // (the same row the editor renders) agrees with generation.
    expect(got.prompts.find((row) => row.id === "pov-first")?.enabled).toBe(false);
    expect(got.prompts.find((row) => row.id === "pov-third")?.enabled).toBe(true);
    // Rows no option names keep their stored flags.
    expect(got.prompts.find((row) => row.id === "main")?.enabled ?? true).toBe(true);
    expect(got.prompts.map((row) => row.id)).toEqual(["main", "pov-first", "pov-third"]);
  });

  it("flips exactly the governed rows, keeping unrelated rows and settings", async () => {
    // The user-reported case, with an unrelated enabled row and an unrelated
    // settings key that must both survive the write.
    const preset = await createPreset({
      name: "POV plus",
      prompts: [
        { id: "main", marker: "main" },
        { id: "unrelated", name: "Keep me", enabled: true },
        { id: "pov-first", name: "First" },
        { id: "pov-third", name: "Third", enabled: true },
      ],
      settings: {
        scan_depth: 7,
        controls: [
          {
            id: "pov",
            label: "Point of view",
            options: [
              { id: "first", label: "First", prompts: ["pov-first"] },
              { id: "third", label: "Third", prompts: ["pov-third"] },
            ],
          },
        ],
        control_values: { pov: "third" },
      },
    });
    const res = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: "first" } }),
    );
    expect(res.status).toBe(200);

    const got = (await (await app.request(`/api/presets/${preset.id}`)).json()) as Preset;
    // Exactly one POV row is enabled, and it is the chosen one.
    expect(
      (got.prompts as Array<{ id: string; enabled?: boolean }>)
        .filter((row) => row.id.startsWith("pov-") && row.enabled)
        .map((row) => row.id),
    ).toEqual(["pov-first"]);
    expect(got.prompts.find((row) => row.id === "unrelated")?.enabled).toBe(true);
    expect(got.settings.control_values).toEqual({ pov: "first" });
    expect(got.settings.scan_depth).toBe(7);
  });

  it("merges a second write instead of replacing the map", async () => {
    const preset = await createWithControls();
    await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: "first" } }),
    );
    const res = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: "third" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { control_values: unknown; prompts: Preset["prompts"] };
    expect(body.control_values).toEqual({ pov: "third" });
    expect(body.prompts.find((row) => row.id === "pov-first")?.enabled).toBe(false);
    expect(body.prompts.find((row) => row.id === "pov-third")?.enabled).toBe(true);
  });

  it("404s on an unknown preset", async () => {
    const res = await app.request("/api/presets/missing/controls", jsonInit("PUT", { values: {} }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "preset not found" });
  });

  it("400s on an unknown control, naming the key", async () => {
    const preset = await createWithControls();
    const res = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { tone: "formal" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Unknown control "tone"' });
  });

  it("400s on an unknown option, naming the key", async () => {
    const preset = await createWithControls();
    const res = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: "fourth" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'Unknown option "fourth" for control "pov"',
    });
  });

  it("400s when values is not an object of strings", async () => {
    const preset = await createWithControls();
    const notObject = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: ["pov"] }),
    );
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toMatchObject({ error: "Invalid request body" });

    const notStrings = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: 3 } }),
    );
    expect(notStrings.status).toBe(400);
  });

  it("400s on a plugin-scoped key the preset does not declare", async () => {
    // Phase 3 adds plugin-contributed controls; until a preset declares that
    // exact id, the key is rejected like any other unknown control.
    const preset = await createWithControls();
    const res = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { "plugin:example-plugin:pov": "first" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'Unknown control "plugin:example-plugin:pov"',
    });
  });

  it("never validates against a control the engine would drop", async () => {
    const preset = await createPreset({
      name: "Broken",
      // One option only → parseControls drops the control, so no value sticks.
      settings: { controls: [{ id: "pov", options: [{ id: "first" }] }] },
    });
    const res = await app.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: "first" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Unknown control "pov"' });
  });

  it("guards a non-object settings column instead of spreading index keys", async () => {
    // A hand-edited/legacy row can hold a JSON string (or array) in the
    // `settings` column — `parseJsonOr` does not object-check it. Spreading
    // that used to produce index-keyed junk ("oops" → {"0":"o","1":"o",…})
    // and silently replace everything the user had.
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    const localApp = new Hono();
    localApp.route("/", presetsRoutes({ repos, gateway: createGateway({ repos }) }));
    const preset = (await (
      await localApp.request("/api/presets", jsonInit("POST", { name: "Corrupt" }))
    ).json()) as Preset;
    db.run("UPDATE presets SET settings = ? WHERE id = ?", ['"oops"', preset.id]);

    // `toPreset` normalizes the non-object column (defense in depth for the
    // web editor, which spreads the same value client-side).
    expect(repos.presets.get(preset.id)?.settings).toEqual({});

    const res = await localApp.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: {} }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ control_values: {}, prompts: [] });
    // No index-keyed junk leaked into the stored settings.
    expect(repos.presets.get(preset.id)?.settings).toEqual({ control_values: {} });
  });

  it("notifies the plugin host of a successful control change", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    const seen: Array<Record<string, unknown>> = [];
    // The host surface this route touches is the notification. A minimal
    // double keeps the test about the route's contract (fire once per changed
    // bare key, after the write) without a plugin folder.
    const plugins = {
      mergedControlValues: () => ({ pov: "third person" }),
      controlChanged: (event: Record<string, unknown>) => {
        seen.push(event);
      },
    } as unknown as PluginHost;
    const localApp = new Hono();
    localApp.route(
      "/",
      presetsRoutes({
        repos,
        gateway: createGateway({ repos }),
        plugins,
      }),
    );
    const preset = (await (
      await localApp.request(
        "/api/presets",
        jsonInit("POST", {
          name: "POV",
          settings: {
            controls: [
              {
                id: "pov",
                options: [
                  { id: "first", label: "First" },
                  { id: "third", label: "Third" },
                ],
              },
            ],
          },
        }),
      )
    ).json()) as Preset;

    const res = await localApp.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: "third" } }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        source: "preset",
        ownerId: preset.id,
        controlId: "pov",
        value: "third",
        values: { pov: "third person" },
      },
    ]);

    // A failed write notifies nobody.
    seen.length = 0;
    const bad = await localApp.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { ghost: "x" } }),
    );
    expect(bad.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("a throwing host notification never fails a successful write", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    const plugins = {
      mergedControlValues: () => ({}),
      controlChanged: () => {
        throw new Error("notify boom");
      },
    } as unknown as PluginHost;
    const localApp = new Hono();
    localApp.route(
      "/",
      presetsRoutes({
        repos,
        gateway: createGateway({ repos }),
        plugins,
      }),
    );
    const preset = (await (
      await localApp.request(
        "/api/presets",
        jsonInit("POST", {
          name: "POV",
          settings: {
            controls: [
              {
                id: "pov",
                options: [
                  { id: "first", label: "First" },
                  { id: "third", label: "Third" },
                ],
              },
            ],
          },
        }),
      )
    ).json()) as Preset;

    const res = await localApp.request(
      `/api/presets/${preset.id}/controls`,
      jsonInit("PUT", { values: { pov: "third" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ control_values: { pov: "third" }, prompts: [] });
    // The write persisted despite the notification throwing.
    expect(repos.presets.get(preset.id)?.settings.control_values).toEqual({ pov: "third" });
  });
});
