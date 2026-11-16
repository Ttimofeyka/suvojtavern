/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createGateway } from "./gateway";
import { type Endpoint, GatewayError, resolveEndpoint } from "./gateway-shared";

/** A keyless endpoint on the stub host the fetch helpers here answer. */
const stubEndpoint: Endpoint = { baseUrl: "https://api.example", apiKey: null };

/** Capturing fetch stub with Bun's `preconnect` member; returns canned models. */
function modelsFetch(data: unknown, status = 200) {
  const calls = { count: 0, urls: [] as string[], auths: [] as (string | null)[] };
  const fetchImpl = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.count += 1;
      calls.urls.push(String(input));
      calls.auths.push(new Headers(init?.headers).get("Authorization"));
      return new Response(JSON.stringify({ data }), { status });
    },
    { preconnect: () => {} },
  );
  return { calls, fetchImpl };
}

describe("gateway getModels", () => {
  it("maps upstream models, sends the profile key, and caches within the TTL", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    const profile = repos.profiles.create({
      name: "Models",
      base_url: "https://models.example",
      api_key: "sk-test",
    });

    const { calls, fetchImpl } = modelsFetch([
      { id: "m1", name: "Model One", context_length: 8192 },
      { id: "m2" },
      { name: "entry without id" },
    ]);

    const gateway = createGateway({ repos, fetchImpl });
    const endpoint = await resolveEndpoint(repos, profile);
    const first = await gateway.getModels(endpoint);
    const second = await gateway.getModels(endpoint);

    expect(calls.count).toBe(1);
    expect(calls.urls[0]).toBe("https://models.example/v1/models");
    expect(calls.auths[0]).toBe("Bearer sk-test");
    expect(first).toEqual([{ id: "m1", name: "Model One", context_length: 8192 }, { id: "m2" }]);
    expect(second).toEqual(first);
  });

  it("prefers context_window over context_length and maps it to context_length", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const { fetchImpl } = modelsFetch([
      { id: "m1", context_window: 200_000 },
      { id: "m2", context_window: 8192, context_length: 4096 },
      { id: "m3", context_length: 4096 },
      { id: "m4" },
    ]);

    const gateway = createGateway({ repos, fetchImpl });
    expect(await gateway.getModels(stubEndpoint)).toEqual([
      { id: "m1", context_length: 200_000 },
      { id: "m2", context_length: 8192 },
      { id: "m3", context_length: 4096 },
      { id: "m4" },
    ]);
  });

  it("uses a custom profile endpoint and sends its key as Bearer", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    const profile = repos.profiles.create({
      name: "Local",
      base_url: "https://custom.example",
      api_key: "sk-custom",
    });

    const { calls, fetchImpl } = modelsFetch([{ id: "m1" }]);
    const gateway = createGateway({ repos, fetchImpl });
    await gateway.getModels(await resolveEndpoint(repos, profile));

    expect(calls.urls[0]).toBe("https://custom.example/v1/models");
    expect(calls.auths[0]).toBe("Bearer sk-custom");
  });

  it("sends no Authorization header to a keyless custom endpoint", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    // No key: local runtimes (Ollama, LM Studio) accept unauthenticated calls.
    const profile = repos.profiles.create({ name: "Ollama", base_url: "http://127.0.0.1:11434" });

    const { calls, fetchImpl } = modelsFetch([{ id: "m1" }]);
    const gateway = createGateway({ repos, fetchImpl });
    await gateway.getModels(await resolveEndpoint(repos, profile));

    expect(calls.urls[0]).toBe("http://127.0.0.1:11434/v1/models");
    expect(calls.auths[0]).toBeNull();
  });

  it("caches per base URL so two endpoints do not share a model list", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    const a = repos.profiles.create({ name: "A", base_url: "https://a.example" });
    const b = repos.profiles.create({ name: "B", base_url: "https://b.example" });

    const { calls, fetchImpl } = modelsFetch([{ id: "m1" }]);
    const gateway = createGateway({ repos, fetchImpl });
    await gateway.getModels(await resolveEndpoint(repos, a));
    await gateway.getModels(await resolveEndpoint(repos, b));
    // Repeat: served from the per-baseUrl cache, no third fetch.
    await gateway.getModels(await resolveEndpoint(repos, a));

    expect(calls.count).toBe(2);
    expect(calls.urls).toEqual(["https://a.example/v1/models", "https://b.example/v1/models"]);
  });

  it("does not share a cache entry between keys on the same base URL", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    // Same base, different credentials: an endpoint may serve different model
    // lists per key, and a rotated key must not be served a stale list.
    const first = repos.profiles.create({
      name: "Key A",
      base_url: "https://shared.example",
      api_key: "sk-a",
    });
    const second = repos.profiles.create({
      name: "Key B",
      base_url: "https://shared.example",
      api_key: "sk-b",
    });

    const { calls, fetchImpl } = modelsFetch([{ id: "m1" }]);
    const gateway = createGateway({ repos, fetchImpl });
    await gateway.getModels(await resolveEndpoint(repos, first));
    await gateway.getModels(await resolveEndpoint(repos, second));
    // Repeat the first: still cached under its own key, no third fetch.
    await gateway.getModels(await resolveEndpoint(repos, first));

    expect(calls.count).toBe(2);
    expect(calls.urls).toEqual([
      "https://shared.example/v1/models",
      "https://shared.example/v1/models",
    ]);
    expect(calls.auths).toEqual(["Bearer sk-a", "Bearer sk-b"]);
  });

  it("rejects with a clean GatewayError 400 when no endpoint (profile) is configured", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const { calls, fetchImpl } = modelsFetch([]);
    const gateway = createGateway({ repos, fetchImpl });
    let caught: unknown;
    try {
      await gateway.getModels();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).message).toBe("No connection profile configured");
    expect((caught as GatewayError).status).toBe(400);
    expect(calls.count).toBe(0);
  });

  it("rejects with GatewayError 502 when the upstream 200 body is not JSON", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const fetchImpl = Object.assign(
      async () =>
        new Response("<!DOCTYPE html><html><body>upstream SPA page</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      { preconnect: () => {} },
    );

    const gateway = createGateway({ repos, fetchImpl });
    let caught: unknown;
    try {
      await gateway.getModels(stubEndpoint);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GatewayError);
    const message = String((caught as GatewayError).message);
    expect(message).toContain("non-JSON response");
    expect((caught as GatewayError).status).toBe(502);
  });

  it("rejects with GatewayError when the upstream fetch itself fails", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const fetchImpl = Object.assign(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      { preconnect: () => {} },
    );

    const gateway = createGateway({ repos, fetchImpl });
    let caught: unknown;
    try {
      await gateway.getModels(stubEndpoint);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GatewayError);
    expect(String((caught as GatewayError).message)).toContain("GET https://api.example/v1/models");
    expect(String((caught as GatewayError).message)).toContain("ECONNREFUSED");
  });
});
