/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, engine, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { regexRoutes } from "./regex";

const jsonHeaders = { "Content-Type": "application/json" };

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  return { app: new Hono().route("/", regexRoutes(deps)), repos };
}

/** A minimal valid rule with overridable fields. */
function rule(overrides: Partial<engine.RegexRule> = {}): engine.RegexRule {
  return {
    id: "r1",
    name: "Rule",
    find: "/foo/g",
    replace: "bar",
    placement: ["ai"],
    enabled: true,
    ...overrides,
  };
}

async function put(app: Hono, body: unknown): Promise<Response> {
  return app.request("/api/regex/rules", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

async function postImport(app: Hono, mode: string, body: unknown): Promise<Response> {
  return app.request(`/api/regex/rules/import?mode=${mode}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

describe("GET /api/regex/rules", () => {
  it("returns an empty list on a fresh db", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/regex/rules");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules: [] });
  });
});

describe("PUT /api/regex/rules", () => {
  it("stores the rules and round-trips them", async () => {
    const { app, repos } = makeApp();
    const rules = [rule({ id: "a" }), rule({ id: "b", find: "/z/i", replace: "" })];
    const res = await put(app, { rules });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules });
    expect(engine.getRegexRules(repos)).toEqual(rules);
    expect(await (await app.request("/api/regex/rules")).json()).toEqual({ rules });
  });

  it("accepts an empty array (deleting every rule must stick)", async () => {
    const { app, repos } = makeApp();
    const res = await put(app, { rules: [] });
    expect(res.status).toBe(200);
    expect(repos.settings.get(engine.REGEX_RULES_KEY)).toEqual([]);
  });

  it("rejects an uncompilable find with per-index details and stores nothing", async () => {
    const { app, repos } = makeApp();
    await put(app, { rules: [rule({ id: "good" })] });
    const res = await put(app, {
      rules: [rule({ id: "good" }), rule({ id: "bad", find: "/[/g" })],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid regex rule",
      details: [{ path: "rules.1.find", message: "invalid regex" }],
    });
    // All-or-nothing: the previously stored good set is untouched.
    expect(engine.getRegexRules(repos).map((entry) => entry.id)).toEqual(["good"]);
  });

  it("rejects duplicate rule ids and stores nothing", async () => {
    const { app, repos } = makeApp();
    const res = await put(app, {
      rules: [rule({ id: "same", name: "One" }), rule({ id: "same", name: "Two" })],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid regex rule",
      details: [{ path: "rules.1.id", message: "duplicate rule id" }],
    });
    expect(repos.settings.get(engine.REGEX_RULES_KEY)).toBeNull();
  });

  it("rejects an invalid body shape with 400", async () => {
    const { app } = makeApp();
    const res = await put(app, { rules: [{ id: "x" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.error).toBe("Invalid request body");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("rejects more than the rule cap with 400", async () => {
    const { app } = makeApp();
    const rules = Array.from({ length: engine.MAX_REGEX_RULES + 1 }, (_, index) =>
      rule({ id: `r${index}` }),
    );
    const res = await put(app, { rules });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/regex/rules/export", () => {
  it("downloads the native document as an attachment", async () => {
    const { app } = makeApp();
    const rules = [rule({ id: "a", name: "A" })];
    await put(app, { rules });
    const res = await app.request("/api/regex/rules/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="suvoj-regex.json"');
    expect(await res.json()).toEqual({ format: "suvoj.regex", version: 1, rules });
  });

  it("exports an empty document on a fresh db", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/regex/rules/export");
    expect(await res.json()).toEqual({ format: "suvoj.regex", version: 1, rules: [] });
  });
});

describe("POST /api/regex/rules/import", () => {
  it("replace swaps the stored set", async () => {
    const { app, repos } = makeApp();
    await put(app, { rules: [rule({ id: "old", name: "Old" })] });
    const res = await postImport(app, "replace", { rules: [rule({ id: "new", name: "New" })] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: engine.RegexRule[]; skipped: unknown[] };
    expect(body.rules.map((entry) => entry.id)).toEqual(["new"]);
    expect(body.skipped).toEqual([]);
    expect(engine.getRegexRules(repos).map((entry) => entry.id)).toEqual(["new"]);
  });

  it("append keeps stored rules and continues name suffixes against them", async () => {
    const { app, repos } = makeApp();
    // The seeded built-in name — the import repeats it.
    await put(app, { rules: engine.defaultRegexRules() });
    const res = await postImport(app, "append", {
      rules: [{ ...engine.defaultRegexRules()[0], id: "imported-1" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: engine.RegexRule[]; skipped: unknown[] };
    expect(body.rules.map((entry) => entry.name)).toEqual(["Quote Cleaner", "Quote Cleaner (2)"]);
    expect(engine.getRegexRules(repos).map((entry) => entry.name)).toEqual([
      "Quote Cleaner",
      "Quote Cleaner (2)",
    ]);
  });

  it("append advances past suffixed names already stored", async () => {
    const { app } = makeApp();
    const quoteCleaner = rule({ id: "built-in", name: "Quote Cleaner", find: "/[\u201c\u201d]/g" });
    await put(app, {
      rules: [quoteCleaner, { ...quoteCleaner, id: "existing-2", name: "Quote Cleaner (2)" }],
    });
    const res = await postImport(app, "append", {
      rules: [{ ...quoteCleaner, id: "imported" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: engine.RegexRule[] };
    // Core dedupes only within the imported set, so the "(3)" suffix is
    // unambiguously the route's stored-set pass.
    expect(body.rules.map((entry) => entry.name)).toEqual([
      "Quote Cleaner",
      "Quote Cleaner (2)",
      "Quote Cleaner (3)",
    ]);
  });

  it("append regenerates an imported id that collides with a stored one", async () => {
    const { app, repos } = makeApp();
    await put(app, { rules: [rule({ id: "same", name: "Stored", find: "/stored/g" })] });
    const res = await postImport(app, "append", {
      rules: [rule({ id: "same", name: "Imported", find: "/imported/g" })],
    });
    expect(res.status).toBe(200);
    const rules = engine.getRegexRules(repos);
    expect(rules).toHaveLength(2);
    // The stored rule survives verbatim and the imported one got a fresh id.
    expect(rules[0]).toMatchObject({ id: "same", name: "Stored", find: "/stored/g" });
    expect(rules[1]?.id).not.toBe("same");
    expect(rules[1]).toMatchObject({ name: "Imported", find: "/imported/g" });
  });

  it("reports skipped entries from core's parser", async () => {
    const { app } = makeApp();
    const res = await postImport(app, "append", {
      rules: [rule({ id: "ok", name: "OK" }), { name: "Bad", find: "/[/g" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: engine.RegexRule[]; skipped: unknown[] };
    expect(body.rules.map((entry) => entry.id)).toEqual(["ok"]);
    expect(body.skipped).toEqual([{ name: "Bad", reason: "invalid regex pattern or flags" }]);
  });

  it("enforces the rule cap on the final set and reports the excess as skipped", async () => {
    const { app, repos } = makeApp();
    const stored = Array.from({ length: engine.MAX_REGEX_RULES - 1 }, (_, index) =>
      rule({ id: `s${index}`, name: `Stored ${index}` }),
    );
    await put(app, { rules: stored });
    const res = await postImport(app, "append", {
      rules: [
        rule({ id: "extra-1", name: "Extra One" }),
        rule({ id: "extra-2", name: "Extra Two" }),
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rules: engine.RegexRule[];
      skipped: Array<{ name: string; reason: string }>;
    };
    expect(body.rules).toHaveLength(engine.MAX_REGEX_RULES);
    expect(body.rules.map((entry) => entry.id)).toContain("extra-1");
    expect(body.rules.map((entry) => entry.id)).not.toContain("extra-2");
    expect(body.skipped).toEqual([
      { name: "Extra Two", reason: `rule limit reached (${engine.MAX_REGEX_RULES})` },
    ]);
    expect(engine.getRegexRules(repos)).toHaveLength(engine.MAX_REGEX_RULES);
  });

  it("rejects an unknown mode with 400", async () => {
    const { app, repos } = makeApp();
    const res = await postImport(app, "merge", { rules: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "mode must be one of: append, replace" });
    expect(repos.settings.get(engine.REGEX_RULES_KEY)).toBeNull();
  });

  it("recovers from malformed JSON without throwing (core parser is lenient)", async () => {
    const { app } = makeApp();
    const res = await postImport(app, "replace", "not an object");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: unknown[]; skipped: unknown[] };
    expect(body.rules).toEqual([]);
    expect(body.skipped).toEqual([{ name: "Untitled rule", reason: "not an object" }]);
  });
});
