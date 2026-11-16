/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatHookBus,
  createRepositories,
  migrations,
  openDatabase,
  runMigrations,
  tracker,
} from "@suvoj/core";
import type { Repos } from "../routes-deps";
import { PluginHost } from "./host";

/**
 * Tracker contributions (mechanisms, drawer tabs) and the panel-data
 * surface of the plugin host. Registries are process-global — every fixture
 * uses unique ids and hosts are unloaded after each test.
 */

interface Harness {
  host: PluginHost;
  repos: Repos;
  pluginsDir: string;
}

let tmpRoot = "";
const hosts: PluginHost[] = [];

/** Reads a fixture's globalThis spy record. */
function spy<T>(id: string): T {
  return (globalThis as Record<string, unknown>)[`__spy_${id.replaceAll("-", "_")}`] as T;
}

/** Creates a fresh host over an in-memory db and its own temp plugins dir. */
function harness(): Harness {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const bus = new ChatHookBus();
  const repos = createRepositories(db, bus);
  const pluginsDir = mkdtempSync(join(tmpRoot, "plugins-"));
  const host = new PluginHost({ pluginsDir, repos, hooks: bus });
  hosts.push(host);
  return { host, repos, pluginsDir };
}

/** Writes one plugin folder with the given index.ts source. */
function writePlugin(pluginsDir: string, folder: string, source: string): void {
  const dir = join(pluginsDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "suvoj-plugin-tracker-"));
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

describe("PluginHost tracker mechanisms", () => {
  it("rejects a multi-request pair declared one without the other", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-lone-build",
      `
export default {
  id: "hosttest-lonebuild",
  name: "Lone Build",
  version: "1.0.0",
  trackerMechanisms: [
    {
      id: "hosttest-lone-build-mech",
      name: "Lone Build",
      buildGenerationMessages: () => [],
      parseResponse: () => ({}),
      buildGenerationRequests: () => [],
    },
  ],
  setup() { return {}; },
};
`,
    );
    writePlugin(
      pluginsDir,
      "02-lone-parse",
      `
export default {
  id: "hosttest-loneparse",
  name: "Lone Parse",
  version: "1.0.0",
  trackerMechanisms: [
    {
      id: "hosttest-lone-parse-mech",
      name: "Lone Parse",
      buildGenerationMessages: () => [],
      parseResponse: () => ({}),
      parseResponses: () => ({}),
    },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    expect(host.list().find((plugin) => plugin.id === "01-lone-build")?.error).toContain(
      "must declare buildGenerationRequests and parseResponses together",
    );
    expect(host.list().find((plugin) => plugin.id === "02-lone-parse")?.error).toContain(
      "must declare buildGenerationRequests and parseResponses together",
    );
  });

  it("rejects a multi-request method that is present but not a function", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-bad-build",
      `
export default {
  id: "hosttest-badbuild",
  name: "Bad Build",
  version: "1.0.0",
  trackerMechanisms: [
    {
      id: "hosttest-bad-build-mech",
      name: "Bad Build",
      buildGenerationMessages: () => [],
      parseResponse: () => ({}),
      buildGenerationRequests: "nope",
      parseResponses: () => ({}),
    },
  ],
  setup() { return {}; },
};
`,
    );
    writePlugin(
      pluginsDir,
      "02-bad-parse",
      `
export default {
  id: "hosttest-badparse",
  name: "Bad Parse",
  version: "1.0.0",
  trackerMechanisms: [
    {
      id: "hosttest-bad-parse-mech",
      name: "Bad Parse",
      buildGenerationMessages: () => [],
      parseResponse: () => ({}),
      buildGenerationRequests: () => [],
      parseResponses: 42,
    },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    expect(host.list().find((plugin) => plugin.id === "01-bad-build")?.error).toContain(
      "buildGenerationRequests must be a function",
    );
    expect(host.list().find((plugin) => plugin.id === "02-bad-parse")?.error).toContain(
      "parseResponses must be a function",
    );
  });

  it("accepts a multi-request pair declared together", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-pair",
      `
export default {
  id: "hosttest-pair",
  name: "Pair Mechanism",
  version: "1.0.0",
  trackerMechanisms: [
    {
      id: "hosttest-pair-mech",
      name: "Pair",
      buildGenerationMessages: () => [],
      parseResponse: () => ({}),
      buildGenerationRequests: (input) => input.parts.map((part) => ({ messages: [{ role: "system", content: "part " + part.index }] })),
      parseResponses: (raws) => ({ merged: raws.length }),
    },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    const entry = host.list().find((plugin) => plugin.id === "hosttest-pair");
    expect(entry?.error).toBeUndefined();
    host.setEnabled("hosttest-pair", true);
    expect(tracker.getTrackerMechanism("hosttest-pair-mech")?.name).toBe("Pair");
  });

  it("rejects a plugin declaring the built-in suvoj-tracker mechanism id", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-reserved-mech",
      `
export default {
  id: "hosttest-reservedmech",
  name: "Reserved Mechanism",
  version: "1.0.0",
  trackerMechanisms: [
    { id: "suvoj-tracker", name: "Fake Suvoj Tracker", buildGenerationMessages: () => [], parseResponse: () => ({}) },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    // Error entry (keyed by folder name — the definition was rejected):
    const entry = host.list().find((plugin) => plugin.id === "01-reserved-mech");
    expect(entry?.error).toContain('"suvoj-tracker"');
    expect(entry?.error).toContain("reserved");
    expect(entry?.loaded).toBe(false);
    // The built-in mechanism is still the very object the registry holds:
    expect(tracker.getTrackerMechanism("suvoj-tracker")?.id).toBe("suvoj-tracker");
  });

  it("registers a valid mechanism while enabled, lists it, and unregisters on disable", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-mech",
      `
export default {
  id: "hosttest-mechplugin",
  name: "Mechanism Plugin",
  version: "1.0.0",
  trackerMechanisms: [
    {
      id: "hosttest-fixture-mech",
      name: "Fixture Mechanism",
      description: "A fixture",
      buildGenerationMessages: () => [{ role: "system", content: "x" }],
      parseResponse: () => ({ ok: true }),
    },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    // Listed with metadata only (no functions in the public shape):
    const listed = host.list().find((plugin) => plugin.id === "hosttest-mechplugin");
    expect(listed?.trackerMechanisms).toEqual([
      { id: "hosttest-fixture-mech", name: "Fixture Mechanism", description: "A fixture" },
    ]);

    // Discovery alone registers nothing; enabling registers; disabling unregisters.
    expect(tracker.getTrackerMechanism("hosttest-fixture-mech")).toBeUndefined();
    host.setEnabled("hosttest-mechplugin", true);
    expect(tracker.getTrackerMechanism("hosttest-fixture-mech")?.name).toBe("Fixture Mechanism");
    host.setEnabled("hosttest-mechplugin", false);
    expect(tracker.getTrackerMechanism("hosttest-fixture-mech")).toBeUndefined();
  });

  it("rejects the activation of a mechanism id another active plugin already registered", () => {
    const { host, pluginsDir } = harness();
    const source = (id: string, name: string) => `
export default {
  id: "${id}",
  name: "${name}",
  version: "1.0.0",
  trackerMechanisms: [
    {
      id: "hosttest-shared-mech",
      name: "Shared ${name}",
      buildGenerationMessages: () => [],
      parseResponse: () => ({}),
    },
  ],
  setup() { return {}; },
};
`;
    writePlugin(pluginsDir, "01-first", source("hosttest-mechfirst", "First"));
    writePlugin(pluginsDir, "02-second", source("hosttest-mechsecond", "Second"));
    host.loadAll();

    host.setEnabled("hosttest-mechfirst", true);
    host.setEnabled("hosttest-mechsecond", true);
    expect(host.list().find((plugin) => plugin.id === "hosttest-mechfirst")?.error).toBeUndefined();
    const second = host.list().find((plugin) => plugin.id === "hosttest-mechsecond");
    expect(second?.error).toContain("hosttest-shared-mech");
    expect(second?.error).toContain("already registered");

    // Freeing the id (disabling the first) lets the second activate:
    host.setEnabled("hosttest-mechfirst", false);
    host.setEnabled("hosttest-mechsecond", false);
    host.setEnabled("hosttest-mechsecond", true);
    expect(
      host.list().find((plugin) => plugin.id === "hosttest-mechsecond")?.error,
    ).toBeUndefined();
    expect(tracker.getTrackerMechanism("hosttest-shared-mech")?.name).toBe("Shared Second");
  });
});

describe("PluginHost drawer tabs", () => {
  it("rejects drawer tabs with reserved ids", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-reserved-tab",
      `
export default {
  id: "hosttest-reservedtab",
  name: "Reserved Tab",
  version: "1.0.0",
  drawerTabs: [{ id: "tracker", label: "Fake Tracker", htmlTemplate: "<p>{{x}}</p>" }],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    const entry = host.list().find((plugin) => plugin.id === "01-reserved-tab");
    expect(entry?.error).toContain('"tracker"');
    expect(entry?.error).toContain("reserved");
    expect(entry?.loaded).toBe(false);
  });

  it("rejects the second plugin claiming an already-contributed tab id", () => {
    const { host, pluginsDir } = harness();
    const source = (id: string, name: string) => `
export default {
  id: "${id}",
  name: "${name}",
  version: "1.0.0",
  drawerTabs: [{ id: "hosttest-shared-tab", label: "Shared ${name}", htmlTemplate: "<p>{{x}}</p>" }],
  setup() { return {}; },
};
`;
    writePlugin(pluginsDir, "01-first", source("hosttest-tabfirst", "First"));
    writePlugin(pluginsDir, "02-second", source("hosttest-tabsecond", "Second"));
    host.loadAll();

    host.setEnabled("hosttest-tabfirst", true);
    host.setEnabled("hosttest-tabsecond", true);
    expect(host.list().find((plugin) => plugin.id === "hosttest-tabfirst")?.error).toBeUndefined();
    const second = host.list().find((plugin) => plugin.id === "hosttest-tabsecond");
    expect(second?.error).toContain("hosttest-shared-tab");
    expect(second?.error).toContain("already contributed");

    // Freeing the id lets the second plugin activate:
    host.setEnabled("hosttest-tabfirst", false);
    host.setEnabled("hosttest-tabsecond", false);
    host.setEnabled("hosttest-tabsecond", true);
    expect(host.list().find((plugin) => plugin.id === "hosttest-tabsecond")?.error).toBeUndefined();
  });

  it("lists drawer tab metadata in the public shape", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-tabs",
      `
export default {
  id: "hosttest-tabsplugin",
  name: "Tabs Plugin",
  version: "1.0.0",
  drawerTabs: [
    { id: "hosttest-tab-a", label: "Tab A", icon: "Sparkles", htmlTemplate: "<p>{{a}}</p>", css: "p{color:red}" },
    { id: "hosttest-tab-b", label: "Tab B", htmlTemplate: "<p>{{b}}</p>" },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    const listed = host.list().find((plugin) => plugin.id === "hosttest-tabsplugin");
    // Metadata only — htmlTemplate/css never leave the host:
    expect(listed?.drawerTabs).toEqual([
      { id: "hosttest-tab-a", label: "Tab A", icon: "Sparkles" },
      { id: "hosttest-tab-b", label: "Tab B" },
    ]);
  });
});

describe("PluginHost panelData", () => {
  /** A chat over the harness repos: persona + character + greeting + user turn. */
  function seedChat(repos: Repos): string {
    const personaId = repos.personas.create({ name: "Rex" }).id;
    const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
    const chat = repos.chats.create({ character_id: characterId, persona_id: personaId });
    repos.messages.insertMessage(chat.id, { role: "assistant", name: "Aria", content: "Hello!" });
    repos.messages.insertMessage(chat.id, { role: "user", content: "Hi Aria" });
    return chat.id;
  }

  it("runs the hook with the chat's context and returns the render envelope", async () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-panel",
      `
export default {
  id: "hosttest-panelplugin",
  name: "Panel Plugin",
  version: "1.0.0",
  drawerTabs: [
    { id: "hosttest-panel-tab", label: "Panel", htmlTemplate: "{{greeting}}", css: ".panel{color:red}" },
  ],
  setup() {
    return {
      onPanelData(event) {
        globalThis.__spy_hosttest_panelplugin = {
          pluginId: event.pluginId,
          chatId: event.chatId,
          tabId: event.tab.id,
          chat: event.chat?.id ?? null,
          character: event.character?.name ?? null,
          persona: event.persona?.name ?? null,
          messages: event.messages.map((m) => ({ role: m.role, name: m.name, content: m.content })),
        };
        return { greeting: "hello from the hook" };
      },
    };
  },
};
`,
    );
    host.loadAll();
    const chatId = seedChat(repos);

    // Disabled plugin: the tab exists but no hook runs — the declared
    // template still ships, around the empty-state data.
    const inert = await host.panelData("hosttest-panelplugin", "hosttest-panel-tab", chatId);
    expect(inert).toEqual({
      ok: true,
      envelope: { htmlTemplate: "{{greeting}}", css: ".panel{color:red}", data: {} },
    });

    host.setEnabled("hosttest-panelplugin", true);
    const result = await host.panelData("hosttest-panelplugin", "hosttest-panel-tab", chatId);
    expect(result).toEqual({
      ok: true,
      envelope: {
        htmlTemplate: "{{greeting}}",
        css: ".panel{color:red}",
        data: { greeting: "hello from the hook" },
      },
    });
    const seen = spy<{
      pluginId: string;
      chatId: string;
      tabId: string;
      chat: string | null;
      character: string | null;
      persona: string | null;
      messages: Array<{ role: string; name?: string; content: string }>;
    }>("hosttest-panelplugin");
    expect(seen?.pluginId).toBe("hosttest-panelplugin");
    expect(seen?.chatId).toBe(chatId);
    expect(seen?.tabId).toBe("hosttest-panel-tab");
    expect(seen?.chat).toBe(chatId);
    expect(seen?.character).toBe("Aria");
    expect(seen?.persona).toBe("Rex");
    // The active-variant history as PromptMessages, oldest first:
    expect(seen?.messages).toEqual([
      { role: "assistant", name: "Aria", content: "Hello!" },
      { role: "user", content: "Hi Aria" },
    ]);
  });

  it("404-shapes unknown plugin, tab, or chat", async () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-panel",
      `
export default {
  id: "hosttest-panel404",
  name: "Panel 404",
  version: "1.0.0",
  drawerTabs: [{ id: "hosttest-tab-404", label: "Panel", htmlTemplate: "<p></p>" }],
  setup() { return {}; },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-panel404", true);
    const chatId = seedChat(repos);

    expect(await host.panelData("ghost", "hosttest-tab-404", chatId)).toEqual({
      ok: false,
      status: 404,
      error: "Plugin not found",
    });
    expect(await host.panelData("hosttest-panel404", "ghost-tab", chatId)).toEqual({
      ok: false,
      status: 404,
      error: "Tab not found",
    });
    expect(await host.panelData("hosttest-panel404", "hosttest-tab-404", "ghost-chat")).toEqual({
      ok: false,
      status: 404,
      error: "Chat not found",
    });
  });

  it("rethrows a throwing hook (the route maps it to 500)", async () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-panel-throw",
      `
export default {
  id: "hosttest-panelthrow",
  name: "Panel Throw",
  version: "1.0.0",
  drawerTabs: [{ id: "hosttest-throw-tab", label: "Panel", htmlTemplate: "<p></p>" }],
  setup() {
    return { onPanelData() { throw new Error("panel boom"); } };
  },
};
`,
    );
    host.loadAll();
    const chatId = seedChat(repos);
    host.setEnabled("hosttest-panelthrow", true);

    await expect(
      host.panelData("hosttest-panelthrow", "hosttest-throw-tab", chatId),
    ).rejects.toThrow("panel boom");
  });
});
