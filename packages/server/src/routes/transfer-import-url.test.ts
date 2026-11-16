/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { createRepositories, migrations, openDatabase, runMigrations, st } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { transferRoutes } from "./transfer";

/** Blob dir outside the repo so avatar imports never touch data/. */
const DATA_DIR = "/tmp/opencode/transfer-import-url-test";

const API_URL = "https://api.chub.ai/api/characters/creator-alpha/project-one?full=true";
const AVATAR_URL = "https://cdn.chub.ai/creator-alpha/project-one.png";

/** 1×1 PNG base64 — the chub avatar payload. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The avatar bytes as a fresh Uint8Array (BodyInit-safe per response). */
const tinyPng = () => new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));

/** The chub API metadata payload (`?full=true` shape). */
const METADATA = {
  node: {
    max_res_url: AVATAR_URL,
    topics: ["Elf"],
    definition: {
      name: "Sylvie",
      personality: "A cheerful elf.",
      tavern_personality: "cheerful",
      scenario: "A clearing.",
      first_message: "Hello, traveler!",
    },
  },
};

/** Every request the route makes, recorded for header/URL assertions. */
const calls: Array<{ url: string; headers: Headers }> = [];

/** A fetch stub routed by exact URL; unmatched URLs answer 404. */
function fetchStub(routes: Record<string, () => Response>): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: new Headers(init?.headers) });
      return (routes[url] ?? (() => new Response("not found", { status: 404 })))();
    },
    { preconnect: () => {} },
  );
}

function makeApp(fetchImpl: typeof fetch) {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = {
    repos,
    gateway: createGateway({ repos }),
    dataDir: DATA_DIR,
    fetchImpl,
  };
  return { app: new Hono().route("/", transferRoutes(deps)), repos };
}

async function postUrl(app: Hono, url: string, onConflict?: string): Promise<Response> {
  return app.request("/api/import/url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(onConflict === undefined ? { url } : { url, onConflict }),
  });
}

describe("POST /api/import/url (chub.ai)", () => {
  it("imports a character from chub.ai with its avatar", async () => {
    calls.length = 0;
    const { app, repos } = makeApp(
      fetchStub({
        [API_URL]: () => Response.json(METADATA),
        [AVATAR_URL]: () =>
          new Response(tinyPng(), {
            headers: { "content-type": "image/png" },
          }),
      }),
    );
    const res = await postUrl(app, "https://chub.ai/characters/creator-alpha/project-one");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      source: string;
      renamed: boolean;
      lorebook: unknown;
      character: {
        id: string;
        name: string;
        description: string;
        personality: string;
        tags: string[];
        avatar_path: string | null;
      };
    };
    expect(body.source).toBe("chub");
    expect(body.renamed).toBe(false);
    expect(body.lorebook).toBeNull();
    expect(body.character.name).toBe("Sylvie");
    expect(body.character.description).toBe("A cheerful elf."); // chub "personality"
    expect(body.character.personality).toBe("cheerful");
    expect(body.character.tags).toEqual(["Elf"]);
    // Metadata first, then the avatar — both with the documented headers.
    expect(calls.map((call) => call.url)).toEqual([API_URL, AVATAR_URL]);
    expect(calls.map((call) => call.headers.get("user-agent"))).toEqual([
      "SuvojTavern",
      "SuvojTavern",
    ]);
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
    // The avatar went through the lossless-WebP blob pipeline.
    const stored = repos.characters.get(body.character.id);
    expect(stored?.avatar_path).toMatch(/blobs\/.+\.webp$/);
    expect(existsSync(stored?.avatar_path ?? "")).toBe(true);
  });

  it("imports without an avatar when the avatar download fails", async () => {
    const { app } = makeApp(fetchStub({ [API_URL]: () => Response.json(METADATA) }));
    const res = await postUrl(app, "creator-alpha/project-one"); // bare id form
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      source: string;
      character: { avatar_path: string | null };
    };
    expect(body.source).toBe("chub");
    expect(body.character.avatar_path).toBeNull();
  });

  it("skips a chub avatar whose URL is not http(s)", async () => {
    calls.length = 0;
    // max_res_url is remote data: a non-http(s) scheme must be rejected by
    // the shared download() choke point, never fetched.
    const { app } = makeApp(
      fetchStub({
        [API_URL]: () =>
          Response.json({ node: { ...METADATA.node, max_res_url: "file:///etc/passwd" } }),
      }),
    );
    const res = await postUrl(app, "https://chub.ai/characters/creator-alpha/project-one");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { character: { avatar_path: string | null } };
    expect(body.character.avatar_path).toBeNull();
    expect(calls.map((call) => call.url)).toEqual([API_URL]); // avatar never fetched
  });

  it("maps chub metadata failures to 502", async () => {
    const { app } = makeApp(fetchStub({}));
    const res = await postUrl(app, "https://venus.chub.ai/characters/creator-alpha/project-one");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "chub.ai request failed (404)" });
  });

  it("maps chub fetch errors to 502", async () => {
    const fetchImpl = Object.assign(
      async (): Promise<Response> => {
        throw new Error("connection reset");
      },
      { preconnect: () => {} },
    );
    const { app } = makeApp(fetchImpl);
    const res = await postUrl(app, "https://chub.ai/characters/creator-alpha/project-one");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "chub.ai request failed: connection reset" });
  });

  it("rejects chub lorebook URLs with 400", async () => {
    const { app } = makeApp(fetchStub({}));
    const res = await postUrl(app, "https://chub.ai/lorebooks/creator-alpha/some-book");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "chub lorebook import is not supported yet" });
  });
});

describe("POST /api/import/url (direct links)", () => {
  it("imports a PNG card link, reusing the PNG as the avatar", async () => {
    let pngBytes: Uint8Array = new Uint8Array();
    const { app, repos } = makeApp(
      fetchStub({
        "https://example.com/aria.png": () =>
          new Response(new Uint8Array(pngBytes), { headers: { "content-type": "image/png" } }),
      }),
    );
    const aria = repos.characters.create({ name: "Aria", first_mes: "Hi!" });
    pngBytes = await st.exportCardPng(aria);

    const res = await postUrl(app, "https://example.com/aria.png", "replace");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      source: string;
      character: { id: string; name: string; avatar_path: string | null };
    };
    expect(body.source).toBe("png");
    expect(body.character.id).toBe(aria.id); // replaced in place
    expect(body.character.name).toBe("Aria");
    expect(body.character.avatar_path).toMatch(/blobs\/.+\.webp$/);
  });

  it("imports a JSON card link", async () => {
    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Json", description: "from a url", first_mes: "Hey" },
    };
    const { app } = makeApp(fetchStub({ "https://example.com/card": () => Response.json(card) }));
    const res = await postUrl(app, "https://example.com/card");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      source: string;
      lorebook: unknown;
      character: { name: string; description: string };
    };
    expect(body.source).toBe("json");
    expect(body.lorebook).toBeNull();
    expect(body.character.name).toBe("Json");
    expect(body.character.description).toBe("from a url");
  });

  it("classifies by file name and magic bytes when the content-type is absent", async () => {
    let pngBytes: Uint8Array = new Uint8Array();
    const { app, repos } = makeApp(
      fetchStub({
        "https://example.com/dl.png": () => new Response(new Uint8Array(pngBytes)),
        "https://example.com/raw": () => new Response(new Uint8Array(pngBytes)),
        "https://example.com/dl": () =>
          new Response(
            JSON.stringify({
              spec: "chara_card_v2",
              spec_version: "2.0",
              data: { name: "Sniff" },
            }),
            { headers: { "content-type": "application/octet-stream" } },
          ),
        "https://example.com/dl.mp3": () =>
          new Response(new Uint8Array(Buffer.from("ID3 not a card at all")), {
            headers: { "content-type": "application/octet-stream" },
          }),
      }),
    );
    pngBytes = await st.exportCardPng(
      repos.characters.create({ name: "SniffPng", first_mes: "x" }),
    );

    const byName = await postUrl(app, "https://example.com/dl.png", "replace");
    expect(byName.status).toBe(201);
    expect(((await byName.json()) as { source: string }).source).toBe("png");

    const byMagic = await postUrl(app, "https://example.com/raw", "replace");
    expect(byMagic.status).toBe(201);
    expect(((await byMagic.json()) as { source: string }).source).toBe("png");

    const json = await postUrl(app, "https://example.com/dl");
    expect(json.status).toBe(201);
    expect(((await json.json()) as { source: string }).source).toBe("json");

    const bad = await postUrl(app, "https://example.com/dl.mp3");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "unsupported content" });
  });

  it("rejects a JSON-typed body that does not parse", async () => {
    const { app } = makeApp(
      fetchStub({
        "https://example.com/broken": () =>
          new Response("{not json", { headers: { "content-type": "application/json" } }),
      }),
    );
    const res = await postUrl(app, "https://example.com/broken");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "url did not return valid JSON" });
  });

  it("maps direct-link download failures to 502", async () => {
    const { app } = makeApp(fetchStub({})); // everything 404s
    const res = await postUrl(app, "https://example.com/card.png");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "example.com request failed (404)" });
  });
});

describe("POST /api/import/url (validation)", () => {
  it("rejects a missing url, a bad onConflict, and unusable schemes", async () => {
    const { app } = makeApp(fetchStub({}));
    const noUrl = await app.request("/api/import/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noUrl.status).toBe(400);
    expect(await noUrl.json()).toMatchObject({ error: "Invalid request body" });

    const badConflict = await postUrl(app, "https://example.com/x", "merge");
    expect(badConflict.status).toBe(400);
    expect(await badConflict.json()).toMatchObject({ error: "Invalid request body" });

    const ftp = await postUrl(app, "ftp://example.com/x");
    expect(ftp.status).toBe(400);
    expect(await ftp.json()).toMatchObject({ error: "url must be an http(s) URL" });

    const garbage = await postUrl(app, "not a url");
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ error: "invalid url" });
  });
});
