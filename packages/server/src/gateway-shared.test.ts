/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import {
  authHeadersFor,
  type Endpoint,
  GatewayError,
  normalizeBaseUrl,
  resolveEndpoint,
} from "./gateway-shared";

type Repos = ReturnType<typeof createRepositories>;

function makeRepos(): Repos {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  return createRepositories(db);
}

const customEndpoint = (apiKey: string | null = null): Endpoint => ({
  baseUrl: "https://custom.example",
  apiKey,
});

describe("normalizeBaseUrl", () => {
  it("trims and strips trailing slashes", () => {
    expect(normalizeBaseUrl("  https://x.example/  ")).toBe("https://x.example");
    expect(normalizeBaseUrl("https://x.example///")).toBe("https://x.example");
  });

  it("strips one trailing /v1 (with or without its slash)", () => {
    expect(normalizeBaseUrl("https://x.example/v1")).toBe("https://x.example");
    expect(normalizeBaseUrl("https://x.example/v1/")).toBe("https://x.example");
    expect(normalizeBaseUrl("https://x.example")).toBe("https://x.example");
  });

  it("keeps an empty input empty (no endpoint configured)", () => {
    expect(normalizeBaseUrl("")).toBe("");
    expect(normalizeBaseUrl("   ")).toBe("");
  });

  it("case-folds the scheme and host and drops a default port", () => {
    expect(normalizeBaseUrl("HTTPS://API.EXAMPLE.COM")).toBe("https://api.example.com");
    expect(normalizeBaseUrl("https://api.example.com:443")).toBe("https://api.example.com");
    expect(normalizeBaseUrl("https://api.example.com:443/v1")).toBe("https://api.example.com");
    expect(normalizeBaseUrl("http://x.example:80/v1/")).toBe("http://x.example");
    // A non-default port is meaningful and must survive.
    expect(normalizeBaseUrl("https://x.example:8443/v1")).toBe("https://x.example:8443");
  });

  it("does not throw on unparseable input (string fallback)", () => {
    expect(normalizeBaseUrl("not-a-url/v1")).toBe("not-a-url");
    expect(normalizeBaseUrl("mailto:x")).toBe("mailto:x");
  });

  it("drops userinfo, query and hash so a lookalike cannot claim the host", () => {
    expect(normalizeBaseUrl("https://api.example.com@evil.com")).toBe("https://evil.com");
    expect(normalizeBaseUrl("https://evil.com/?x=https://api.example.com")).toBe(
      "https://evil.com",
    );
  });
});

describe("resolveEndpoint", () => {
  it("normalizes the profile base_url and reads its secret api_key", async () => {
    const repos = makeRepos();
    const profile = repos.profiles.create({
      name: "Custom",
      base_url: "https://custom.example/v1/",
      api_key: "sk-custom",
    });
    const endpoint = await resolveEndpoint(repos, profile);
    expect(endpoint).toEqual({ baseUrl: "https://custom.example", apiKey: "sk-custom" });
  });

  it("degrades the key to null for a keyless profile", async () => {
    const repos = makeRepos();
    const profile = repos.profiles.create({ name: "Ollama", base_url: "http://127.0.0.1:11434" });
    const endpoint = await resolveEndpoint(repos, profile);
    expect(endpoint).toEqual({ baseUrl: "http://127.0.0.1:11434", apiKey: null });
  });

  it("throws a clean 400 GatewayError when the profile has no base_url", async () => {
    const repos = makeRepos();
    const profile = repos.profiles.create({ name: "Empty" });
    let caught: unknown;
    try {
      await resolveEndpoint(repos, profile);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).status).toBe(400);
    expect((caught as GatewayError).message).toBe("No endpoint configured for this profile");
  });

  it("treats a whitespace-only base_url as unconfigured", async () => {
    const repos = makeRepos();
    const profile = { id: "p", base_url: "   " };
    await expect(resolveEndpoint(repos, profile)).rejects.toBeInstanceOf(GatewayError);
  });

  it("keeps a non-default port (it is a distinct origin)", async () => {
    const repos = makeRepos();
    const profile = repos.profiles.create({
      name: "Port",
      base_url: "https://api.example.com:8443/v1",
    });
    expect((await resolveEndpoint(repos, profile)).baseUrl).toBe("https://api.example.com:8443");
  });
});

describe("authHeadersFor", () => {
  it("sends the profile key as Bearer", () => {
    expect(authHeadersFor(customEndpoint("sk-profile"))).toEqual({
      Authorization: "Bearer sk-profile",
    });
  });

  it("sends no header when the endpoint has no key", () => {
    expect(authHeadersFor(customEndpoint(null))).toEqual({});
  });

  it("sends no header for an empty-string key", () => {
    expect(authHeadersFor(customEndpoint(""))).toEqual({});
  });
});
