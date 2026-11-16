/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  createRepositories,
  migrations,
  openDatabase,
  type Profile,
  runMigrations,
} from "@suvoj/core";
import { Hono } from "hono";
import { seedDefaultProfile } from "../db/seed";
import { createGateway } from "../gateway";
import { resolveActiveProfile, resolveSummarizerProfile } from "../profiles";
import type { RouteDeps } from "../routes-deps";
import { profilesRoutes } from "./profiles";

let db: Database;
let app: Hono;
let repos: ReturnType<typeof createRepositories>;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db, migrations);
  repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  app = new Hono();
  app.route("/", profilesRoutes(deps));
});

async function createProfile(body: unknown): Promise<Profile> {
  const res = await app.request("/api/profiles", jsonInit("POST", body));
  expect(res.status).toBe(201);
  return (await res.json()) as Profile;
}

describe("seedDefaultProfile", () => {
  it("creates the default profile with an empty model, endpoint, and sampling", () => {
    expect(seedDefaultProfile(db)).toBe("created");
    const profiles = repos.profiles.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: "Default",
      model: "",
      base_url: "",
      sampling: {},
      is_default: true,
    });
  });

  it("is idempotent — re-runs keep the existing default", () => {
    seedDefaultProfile(db);
    expect(seedDefaultProfile(db)).toBe("skipped");
    const profiles = repos.profiles.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.model).toBe("");
  });
});

describe("profile routes", () => {
  it("lists profiles with the active profile id", async () => {
    seedDefaultProfile(db);
    await createProfile({ name: "Extra" });
    const res = await app.request("/api/profiles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: Profile[]; active_profile_id: string | null };
    // The seeded default sorts first, then the created profile by creation.
    expect(body.profiles.map((profile) => profile.name)).toEqual(["Default", "Extra"]);
    expect(body.profiles[0]?.is_default).toBe(true);
    expect(body.active_profile_id).toBe(body.profiles[0]?.id ?? null);
  });

  it("creates a profile with defaulted model and sampling", async () => {
    const profile = await createProfile({ name: "Main" });
    expect(profile).toMatchObject({ name: "Main", model: "", sampling: {}, is_default: false });
  });

  it("patches partially and 404s on unknown ids", async () => {
    const profile = await createProfile({ name: "Main", model: "m1" });
    const res = await app.request(
      `/api/profiles/${profile.id}`,
      jsonInit("PATCH", { model: "m2" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Main", model: "m2" });

    const missing = await app.request("/api/profiles/missing", jsonInit("PATCH", { name: "X" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "profile not found" });
  });

  it("ignores is_default on create and patch (seeding manages it)", async () => {
    const created = await createProfile({ name: "Main", is_default: true });
    expect(created.is_default).toBe(false);

    const res = await app.request(
      `/api/profiles/${created.id}`,
      jsonInit("PATCH", { name: "N2", is_default: true }),
    );
    expect(res.status).toBe(200);
    const patched = (await res.json()) as Profile;
    expect(patched.is_default).toBe(false);
  });

  it("rejects deleting the default profile and the last remaining profile", async () => {
    seedDefaultProfile(db);
    const def = repos.profiles.list()[0];

    const forbidden = await app.request(`/api/profiles/${def?.id}`, { method: "DELETE" });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "the default profile cannot be deleted" });

    // A lone non-default profile (no default seeded) cannot be deleted either.
    const db2 = openDatabase(":memory:");
    runMigrations(db2, migrations);
    const repos2 = createRepositories(db2);
    const deps2: RouteDeps = { repos: repos2, gateway: createGateway({ repos: repos2 }) };
    const app2 = new Hono();
    app2.route("/", profilesRoutes(deps2));
    const lone = repos2.profiles.create({ name: "Lone" });
    const last = await app2.request(`/api/profiles/${lone.id}`, { method: "DELETE" });
    expect(last.status).toBe(400);
    expect(await last.json()).toEqual({ error: "cannot delete the last remaining profile" });
    db2.close();
  });

  it("deletes a non-default profile when others remain", async () => {
    seedDefaultProfile(db);
    const extra = await createProfile({ name: "Extra" });
    const res = await app.request(`/api/profiles/${extra.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(repos.profiles.get(extra.id)).toBe(null);

    const missing = await app.request("/api/profiles/missing", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });

  it("clears the stored active reference when the active profile is deleted", async () => {
    seedDefaultProfile(db);
    const def = repos.profiles.list()[0];
    const active = await createProfile({ name: "Active" });
    repos.settings.set("active_connection_profile_id", active.id);

    const res = await app.request(`/api/profiles/${active.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    // The handler cleared the dangling reference; resolution would
    // self-heal to the default either way.
    expect(repos.settings.get("active_connection_profile_id")).toBe(null);
    expect(resolveActiveProfile(repos)?.id).toBe(def?.id);
  });

  it("leaves the stored active id alone when a non-active profile is deleted", async () => {
    seedDefaultProfile(db);
    const active = await createProfile({ name: "Active" });
    const bystander = await createProfile({ name: "Bystander" });
    repos.settings.set("active_connection_profile_id", active.id);

    const res = await app.request(`/api/profiles/${bystander.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(repos.settings.get("active_connection_profile_id")).toBe(active.id);
  });

  it("switches the active profile and 404s on unknown ids", async () => {
    seedDefaultProfile(db);
    const extra = await createProfile({ name: "Extra" });

    const res = await app.request("/api/profiles/active", jsonInit("PUT", { id: extra.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, active_profile_id: extra.id });
    expect(resolveActiveProfile(repos)?.id).toBe(extra.id);

    const listed = (await (await app.request("/api/profiles")).json()) as {
      active_profile_id: string | null;
    };
    expect(listed.active_profile_id).toBe(extra.id);

    const missing = await app.request("/api/profiles/active", jsonInit("PUT", { id: "nope" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "profile not found" });
  });

  it("falls back to the default profile when the stored active id is stale", async () => {
    seedDefaultProfile(db);
    const def = repos.profiles.list()[0];
    repos.settings.set("active_connection_profile_id", "deleted-profile");
    expect(resolveActiveProfile(repos)?.id).toBe(def?.id);
  });

  it("resolves null when no profiles exist", () => {
    expect(resolveActiveProfile(repos)).toBe(null);
  });
});

describe("profile endpoint fields", () => {
  it("accepts base_url and api_key on create, echoing base_url + has_api_key only", async () => {
    const res = await app.request(
      "/api/profiles",
      jsonInit("POST", {
        name: "Custom",
        model: "m1",
        base_url: "https://llm.example.com/v1",
        api_key: "sk-secret",
      }),
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    // The plaintext key must never ride on the read shape.
    expect(text).not.toContain("sk-secret");
    const profile = JSON.parse(text) as Profile & { api_key?: unknown };
    expect(profile).toMatchObject({
      name: "Custom",
      base_url: "https://llm.example.com/v1",
      has_api_key: true,
    });
    expect(profile.api_key).toBeUndefined();
  });

  it("rejects a non-URL base_url on create and patch", async () => {
    const create = await app.request(
      "/api/profiles",
      jsonInit("POST", { name: "Bad", base_url: "not-a-url" }),
    );
    expect(create.status).toBe(400);
    expect(await create.json()).toMatchObject({ error: "Invalid request body" });

    const profile = await createProfile({ name: "Main" });
    const patch = await app.request(
      `/api/profiles/${profile.id}`,
      jsonInit("PATCH", { base_url: "ftp://nope" }),
    );
    expect(patch.status).toBe(400);
  });

  it("patches base_url; absent api_key keeps the stored key and null clears it", async () => {
    const profile = await createProfile({ name: "Main", api_key: "sk-keep" });
    expect(profile.has_api_key).toBe(true);

    // Absent api_key keeps the existing secret while base_url changes.
    const named = await app.request(
      `/api/profiles/${profile.id}`,
      jsonInit("PATCH", { base_url: "https://other.example.com", name: "Renamed" }),
    );
    expect(named.status).toBe(200);
    const kept = (await named.json()) as Profile;
    expect(kept).toMatchObject({
      name: "Renamed",
      base_url: "https://other.example.com",
      has_api_key: true,
    });

    // null clears it; the read shape reports the flag, never the value.
    const cleared = await app.request(
      `/api/profiles/${profile.id}`,
      jsonInit("PATCH", { api_key: null }),
    );
    expect(cleared.status).toBe(200);
    const text = await cleared.text();
    expect(JSON.parse(text)).toMatchObject({ has_api_key: false });
    expect(text).not.toContain("sk-keep");
  });

  it("lists models from the profile's own endpoint with its key as Bearer", async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = Object.assign(
      async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push({
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return Response.json({ data: [{ id: "model-a", context_window: 4096 }] });
      },
      { preconnect: () => {} },
    );
    const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
    const modelApp = new Hono();
    modelApp.route("/", profilesRoutes(deps));

    const profile = await createProfile({
      name: "Custom",
      base_url: "https://llm.example.com",
      api_key: "sk-custom",
    });
    const res = await modelApp.request(`/api/profiles/${profile.id}/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [{ id: "model-a", context_length: 4096 }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://llm.example.com/v1/models");
    expect(requests[0]?.headers.Authorization).toBe("Bearer sk-custom");

    const missing = await modelApp.request("/api/profiles/missing/models");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "profile not found" });
  });
});

describe("resolveSummarizerProfile", () => {
  it("prefers the given profile_id when it matches a live profile", () => {
    seedDefaultProfile(db);
    const def = repos.profiles.list()[0];
    const extra = repos.profiles.create({ name: "Extra", model: "m2" });
    expect(resolveSummarizerProfile(repos, extra.id)?.id).toBe(extra.id);
    expect(def?.id).not.toBe(extra.id);
  });

  it("falls back to the default profile when the id is absent or unknown", () => {
    seedDefaultProfile(db);
    const def = repos.profiles.list()[0];
    repos.profiles.create({ name: "Extra", model: "m2" });
    expect(resolveSummarizerProfile(repos)?.id).toBe(def?.id);
    expect(resolveSummarizerProfile(repos, "deleted-profile")?.id).toBe(def?.id);
  });

  it("ignores the active profile setting", () => {
    seedDefaultProfile(db);
    const def = repos.profiles.list()[0];
    const active = repos.profiles.create({ name: "Active", model: "m2" });
    repos.settings.set("active_connection_profile_id", active.id);
    // The active chat profile never speaks for the summarizer.
    expect(resolveSummarizerProfile(repos)?.id).toBe(def?.id);
    expect(resolveSummarizerProfile(repos, active.id)?.id).toBe(active.id);
  });

  it("resolves null when no profiles exist", () => {
    expect(resolveSummarizerProfile(repos)).toBe(null);
    expect(resolveSummarizerProfile(repos, "gone")).toBe(null);
  });
});
