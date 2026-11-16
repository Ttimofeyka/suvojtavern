/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations, st } from "@suvoj/core";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { JANITOR_PROFILES_MINE_URL } from "./client";
import { captureAndReconstruct, enterExtractionMode } from "./extract";
import {
  capturePayloads,
  FakeView,
  type FetchRoute,
  fetchStub,
  makeFakeBrowser,
} from "./test-utils";

/**
 * Phase B tests. A real capture needs a logged-in JanitorAI DOM, which cannot
 * exist hermetically, so the browser is faked: the canned view answers the
 * `/hampter` API calls and replays `generateAlpha` payloads on each send, while
 * the closed-lorebook rebuild is exercised through a stubbed gateway (the exact
 * path /api/lorebooks/generate-entry uses).
 */

const DATA_DIR = "/tmp/opencode/janitor-extract-test";
const ID = "64a0c863-506c-4191-82f6-9296c329152b";

// JanitorAI endpoints, kept here as literals so a URL drift breaks loudly.
const API_SETTINGS_URL = "https://janitorai.com/hampter/api-settings";
const PROXY_CONFIGS_URL = `${API_SETTINGS_URL}/proxy-configs`;
const PERSONAS_URL = "https://janitorai.com/hampter/personas";
const CHATS_URL = "https://janitorai.com/hampter/chats";

const PRIVATE_META = {
  id: ID,
  name: "Private Bot",
  avatar: null,
  creator_name: "someone",
  custom_tags: ["hidden"],
  description: "<p>Blurb</p>",
  personality: "",
  scenario: "",
  first_messages: [],
  first_message: "Welcome.",
  example_dialogs: "",
  showdefinition: false,
  scripts: [{ id: 9, type: "lorebook", title: "Closed book", is_public: false }],
};

/** Canned `/hampter` responses for a full capture run (marks a chat + persona). */
function captureRoutes(): Record<string, FetchRoute> {
  let clientId = "";
  return {
    [JANITOR_PROFILES_MINE_URL]: { status: 200, body: "{}" },
    [st.janitorCharacterApiUrl(ID)]: { status: 200, body: JSON.stringify(PRIVATE_META) },
    [API_SETTINGS_URL]: (_url, init) => {
      if (init?.method === "PATCH") return { status: 200, body: "{}" };
      const proxyConfigs = clientId === "" ? [] : [{ client_id: clientId, id: "dummy-1" }];
      return {
        status: 200,
        body: JSON.stringify({
          settings: {
            selected_proxy_config_id: "original",
            source: "jllm",
            generation_settings: { context_length: 4096 },
          },
          proxy_configs: proxyConfigs,
        }),
      };
    },
    [PROXY_CONFIGS_URL]: (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as { client_id?: string };
        clientId = body.client_id ?? "";
      }
      return { status: 200, body: "{}" };
    },
    [`${PROXY_CONFIGS_URL}/dummy-1`]: { status: 200, body: "{}" },
    [CHATS_URL]: { status: 200, body: JSON.stringify({ id: "chat-1" }) },
    [`${CHATS_URL}/chat-1`]: { status: 200, body: "{}" },
    [PERSONAS_URL]: (_url, init) =>
      init?.method === "POST"
        ? { status: 200, body: JSON.stringify({ id: "p1", name: "{{user}}" }) }
        : { status: 200, body: JSON.stringify({ personas: [] }) },
    [`${PERSONAS_URL}/p1`]: { status: 200, body: "{}" },
  };
}

function makeDeps(opts: { view: FakeView; gatewayFetch?: typeof fetch }): RouteDeps {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  return {
    repos,
    gateway: createGateway({ repos, fetchImpl: opts.gatewayFetch }),
    dataDir: DATA_DIR,
    fetchImpl: fetchStub({}),
    janitorBrowser: makeFakeBrowser(opts.view),
  };
}

const CLOSED_LORE = "CLOSED LORE: dragons rule the north.";

function captureView(): FakeView {
  const view = new FakeView(captureRoutes());
  view.payloads.push(
    ...capturePayloads({
      characterName: "Private Bot",
      card: "CARD BODY",
      closedLore: CLOSED_LORE,
    }),
  );
  return view;
}

describe("enterExtractionMode", () => {
  it("deletes the dummy preset when the selection PATCH fails", async () => {
    // The selection PATCH fails after the dummy exists and the snapshot never
    // escapes, so this function itself must undo the stray preset.
    let clientId = "";
    const routes: Record<string, FetchRoute> = {
      [API_SETTINGS_URL]: (_url, init) => {
        if (init?.method === "PATCH") {
          return { status: 500, body: JSON.stringify({ error: "API_SETTINGS_FAILED" }) };
        }
        const proxyConfigs = clientId === "" ? [] : [{ client_id: clientId, id: "dummy-1" }];
        return {
          status: 200,
          body: JSON.stringify({
            settings: { selected_proxy_config_id: "original", source: "jllm" },
            proxy_configs: proxyConfigs,
          }),
        };
      },
      [PROXY_CONFIGS_URL]: (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body ?? "{}") as { client_id?: string };
          clientId = body.client_id ?? "";
        }
        return { status: 200, body: "{}" };
      },
      [`${PROXY_CONFIGS_URL}/dummy-1`]: { status: 200, body: "{}" },
    };
    const view = new FakeView(routes);

    await expect(enterExtractionMode(view)).rejects.toThrow(/patch api-settings failed/);
    expect(
      view.requests.some(
        (request) => request.url === `${PROXY_CONFIGS_URL}/dummy-1` && request.method === "DELETE",
      ),
    ).toBe(true);
  });
});

describe("captureAndReconstruct", () => {
  it("reconstructs the card and warns when no LLM profile is configured", async () => {
    const view = captureView();
    const deps = makeDeps({ view });
    const result = await captureAndReconstruct(
      { url: `https://janitorai.com/characters/${ID}` },
      deps,
    );

    expect(result.source).toBe("janitor");
    expect(result.definitionSource).toBe("reconstructed");
    expect(result.character.name).toBe("Private Bot");
    expect(result.character.description).toBe("CARD BODY");
    expect(result.character.scenario).toBe("SCENARIO");
    expect(result.character.first_mes).toBe("Welcome.");
    expect(result.character.avatar_path).toBeNull();
    expect(result.lorebook).toBeNull();
    expect(result.lorebooks).toEqual([{ id: "9", title: "Closed book", status: "closed" }]);
    expect(result.warnings.join(" ")).toMatch(/No connection profile configured/);

    // Cleanup: the dummy proxy was deleted, the profile restored, the persona
    // removed and the chat (closed text captured) deleted.
    expect(view.fetches).toContain(`${PROXY_CONFIGS_URL}/dummy-1`);
    expect(view.fetches).toContain("https://janitorai.com/hampter/chats/chat-1");
    expect(view.fetches).toContain("https://janitorai.com/hampter/personas/p1");
    expect(view.fetches.filter((url) => url === API_SETTINGS_URL).length).toBeGreaterThan(0);
    expect(view.navigations).toContain("https://janitorai.com/chats/chat-1");
  });

  it("warns (never fails) when the rebuild profile has no endpoint configured", async () => {
    const view = captureView();
    const deps = makeDeps({ view });
    // The profile exists but has an empty base_url, so `resolveEndpoint`
    // throws a 400 — the rebuild is optional and must swallow it rather than
    // failing the whole card import.
    deps.repos.profiles.create({ name: "Unconfigured", model: "test-model" });

    const result = await captureAndReconstruct(
      { url: `https://janitorai.com/characters/${ID}` },
      deps,
    );

    expect(result.source).toBe("janitor");
    expect(result.definitionSource).toBe("reconstructed");
    expect(result.character.name).toBe("Private Bot");
    expect(result.lorebooks).toEqual([{ id: "9", title: "Closed book", status: "closed" }]);
    expect(result.warnings.join(" ")).toMatch(/No endpoint configured for this profile/);
  });

  it("cleans up the chat, persona and dummy preset when the import throws", async () => {
    const view = captureView();
    const deps = makeDeps({ view });
    // A pre-existing name makes assertNoNameConflict throw AFTER the capture and
    // after the chat/persona/preset were created — the throw-cleanup path.
    deps.repos.characters.create({ name: "Private Bot" });

    await expect(
      captureAndReconstruct({ url: `https://janitorai.com/characters/${ID}` }, deps),
    ).rejects.toThrow(/already exists/);

    const called = (url: string, method: string): boolean =>
      view.requests.some((request) => request.url === url && request.method === method);
    // The temporary chat is deleted even though the import threw.
    expect(called(`${CHATS_URL}/chat-1`, "DELETE")).toBe(true);
    // Only the persona WE created is deleted.
    expect(called(`${PERSONAS_URL}/p1`, "DELETE")).toBe(true);
    // The dummy preset and the profile snapshot are undone too.
    expect(called(`${PROXY_CONFIGS_URL}/dummy-1`, "DELETE")).toBe(true);
    expect(called(API_SETTINGS_URL, "PATCH")).toBe(true);
  });

  it("does not delete a pre-existing {{user}} persona on cleanup", async () => {
    // The account already owns a `{{user}}` persona: the run must reuse it and
    // never delete it, even though it also fails on the duplicate name later.
    const routes = captureRoutes();
    routes[PERSONAS_URL] = {
      status: 200,
      body: JSON.stringify({ personas: [{ id: "owned", name: "{{user}}" }] }),
    };
    const view = new FakeView(routes);
    view.payloads.push(
      ...capturePayloads({
        characterName: "Private Bot",
        card: "CARD BODY",
        closedLore: CLOSED_LORE,
      }),
    );
    const deps = makeDeps({ view });
    deps.repos.characters.create({ name: "Private Bot" });

    await expect(
      captureAndReconstruct({ url: `https://janitorai.com/characters/${ID}` }, deps),
    ).rejects.toThrow(/already exists/);

    // The dummy preset may still be deleted; the user's own persona may not.
    expect(
      view.requests.some(
        (request) => request.url === `${PERSONAS_URL}/owned` && request.method === "DELETE",
      ),
    ).toBe(false);
    expect(
      view.requests.some((request) => request.url === PERSONAS_URL && request.method === "POST"),
    ).toBe(false);
  });

  it("rebuilds the closed lorebook through the lorebook-generation plumbing", async () => {
    const entry = {
      comment: "Dragons",
      key: ["dragon"],
      keysecondary: [],
      content: "Dragons rule the north.",
      order: 10,
    };
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: JSON.stringify({ entries: [entry] }) } }],
    })}\n\ndata: [DONE]\n\n`;
    const gatewayFetch = fetchStub({
      "https://llm.example.com/v1/chat/completions": () =>
        new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    });
    const view = captureView();
    const deps = makeDeps({ view, gatewayFetch });
    deps.repos.profiles.create(
      { name: "Extract", model: "test-model", base_url: "https://llm.example.com" },
      { is_default: true },
    );

    const result = await captureAndReconstruct(
      { url: `https://janitorai.com/characters/${ID}` },
      deps,
    );

    expect(result.definitionSource).toBe("reconstructed");
    expect(result.lorebooks).toEqual([
      { id: expect.any(String), title: "Closed book", status: "imported", entries: 1 },
    ]);
    expect(result.warnings).toEqual([]);
    const [book] = deps.repos.lorebooks.listForCharacter(result.character.id);
    expect(book?.name).toBe("Closed book");
    expect(deps.repos.lorebooks.listEntries(book?.id ?? "")[0]).toMatchObject({
      keys: ["dragon"],
      content: "Dragons rule the north.",
    });
  });

  it("rejects a non-janitor url before touching the browser", async () => {
    const view = new FakeView();
    const deps = makeDeps({ view });
    await expect(captureAndReconstruct({ url: "https://example.com/card" }, deps)).rejects.toThrow(
      /not a janitorai/,
    );
    expect(view.navigations).toEqual([]);
  });
});
