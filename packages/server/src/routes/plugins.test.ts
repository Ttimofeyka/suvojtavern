/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import { PluginHost } from "../plugins/host";
import type { RouteDeps } from "../routes-deps";
import { pluginsRoutes } from "./plugins";

/** Route tests over a real host with on-the-fly fixture plugins. */

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const SIMPLE_PLUGIN = `
export default {
  id: "routetest-simple",
  name: "Simple",
  version: "1.2.3",
  description: "Fixture for the routes",
  setup() { return {}; },
};
`;

const SETTINGS_PLUGIN = `
export default {
  id: "routetest-settings",
  name: "Settings",
  version: "0.2.0",
  settings: [
    { key: "prefix", label: "Prefix", type: "string", default: "none" },
    { key: "count", label: "Count", type: "number", default: 1, min: 0, max: 5 },
  ],
  setup() { return {}; },
};
`;

const CONTROLS_PLUGIN = `
export default {
  id: "routetest-controls",
  name: "Controls",
  version: "0.3.0",
  controls: [
    {
      id: "verbosity",
      label: "Verbosity",
      type: "select",
      default: "balanced",
      options: [
        { id: "terse", label: "Terse", value: "be terse" },
        { id: "balanced", label: "Balanced", value: "balanced detail" },
        { id: "rich", label: "Rich" },
      ],
    },
  ],
  setup() { return {}; },
};
`;

let tmpRoot = "";
const hosts: PluginHost[] = [];

interface TestApp {
  app: Hono;
  host: PluginHost;
  repos: ReturnType<typeof createRepositories>;
  pluginsDir: string;
}

/** A pluginsRoutes app over a fresh in-memory db and temp plugins dir. */
function setup(): TestApp {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const fetchImpl: typeof fetch = Object.assign(async () => new Response("[]"), {
    preconnect: () => {},
  });
  const pluginsDir = mkdtempSync(join(tmpRoot, "plugins-"));
  const host = new PluginHost({ pluginsDir, repos });
  hosts.push(host);
  host.loadAll();
  const deps: RouteDeps & { plugins: PluginHost } = {
    repos,
    gateway: createGateway({ repos, fetchImpl }),
    plugins: host,
  };
  const app = new Hono();
  app.route("/", pluginsRoutes(deps));
  return { app, host, repos, pluginsDir };
}

/** Writes one fixture plugin folder. */
function writePlugin(pluginsDir: string, folder: string, source: string): void {
  const dir = join(pluginsDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "suvoj-plugin-routes-"));
});

afterEach(() => {
  for (const host of hosts) {
    host.unloadAll();
  }
  hosts.length = 0;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/plugins", () => {
  it("lists discovered plugins with schema, settings, and ui", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-simple", SIMPLE_PLUGIN);
    writePlugin(pluginsDir, "02-settings", SETTINGS_PLUGIN);
    host.reloadAll();

    const res = await app.request("/api/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: Array<Record<string, unknown>> };
    expect(body.plugins.map((plugin) => plugin.id)).toEqual([
      "routetest-settings",
      "routetest-simple",
    ]);
    const simple = body.plugins.find((plugin) => plugin.id === "routetest-simple");
    expect(simple).toMatchObject({
      name: "Simple",
      version: "1.2.3",
      description: "Fixture for the routes",
      // Freshly discovered plugins are disabled until enabled (opt-in):
      enabled: false,
      settingsSchema: null,
      settings: null,
      ui: null,
    });
    const settings = body.plugins.find((plugin) => plugin.id === "routetest-settings");
    expect(settings?.settings).toEqual({ prefix: "none", count: 1 });
    expect(Array.isArray(settings?.settingsSchema)).toBe(true);
  });

  it("lists control declarations and resolved values for the web card", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.reloadAll();

    const res = await app.request("/api/plugins");
    const body = (await res.json()) as { plugins: Array<Record<string, unknown>> };
    const controls = body.plugins.find((plugin) => plugin.id === "routetest-controls");
    expect(controls?.controls).toEqual([
      {
        id: "verbosity",
        label: "Verbosity",
        type: "select",
        default: "balanced",
        options: [
          { id: "terse", label: "Terse", value: "be terse" },
          { id: "balanced", label: "Balanced", value: "balanced detail" },
          { id: "rich", label: "Rich" },
        ],
      },
    ]);
    // No stored choice → the declared default.
    expect(controls?.controlValues).toEqual({ verbosity: "balanced" });
  });
});

describe("PATCH /api/plugins/:id", () => {
  it("toggles enablement and persists it", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-simple", SIMPLE_PLUGIN);
    host.reloadAll();

    // Fresh plugins are disabled — enabling activates them:
    const res = await app.request(
      "/api/plugins/routetest-simple",
      jsonInit("PATCH", { enabled: true }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plugin: { enabled: boolean } }).plugin.enabled).toBe(true);
    expect(
      (await app.request("/api/plugins/routetest-simple", jsonInit("PATCH", { enabled: false })))
        .status,
    ).toBe(200);
  });

  it("404s for unknown plugins and 400s for bad bodies", async () => {
    const { app } = setup();
    expect(
      (await app.request("/api/plugins/ghost", jsonInit("PATCH", { enabled: true }))).status,
    ).toBe(404);
    expect(
      (await app.request("/api/plugins/ghost", jsonInit("PATCH", { enabled: "yes" }))).status,
    ).toBe(400);
    expect((await app.request("/api/plugins/ghost", jsonInit("PATCH"))).status).toBe(400);
  });
});

describe("POST /api/plugins/reload", () => {
  it("rescans the folder and returns the fresh list", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-simple", SIMPLE_PLUGIN);
    host.reloadAll();

    let res = await app.request("/api/plugins");
    let body = (await res.json()) as { plugins: Array<{ id: string }> };
    expect(body.plugins.map((plugin) => plugin.id)).toEqual(["routetest-simple"]);

    writePlugin(pluginsDir, "02-settings", SETTINGS_PLUGIN);
    res = await app.request("/api/plugins/reload", { method: "POST" });
    expect(res.status).toBe(200);
    body = (await res.json()) as { plugins: Array<{ id: string }> };
    expect(body.plugins.map((plugin) => plugin.id)).toEqual([
      "routetest-settings",
      "routetest-simple",
    ]);
  });
});

describe("plugin settings endpoints", () => {
  it("GET returns effective settings; PUT roundtrips and validates", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-settings", SETTINGS_PLUGIN);
    host.reloadAll();

    const get = await app.request("/api/plugins/routetest-settings/settings");
    expect(get.status).toBe(200);
    expect(((await get.json()) as { settings: Record<string, unknown> }).settings).toEqual({
      prefix: "none",
      count: 1,
    });

    const put = await app.request(
      "/api/plugins/routetest-settings/settings",
      jsonInit("PUT", { settings: { prefix: "sir", count: 3 } }),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { settings: Record<string, unknown> }).settings).toEqual({
      prefix: "sir",
      count: 3,
    });

    const unknown = await app.request(
      "/api/plugins/routetest-settings/settings",
      jsonInit("PUT", { settings: { nope: true } }),
    );
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(await unknown.json())).toContain("nope");

    const badType = await app.request(
      "/api/plugins/routetest-settings/settings",
      jsonInit("PUT", { settings: { count: "three" } }),
    );
    expect(badType.status).toBe(400);

    const outOfRange = await app.request(
      "/api/plugins/routetest-settings/settings",
      jsonInit("PUT", { settings: { count: 99 } }),
    );
    expect(outOfRange.status).toBe(400);
    expect(JSON.stringify(await outOfRange.json())).toContain("must be <= 5");
  });

  it("404s for unknown plugins; schema-less plugins expose null settings", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-simple", SIMPLE_PLUGIN);
    host.reloadAll();

    expect((await app.request("/api/plugins/ghost/settings")).status).toBe(404);
    expect(
      (await app.request("/api/plugins/ghost/settings", jsonInit("PUT", { settings: {} }))).status,
    ).toBe(404);

    const get = await app.request("/api/plugins/routetest-simple/settings");
    expect(get.status).toBe(200);
    expect(((await get.json()) as { settings: unknown }).settings).toBeNull();

    const put = await app.request(
      "/api/plugins/routetest-simple/settings",
      jsonInit("PUT", { settings: {} }),
    );
    expect(put.status).toBe(400);
    expect(JSON.stringify(await put.json())).toContain("no settings schema");
  });
});

describe("PUT /api/plugins/:id/controls", () => {
  it("stores control values and answers with the fresh resolved map", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.reloadAll();

    const res = await app.request(
      "/api/plugins/routetest-controls/controls",
      jsonInit("PUT", { values: { verbosity: "rich" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ control_values: { verbosity: "rich" } });

    // The list reflects the stored choice too:
    const list = (await (await app.request("/api/plugins")).json()) as {
      plugins: Array<{ id: string; controlValues: Record<string, string> | null }>;
    };
    expect(
      list.plugins.find((plugin) => plugin.id === "routetest-controls")?.controlValues,
    ).toEqual({ verbosity: "rich" });
  });

  it("400s on an unknown control and an unknown option, with details", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.reloadAll();

    const unknownControl = await app.request(
      "/api/plugins/routetest-controls/controls",
      jsonInit("PUT", { values: { tone: "warm" } }),
    );
    expect(unknownControl.status).toBe(400);
    const body = (await unknownControl.json()) as { error: string; details: unknown };
    expect(body.error).toBe("Invalid plugin control values");
    expect(body.details).toEqual([{ path: "tone", message: "Unknown control" }]);

    const unknownOption = await app.request(
      "/api/plugins/routetest-controls/controls",
      jsonInit("PUT", { values: { verbosity: "ghost" } }),
    );
    expect(unknownOption.status).toBe(400);
    expect(JSON.stringify(await unknownOption.json())).toContain("expected one of");
  });

  it("404s for an unknown plugin, 400s for a plugin with no controls and bad bodies", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-simple", SIMPLE_PLUGIN);
    writePlugin(pluginsDir, "02-controls", CONTROLS_PLUGIN);
    host.reloadAll();

    expect(
      (
        await app.request(
          "/api/plugins/ghost/controls",
          jsonInit("PUT", { values: { verbosity: "rich" } }),
        )
      ).status,
    ).toBe(404);

    const noControls = await app.request(
      "/api/plugins/routetest-simple/controls",
      jsonInit("PUT", { values: { x: "y" } }),
    );
    expect(noControls.status).toBe(400);
    expect(JSON.stringify(await noControls.json())).toContain("no controls");

    expect(
      (
        await app.request(
          "/api/plugins/routetest-controls/controls",
          jsonInit("PUT", { values: { verbosity: 3 } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request("/api/plugins/routetest-controls/controls", jsonInit("PUT"))).status,
    ).toBe(400);
  });
});

describe("GET /api/plugins/:id/tabs/:tabId/data", () => {
  const PANEL_PLUGIN = `
export default {
  id: "routetest-panel",
  name: "Panel",
  version: "1.0.0",
  drawerTabs: [{ id: "routetest-panel-tab", label: "Panel", htmlTemplate: "{{greeting}}" }],
  setup() {
    return {
      onPanelData(event) {
        globalThis.__spy_routetest_panel = {
          chatId: event.chatId,
          character: event.character?.name ?? null,
          messages: event.messages.map((m) => m.content),
        };
        return { greeting: "hello" };
      },
    };
  },
};
`;

  const THROWING_PLUGIN = `
export default {
  id: "routetest-panelthrow",
  name: "Panel Throw",
  version: "1.0.0",
  drawerTabs: [{ id: "routetest-throw-tab", label: "Panel", htmlTemplate: "<p></p>" }],
  setup() {
    return { onPanelData() { throw new Error("panel boom"); } };
  },
};
`;

  /** A chat with one greeting + one user message over the test repos. */
  function seedChat(repos: ReturnType<typeof createRepositories>): string {
    const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
    const chat = repos.chats.create({ character_id: characterId });
    repos.messages.insertMessage(chat.id, { role: "assistant", name: "Aria", content: "Hello!" });
    repos.messages.insertMessage(chat.id, { role: "user", content: "Hi Aria" });
    return chat.id;
  }

  it("answers with the declared template wrapped around the hook's data", async () => {
    const { app, host, repos, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-panel", PANEL_PLUGIN);
    host.reloadAll();
    host.setEnabled("routetest-panel", true);
    const chatId = seedChat(repos);

    const res = await app.request(
      `/api/plugins/routetest-panel/tabs/routetest-panel-tab/data?chatId=${chatId}`,
    );
    expect(res.status).toBe(200);
    // The envelope: the tab's DECLARED htmlTemplate/css (css defaults to ""
    // when the declaration omits it) plus the hook result as data:
    expect(await res.json()).toEqual({
      htmlTemplate: "{{greeting}}",
      css: "",
      data: { greeting: "hello" },
    });
    const seen = (globalThis as Record<string, unknown>).__spy_routetest_panel as
      | {
          chatId: string;
          character: string | null;
          messages: string[];
        }
      | undefined;
    expect(seen?.chatId).toBe(chatId);
    expect(seen?.character).toBe("Aria");
    expect(seen?.messages).toEqual(["Hello!", "Hi Aria"]);
  });

  it("404s for unknown plugin, tab, or chat; 400 without chatId", async () => {
    const { app, host, repos, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-panel", PANEL_PLUGIN);
    host.reloadAll();
    host.setEnabled("routetest-panel", true);
    const chatId = seedChat(repos);

    expect((await app.request("/api/plugins/ghost/tabs/x/data?chatId=c")).status).toBe(404);
    expect(
      (await app.request(`/api/plugins/routetest-panel/tabs/ghost/data?chatId=${chatId}`)).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/plugins/routetest-panel/tabs/routetest-panel-tab/data?chatId=ghost`))
        .status,
    ).toBe(404);
    expect(
      (await app.request("/api/plugins/routetest-panel/tabs/routetest-panel-tab/data")).status,
    ).toBe(400);
  });

  it("maps a throwing hook to 500 with its message", async () => {
    const { app, host, repos, pluginsDir } = setup();
    writePlugin(pluginsDir, "01-throw", THROWING_PLUGIN);
    host.reloadAll();
    host.setEnabled("routetest-panelthrow", true);
    const chatId = seedChat(repos);

    const res = await app.request(
      `/api/plugins/routetest-panelthrow/tabs/routetest-throw-tab/data?chatId=${chatId}`,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "panel boom" });
  });
});
