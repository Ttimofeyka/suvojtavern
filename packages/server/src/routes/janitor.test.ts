/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations, st } from "@suvoj/core";
import { createApp } from "../app";
import { JANITOR_PROFILES_MINE_URL } from "../janitor/client";
import {
  type Canned,
  type FakeBrowserOptions,
  FakeView,
  fetchStub,
  makeFakeBrowser,
  tinyPng,
} from "../janitor/test-utils";
import type { JanitorBrowserHandle } from "../routes-deps";

/** Blob dir outside the repo so avatar imports never touch data/. */
const DATA_DIR = "/tmp/opencode/janitor-routes-test";

const ID = "64a0c863-506c-4191-82f6-9296c329152b";
const CHARACTER_URL = `https://janitorai.com/characters/${ID}`;

/** A public JanitorAI catalog record (mirrors core's janitor fixture). */
const PUBLIC_META = {
  id: ID,
  name: "Office Lady",
  avatar: "avatar.webp",
  creator_name: "icyicecold",
  custom_tags: ["bodyswap"],
  description: "<p>Blurb</p>",
  personality: "The card body.",
  scenario: "The scenario.",
  first_messages: ["Hello!", "Alt"],
  example_dialogs: "",
  showdefinition: true,
  scripts: [{ id: 123, type: "lorebook", title: "Sex play", is_public: true }],
};

const PRIVATE_META = { ...PUBLIC_META, name: "Private Bot", showdefinition: false };

const SCRIPT = {
  id: 123,
  title: "Sex play",
  description: "A public book",
  script: [{ key: ["dragon"], content: "A dragon guards the hoard." }],
};

const JS_SCRIPT = { id: 124, title: "Nine", script: "function onMessage(ctx) { return true; }" };
const EMPTY_SCRIPT = { id: 126, title: "Empty", script: [] };

/** Canned in-page responses for a fake browser session. */
function routesFor(opts: {
  loggedIn?: boolean;
  meta?: unknown;
  scripts?: Record<string, unknown>;
}): Record<string, Canned> {
  const routes: Record<string, Canned> = {
    [JANITOR_PROFILES_MINE_URL]: {
      status: opts.loggedIn === false ? 401 : 200,
      body: "{}",
    },
  };
  if (opts.meta !== undefined) {
    routes[st.janitorCharacterApiUrl(ID)] = { status: 200, body: JSON.stringify(opts.meta) };
  }
  for (const [id, record] of Object.entries(opts.scripts ?? {})) {
    routes[st.janitorScriptApiUrl(id)] = { status: 200, body: JSON.stringify(record) };
  }
  return routes;
}

/** A fetch stub that answers the avatar CDN with a tiny PNG. */
function avatarFetch(): typeof fetch {
  return fetchStub({
    [st.janitorAvatarUrl("avatar.webp")]: () =>
      new Response(tinyPng(), { headers: { "content-type": "image/png" } }),
  });
}

function makeApp(
  opts: {
    view?: FakeView;
    supported?: boolean;
    fetchImpl?: typeof fetch;
    browser?: JanitorBrowserHandle;
  } = {},
) {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const view = opts.view ?? new FakeView();
  const app = createApp(db, {
    janitorBrowser: opts.browser ?? makeFakeBrowser(view, { supported: opts.supported }),
    pluginsDir: null,
    dataDir: DATA_DIR,
    fetchImpl: opts.fetchImpl,
  });
  return { app, repos, view };
}

async function postJson(
  app: ReturnType<typeof makeApp>["app"],
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/janitor/status", () => {
  it("answers instantly with unsupported when no Chrome exists", async () => {
    const { app, view } = makeApp({ supported: false });
    const res = await app.request("/api/janitor/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      supported: false,
      loggedIn: false,
      checked: false,
      browser: null,
      busy: false,
      loginInProgress: false,
      loginWindowOpen: false,
    });
    expect(String(body.message)).toMatch(/Chrome/);
    // No browser probe was attempted.
    expect(view.fetches).toEqual([]);
  });

  it("answers a cold cache from memory and never launches Chrome", async () => {
    // Regression: merely opening the Import dialog polls status, so a fresh
    // process must report `checked: false` WITHOUT probing (which would spawn
    // Chrome off-screen). The view's routes would say "logged in" if asked.
    const view = new FakeView(routesFor({ loggedIn: true }));
    const base = makeFakeBrowser(view);
    let withViewCalls = 0;
    const browser: JanitorBrowserHandle = {
      ...base,
      withView: (fn, opts) => {
        withViewCalls += 1;
        return base.withView(fn, opts);
      },
    };
    const { app } = makeApp({ view, browser });

    const res = await app.request("/api/janitor/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      supported: true,
      loggedIn: false,
      checked: false,
      browser: "/usr/bin/chrome",
      busy: false,
      loginInProgress: false,
      loginWindowOpen: false,
    });
    expect(withViewCalls).toBe(0);
    expect(view.fetches).toEqual([]);
  });

  it("reports checked:true once a successful import established the session", async () => {
    const view = new FakeView(routesFor({ meta: PUBLIC_META, scripts: { "123": SCRIPT } }));
    const { app } = makeApp({ view, fetchImpl: avatarFetch() });
    const imported = await postJson(app, "/api/janitor/import", { url: CHARACTER_URL });
    expect(imported.status).toBe(201);

    const res = await app.request("/api/janitor/status");
    expect(await res.json()).toMatchObject({
      supported: true,
      loggedIn: true,
      checked: true,
    });
  });

  it("answers from cache while a running login window is up, without probing", async () => {
    const view = new FakeView(routesFor({ loggedIn: true }));
    const base = makeFakeBrowser(view, { running: true });
    let withViewCalls = 0;
    const browser: JanitorBrowserHandle = {
      ...base,
      withView: (fn, opts) => {
        withViewCalls += 1;
        return base.withView(fn, opts);
      },
    };
    const { app } = makeApp({ view, browser });

    const res = await app.request("/api/janitor/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      supported: true,
      loggedIn: false,
      browser: "/usr/bin/chrome",
      busy: false,
      loginInProgress: false,
      loginWindowOpen: true,
    });
    // A probe would mode-switch the browser and tear down the retained window.
    expect(withViewCalls).toBe(0);
    expect(view.fetches).toEqual([]);
  });

  it("reports loginInProgress while a login poll is running", async () => {
    const view = new FakeView(routesFor({ loggedIn: true }));
    const base = makeFakeBrowser(view);
    // A login that never settles keeps `running` true for the duration; it holds
    // no timer, so it cannot keep the test process alive.
    const never: Promise<never> = new Promise(() => {});
    const browser: JanitorBrowserHandle = { ...base, withView: () => never };
    const { app } = makeApp({ view, browser });

    const started = await postJson(app, "/api/janitor/login", {});
    expect(started.status).toBe(202);

    const res = await app.request("/api/janitor/status");
    expect(await res.json()).toMatchObject({
      supported: true,
      busy: true,
      loginInProgress: true,
      loginWindowOpen: false,
    });
  });

  it("reports neither login flag while an import owns the browser", async () => {
    const view = new FakeView(routesFor({ loggedIn: true }));
    // An import/capture keeps Chrome up but busy; that is not a login window.
    const browser = makeFakeBrowser(view, { running: true, busy: true });
    const { app } = makeApp({ view, browser });

    const res = await app.request("/api/janitor/status");
    expect(await res.json()).toMatchObject({
      supported: true,
      busy: true,
      loginInProgress: false,
      loginWindowOpen: false,
    });
    expect(view.fetches).toEqual([]);
  });

  it("rejects a second login while one is running", async () => {
    const view = new FakeView(routesFor({ loggedIn: true }));
    const base = makeFakeBrowser(view);
    // A login that never settles keeps `running` true for the duration. It holds
    // no timer/handle, so it cannot keep the test process alive.
    const never: Promise<never> = new Promise(() => {});
    const browser: JanitorBrowserHandle = { ...base, withView: () => never };
    const { app } = makeApp({ view, browser });

    const first = await postJson(app, "/api/janitor/login", {});
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ started: true });

    const second = await postJson(app, "/api/janitor/login", {});
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "A JanitorAI login is already in progress",
    });
  });
});

describe("POST /api/janitor/login", () => {
  it("retries after a probe that throws instead of aborting the poll", async () => {
    let probes = 0;
    const view = new FakeView({
      [JANITOR_PROFILES_MINE_URL]: () => {
        probes += 1;
        // A transient navigation/CDP error on the first probe must not kill the
        // poll: the next iteration's success still ends it as logged in.
        if (probes === 1) throw new Error("transient CDP error");
        return { status: 200, body: "{}" };
      },
    });
    const { app } = makeApp({ view });

    const started = await postJson(app, "/api/janitor/login", {});
    expect(started.status).toBe(202);

    // The poll waits one interval between attempts, so give it room to land.
    const deadline = Date.now() + 5_000;
    let loggedIn = false;
    let checked = false;
    while (Date.now() < deadline) {
      const body = (await (await app.request("/api/janitor/status")).json()) as {
        loggedIn: boolean;
        checked: boolean;
      };
      if (body.loggedIn) {
        loggedIn = true;
        checked = body.checked;
        break;
      }
      await Bun.sleep(50);
    }
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(loggedIn).toBe(true);
    // A completed login is a real observation, so status reports it as checked.
    expect(checked).toBe(true);
  });
});

describe("POST /api/janitor/login/cancel", () => {
  /** A fake browser that counts its dispose / clearProfile calls. */
  function trackedBrowser(
    view: FakeView,
    opts: FakeBrowserOptions = {},
  ): { browser: JanitorBrowserHandle; calls: { dispose: number; clearProfile: number } } {
    const base = makeFakeBrowser(view, opts);
    const calls = { dispose: 0, clearProfile: 0 };
    return {
      browser: {
        ...base,
        dispose: async () => {
          calls.dispose += 1;
        },
        clearProfile: async () => {
          calls.clearProfile += 1;
        },
      },
      calls,
    };
  }

  it("stops an in-progress login by disposing, never clearing the profile", async () => {
    const view = new FakeView(routesFor({ loggedIn: true }));
    const base = makeFakeBrowser(view);
    const calls = { dispose: 0, clearProfile: 0 };
    // The poll never settles, so only the cancel can end it.
    const never: Promise<never> = new Promise(() => {});
    const browser: JanitorBrowserHandle = {
      ...base,
      withView: () => never,
      dispose: async () => {
        calls.dispose += 1;
      },
      clearProfile: async () => {
        calls.clearProfile += 1;
      },
    };
    const { app } = makeApp({ view, browser });

    const started = await postJson(app, "/api/janitor/login", {});
    expect(started.status).toBe(202);

    const res = await postJson(app, "/api/janitor/login/cancel", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true, loggedIn: false });
    expect(calls.dispose).toBe(1);
    // Cancelling a login must not destroy the saved session.
    expect(calls.clearProfile).toBe(0);

    // The poll is no longer reported as running; status stays cache-only and
    // reports the freshly checked session.
    const status = await app.request("/api/janitor/status");
    expect(await status.json()).toMatchObject({
      loginInProgress: false,
      loginWindowOpen: false,
    });
  });

  it("closes a login window the server retained after its poll ended", async () => {
    const view = new FakeView(routesFor({ loggedIn: true }));
    const { browser, calls } = trackedBrowser(view, { running: true });
    const { app } = makeApp({ view, browser });

    const res = await postJson(app, "/api/janitor/login/cancel", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true, loggedIn: false });
    expect(calls.dispose).toBe(1);
    expect(calls.clearProfile).toBe(0);
  });

  it("refuses with 409 while a non-login operation owns the browser", async () => {
    const view = new FakeView(routesFor({ loggedIn: true }));
    const { browser, calls } = trackedBrowser(view, { running: true, busy: true });
    const { app } = makeApp({ view, browser });

    const res = await postJson(app, "/api/janitor/login/cancel", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Another JanitorAI operation is running" });
    // The import/capture's Chrome was left alone.
    expect(calls.dispose).toBe(0);
    expect(calls.clearProfile).toBe(0);
  });

  it("is an idempotent success when nothing is pending", async () => {
    const view = new FakeView(routesFor({ loggedIn: true }));
    const { browser, calls } = trackedBrowser(view);
    const { app } = makeApp({ view, browser });

    const res = await postJson(app, "/api/janitor/login/cancel", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true, loggedIn: false });
    expect(calls.dispose).toBe(1);
    expect(calls.clearProfile).toBe(0);
  });
});

describe("POST /api/janitor/import", () => {
  it("imports a public character, its avatar and its lorebook", async () => {
    const view = new FakeView(routesFor({ meta: PUBLIC_META, scripts: { "123": SCRIPT } }));
    const { app, repos } = makeApp({ view, fetchImpl: avatarFetch() });
    const res = await postJson(app, "/api/janitor/import", { url: CHARACTER_URL });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      source: string;
      definitionSource: string;
      renamed: boolean;
      lorebook: { id: string; name: string };
      lorebooks: unknown[];
      character: { id: string; name: string; description: string; avatar_path: string | null };
    };
    expect(body.source).toBe("janitor");
    expect(body.definitionSource).toBe("public");
    expect(body.renamed).toBe(false);
    expect(body.character.name).toBe("Office Lady");
    expect(body.character.description).toBe("The card body.");
    expect(body.character.avatar_path).toMatch(/blobs\/.+\.webp$/);
    expect(body.lorebook.name).toBe("Sex play");
    expect(body.lorebooks).toEqual([
      { id: body.lorebook.id, title: "Sex play", status: "imported", entries: 1 },
    ]);

    const stored = repos.characters.get(body.character.id);
    expect(stored?.first_mes).toBe("Hello!");
    expect(stored?.alternate_greetings).toEqual(["Alt"]);
    const [book] = repos.lorebooks.listForCharacter(body.character.id);
    expect(book?.name).toBe("Sex play");
    expect(repos.lorebooks.listEntries(book?.id ?? "")[0]).toMatchObject({
      keys: ["dragon"],
      content: "A dragon guards the hoard.",
    });
  });

  it("maps a private definition to a definition-private 400", async () => {
    const view = new FakeView(routesFor({ meta: PRIVATE_META }));
    const { app } = makeApp({ view, fetchImpl: avatarFetch() });
    const res = await postJson(app, "/api/janitor/import", { url: CHARACTER_URL });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.details).toEqual({ kind: "definition-private" });
    expect(body.error).toMatch(/full extraction/i);
  });

  it("maps a logged-out session to a not-logged-in 400 naming the Log in button", async () => {
    const view = new FakeView(routesFor({ loggedIn: false }));
    const { app } = makeApp({ view, fetchImpl: avatarFetch() });
    const res = await postJson(app, "/api/janitor/import", { url: CHARACTER_URL });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.details).toEqual({ kind: "not-logged-in" });
    expect(body.error).toMatch(/Log in/);
  });

  it("rejects a non-janitor url with a 400", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/janitor/import", { url: "https://example.com/card" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "url is not a janitorai.com character URL" });
  });

  it("handles a duplicate name per onConflict: 409 then rename", async () => {
    const view = new FakeView(routesFor({ meta: PUBLIC_META, scripts: { "123": SCRIPT } }));
    const { app, repos } = makeApp({ view, fetchImpl: avatarFetch() });
    const first = await postJson(app, "/api/janitor/import", { url: CHARACTER_URL });
    expect(first.status).toBe(201);

    const dup = await postJson(app, "/api/janitor/import", { url: CHARACTER_URL });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'character "Office Lady" already exists' });

    const renamed = await postJson(app, "/api/janitor/import", {
      url: CHARACTER_URL,
      onConflict: "rename",
    });
    expect(renamed.status).toBe(201);
    expect(await renamed.json()).toMatchObject({
      renamed: true,
      character: { name: "Office Lady (2)" },
    });
    expect(repos.characters.list().map((character) => character.name)).toEqual([
      "Office Lady",
      "Office Lady (2)",
    ]);
  });

  it("reports imported/js/empty/closed lorebook statuses and honours includeLorebooks", async () => {
    const meta = {
      ...PUBLIC_META,
      scripts: [
        { id: 123, type: "lorebook", title: "Pub", is_public: true },
        { id: 124, type: "advanced", title: "Js", is_public: true },
        { id: 125, type: "lorebook", title: "Closed", is_public: false },
        { id: 126, type: "lorebook", title: "Empty", is_public: true },
      ],
    };
    const view = new FakeView(
      routesFor({ meta, scripts: { "123": SCRIPT, "124": JS_SCRIPT, "126": EMPTY_SCRIPT } }),
    );
    const { app } = makeApp({ view, fetchImpl: avatarFetch() });
    const res = await postJson(app, "/api/janitor/import", { url: CHARACTER_URL });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { lorebooks: Array<{ status: string }> };
    expect(body.lorebooks.map((book) => book.status)).toEqual([
      "imported",
      "js",
      "empty",
      "closed",
    ]);

    const skipped = await postJson(app, "/api/janitor/import", {
      url: CHARACTER_URL,
      onConflict: "rename",
      includeLorebooks: false,
    });
    expect(skipped.status).toBe(201);
    const skippedBody = (await skipped.json()) as { lorebook: unknown; lorebooks: unknown[] };
    expect(skippedBody.lorebooks).toEqual([]);
    expect(skippedBody.lorebook).toBeNull();
  });
});

describe("POST /api/import/url (janitor delegation)", () => {
  it("routes a janitorai.com character URL to the native janitor import", async () => {
    const view = new FakeView(routesFor({ meta: PUBLIC_META, scripts: { "123": SCRIPT } }));
    const { app } = makeApp({ view, fetchImpl: avatarFetch() });
    const res = await postJson(app, "/api/import/url", { url: CHARACTER_URL });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source: string; definitionSource: string };
    expect(body.source).toBe("janitor");
    expect(body.definitionSource).toBe("public");
  });

  it("surfaces a private definition as a definition-private 400", async () => {
    const view = new FakeView(routesFor({ meta: PRIVATE_META }));
    const { app } = makeApp({ view, fetchImpl: avatarFetch() });
    const res = await postJson(app, "/api/import/url", { url: CHARACTER_URL });
    expect(res.status).toBe(400);
    expect((await res.json()) as { details: unknown }).toMatchObject({
      details: { kind: "definition-private" },
    });
  });
});

describe("POST /api/janitor/capture", () => {
  it("requires a JanitorAI login", async () => {
    const view = new FakeView(routesFor({ loggedIn: false }));
    const { app } = makeApp({ view, fetchImpl: avatarFetch() });
    const res = await postJson(app, "/api/janitor/capture", { url: CHARACTER_URL });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ details: { kind: "not-logged-in" } });
  });
});
