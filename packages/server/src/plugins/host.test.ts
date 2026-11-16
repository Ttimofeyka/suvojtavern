/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatHookBus,
  createRepositories,
  engine,
  migrations,
  openDatabase,
  runMigrations,
  SummaryEventBus,
  wireSummaryCascade,
} from "@suvoj/core";
import {
  type BeforeGenerateEvent,
  PLUGIN_THEME_HEX_TOKENS,
  PLUGIN_THEME_REQUIRED_TOKENS,
  PLUGIN_THEME_RESERVED_IDS,
} from "@suvoj/plugin-sdk";
import type { Repos } from "../routes-deps";
import { controlValuesKey, enabledKey, PluginHost, pluginControlPrefix, settingsKey } from "./host";

/**
 * Loader/host tests. Fixtures are written on the fly into a temp plugins
 * folder — plain definition objects (no SDK import: `definePlugin` is an
 * identity function, so the runtime shape is identical; the real SDK import
 * path is covered by example-plugin.test.ts). Every fixture spies through
 * globalThis, so tests never need to import fixture modules back.
 *
 * Registries are process-global (memory strategies, pipeline stages), so
 * every fixture uses a unique plugin id and hosts are unloaded after each
 * test.
 */

interface Harness {
  host: PluginHost;
  repos: Repos;
  pluginsDir: string;
  /** Isolated summary bus the harness host listens on. */
  summaryEvents: SummaryEventBus;
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
  const summaryBus = new SummaryEventBus();
  const repos = createRepositories(db, bus);
  const pluginsDir = mkdtempSync(join(tmpRoot, "plugins-"));
  const host = new PluginHost({ pluginsDir, repos, hooks: bus, summaryEvents: summaryBus });
  hosts.push(host);
  return { host, repos, pluginsDir, summaryEvents: summaryBus };
}

/** Writes one plugin folder with the given index.ts source. */
function writePlugin(pluginsDir: string, folder: string, source: string): void {
  const dir = join(pluginsDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "suvoj-plugin-host-"));
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

const BASIC_PLUGIN = `
export default {
  id: "hosttest-basic",
  name: "Basic Plugin",
  version: "1.0.0",
  description: "A plain fixture",
  setup() { return {}; },
};
`;

describe("PluginHost discovery", () => {
  it("discovers plugins and lists sanitized entries", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-full",
      `
export default {
  id: "hosttest-full",
  name: "Full Plugin",
  version: "2.3.4",
  description: "Has everything",
  ui: { sidebarItems: [{ label: "Full", href: "/settings#plugins", icon: "Sparkles" }] },
  settings: [
    { key: "on", label: "On", type: "boolean", default: false },
    { key: "note", label: "Note", type: "string", default: "hi" },
  ],
  setup() { return {}; },
};
`,
    );
    writePlugin(pluginsDir, "02-basic", BASIC_PLUGIN);

    host.loadAll();
    const list = host.list();

    expect(list.map((plugin) => plugin.id)).toEqual(["hosttest-basic", "hosttest-full"]);
    const full = list.find((plugin) => plugin.id === "hosttest-full");
    expect(full?.name).toBe("Full Plugin");
    expect(full?.version).toBe("2.3.4");
    expect(full?.description).toBe("Has everything");
    // Freshly discovered plugins ship disabled (opt-in default):
    expect(full?.enabled).toBe(false);
    expect(full?.error).toBeUndefined();
    expect(full?.settingsSchema?.map((field) => field.key)).toEqual(["on", "note"]);
    expect(full?.settings).toEqual({ on: false, note: "hi" });
    expect(full?.ui).toEqual({
      sidebarItems: [{ label: "Full", href: "/settings#plugins", icon: "Sparkles" }],
    });
    const basic = list.find((plugin) => plugin.id === "hosttest-basic");
    expect(basic?.settingsSchema).toBeNull();
    expect(basic?.settings).toBeNull();
    expect(basic?.ui).toBeNull();
  });

  it("treats a missing plugins directory as zero plugins", () => {
    const { host } = harness();
    host.loadAll();
    expect(host.list()).toEqual([]);
  });

  it("accepts a null plugins dir (feature off)", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const host = new PluginHost({ pluginsDir: null, repos: createRepositories(db) });
    hosts.push(host);
    host.loadAll();
    expect(host.list()).toEqual([]);
  });

  it("lists broken plugins as error entries — the server lives on", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-good", BASIC_PLUGIN);
    writePlugin(
      pluginsDir,
      "02-import-throw",
      'throw new Error("kaboom at import");\nexport default {};\n',
    );
    writePlugin(
      pluginsDir,
      "03-bad-id",
      'export default { id: "Bad_ID", name: "Bad", version: "1.0.0", setup() {} };\n',
    );
    writePlugin(
      pluginsDir,
      "04-no-setup",
      'export default { id: "hosttest-nosetup", name: "No Setup", version: "1.0.0" };\n',
    );
    mkdirSync(join(pluginsDir, "05-no-entry"));

    host.loadAll();
    const byFolder = new Map(host.list().map((plugin) => [plugin.id, plugin]));
    expect(byFolder.get("hosttest-basic")?.error).toBeUndefined();

    const importThrow = byFolder.get("02-import-throw");
    expect(importThrow?.error).toContain("kaboom at import");
    expect(importThrow?.enabled).toBe(false);
    expect(importThrow?.settingsSchema).toBeNull();

    expect(byFolder.get("Bad_ID")).toBeUndefined(); // folder name, not the invalid id
    expect(byFolder.get("03-bad-id")?.error).toContain("kebab-case");

    expect(byFolder.get("04-no-setup")?.error).toContain("setup");

    expect(byFolder.get("05-no-entry")?.error).toContain("no entry point");

    // And the healthy plugin still serves hooks:
    host.setEnabled("hosttest-basic", true);
    expect(host.beforeGenerate(messagesEvent([]))).toHaveLength(0);
  });

  it("keeps the first plugin when two folders claim the same id", () => {
    const { host, pluginsDir } = harness();
    const source = (name: string) =>
      `export default { id: "hosttest-dupe", name: "${name}", version: "1.0.0", setup() {} };\n`;
    writePlugin(pluginsDir, "01-first", source("First"));
    writePlugin(pluginsDir, "02-second", source("Second"));

    host.loadAll();
    const list = host.list();
    expect(list.find((plugin) => plugin.id === "hosttest-dupe")?.name).toBe("First");
    const dupes = list.filter((plugin) => plugin.id === "02-second");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.error).toContain("duplicate plugin id");
  });
});

describe("PluginHost enablement", () => {
  it("persists disablement and re-enables on demand", () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-toggle",
      `
export default {
  id: "hosttest-toggle",
  name: "Toggle",
  version: "1.0.0",
  setup() {
    globalThis.__spy_hosttest_toggle = { unloaded: false };
    return { onUnload() { globalThis.__spy_hosttest_toggle.unloaded = true; } };
  },
};
`,
    );
    host.loadAll();

    // Discovered disabled (the default), nothing persisted, setup never ran:
    expect(repos.settings.get(enabledKey("hosttest-toggle"))).toBeNull(); // default, never persisted
    expect(spy("hosttest-toggle")).toBeUndefined();
    expect(host.list().find((plugin) => plugin.id === "hosttest-toggle")?.enabled).toBe(false);

    expect(host.setEnabled("hosttest-toggle", true)).toBe(true);
    expect(repos.settings.get(enabledKey("hosttest-toggle"))).toBe(true);
    expect(host.list().find((plugin) => plugin.id === "hosttest-toggle")?.enabled).toBe(true);

    expect(host.setEnabled("hosttest-toggle", false)).toBe(true);
    expect(repos.settings.get(enabledKey("hosttest-toggle"))).toBe(false);
    expect(spy<{ unloaded: boolean }>("hosttest-toggle")?.unloaded).toBe(true);
    expect(host.list().find((plugin) => plugin.id === "hosttest-toggle")?.enabled).toBe(false);

    host.setEnabled("hosttest-toggle", true);
    expect(repos.settings.get(enabledKey("hosttest-toggle"))).toBe(true);
    expect(host.list().find((plugin) => plugin.id === "hosttest-toggle")?.enabled).toBe(true);

    expect(host.setEnabled("ghost", true)).toBe(false);
  });

  it("keeps a fresh plugin inert until enabled — then disabling makes it inert again", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-fresh",
      `
export default {
  id: "hosttest-fresh",
  name: "Fresh",
  version: "1.0.0",
  memoryStrategies: [
    { id: "hosttest-fresh-strategy", name: "Fresh Strategy", apply: async (history) => ({ history: [...history] }) },
  ],
  pipelineStages: [{ id: "hosttest-fresh-stage", run: async () => {} }],
  setup() {
    globalThis.__spy_hosttest_fresh = { ran: true };
    return {
      onBeforeGenerate(event) {
        return [...event.messages, { role: "system", content: "injected-by-fresh" }];
      },
      onResponse(event) { return event.content + "-fresh"; },
    };
  },
};
`,
    );
    host.loadAll();

    // Listed and loaded (schema/toggle available) but disabled by default:
    const entry = host.list().find((plugin) => plugin.id === "hosttest-fresh");
    expect(entry?.enabled).toBe(false);
    expect(entry?.loaded).toBe(true);

    // Discovery alone activates nothing — no setup, no hooks, no contributions:
    expect(spy("hosttest-fresh")).toBeUndefined();
    expect(engine.getMemoryStrategy("hosttest-fresh-strategy")).toBeUndefined();
    expect(engine.listPipelineStages().some((stage) => stage.id === "hosttest-fresh-stage")).toBe(
      false,
    );
    expect(host.beforeGenerate(messagesEvent([{ role: "user", content: "hello" }]))).toHaveLength(
      1,
    );
    expect(host.response({ chatId: "c", content: "raw", metadata: null })).toBe("raw");

    // Enabling activates it: setup ran, hooks fire, contributions register.
    host.setEnabled("hosttest-fresh", true);
    expect(spy<{ ran: boolean }>("hosttest-fresh")?.ran).toBe(true);
    expect(engine.getMemoryStrategy("hosttest-fresh-strategy")?.name).toBe("Fresh Strategy");
    expect(engine.listPipelineStages().some((stage) => stage.id === "hosttest-fresh-stage")).toBe(
      true,
    );
    expect(
      host
        .beforeGenerate(messagesEvent([{ role: "user", content: "hello" }]))
        .map((message) => message.content),
    ).toEqual(["hello", "injected-by-fresh"]);
    expect(host.response({ chatId: "c", content: "raw", metadata: null })).toBe("raw-fresh");

    // Disabling makes it inert again: contributions gone, hooks silent.
    host.setEnabled("hosttest-fresh", false);
    expect(engine.getMemoryStrategy("hosttest-fresh-strategy")).toBeUndefined();
    expect(engine.listPipelineStages().some((stage) => stage.id === "hosttest-fresh-stage")).toBe(
      false,
    );
    expect(host.response({ chatId: "c", content: "raw", metadata: null })).toBe("raw");
  });

  it("keeps a plugin disabled across hosts (restart semantics)", () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-toggle",
      BASIC_PLUGIN.replace("hosttest-basic", "hosttest-persist"),
    );
    host.loadAll();
    host.setEnabled("hosttest-persist", false);

    const second = new PluginHost({ pluginsDir, repos, hooks: new ChatHookBus() });
    hosts.push(second);
    second.loadAll();
    const entry = second.list().find((plugin) => plugin.id === "hosttest-persist");
    expect(entry?.enabled).toBe(false);
  });

  it("reloads: new folders load, removed ones disappear, edited source re-imports", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-rewrite",
      'export default { id: "hosttest-rewrite", name: "Rewrite", version: "1.0.0", setup() {} };\n',
    );
    host.loadAll();
    expect(host.list().find((plugin) => plugin.id === "hosttest-rewrite")?.version).toBe("1.0.0");

    writePlugin(pluginsDir, "02-added", BASIC_PLUGIN);
    // Same-length-ish rewrite within mtime granularity — the reload nonce
    // must still force a fresh import.
    writePlugin(
      pluginsDir,
      "01-rewrite",
      'export default { id: "hosttest-rewrite", name: "Rewrite", version: "2.0.0", setup() {} };\n',
    );

    host.reloadAll();
    const list = host.list();
    expect(list.find((plugin) => plugin.id === "hosttest-rewrite")?.version).toBe("2.0.0");
    expect(list.find((plugin) => plugin.id === "hosttest-basic")).toBeDefined();

    rmSync(join(pluginsDir, "02-added"), { recursive: true, force: true });
    host.reloadAll();
    expect(host.list().find((plugin) => plugin.id === "hosttest-basic")).toBeUndefined();
  });

  it("a plugin the user enabled stays enabled across reload; new ones start disabled", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-keeper",
      `
export default {
  id: "hosttest-keeper",
  name: "Keeper",
  version: "1.0.0",
  setup() {
    return { onResponse(event) { return event.content + "-kept"; } };
  },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-keeper", true);
    writePlugin(pluginsDir, "02-newcomer", BASIC_PLUGIN);

    host.reloadAll();

    // The explicitly enabled plugin survives the rescan active:
    expect(host.list().find((plugin) => plugin.id === "hosttest-keeper")?.enabled).toBe(true);
    expect(host.response({ chatId: "c", content: "raw", metadata: null })).toBe("raw-kept");
    // The newly discovered plugin starts disabled:
    expect(host.list().find((plugin) => plugin.id === "hosttest-basic")?.enabled).toBe(false);
  });
});

describe("PluginHost settings", () => {
  const SETTINGS_PLUGIN = `
export default {
  id: "hosttest-settings",
  name: "Settings Plugin",
  version: "1.0.0",
  settings: [
    { key: "signature", label: "Signature", type: "boolean", default: false },
    { key: "name", label: "Name", type: "string", default: "anon" },
    { key: "count", label: "Count", type: "number", default: 3, min: 0, max: 10 },
    { key: "style", label: "Style", type: "select", default: "a", options: [
      { label: "A", value: "a" }, { label: "B", value: "b" },
    ] },
  ],
  setup(ctx) {
    globalThis.__spy_hosttest_settings = { read: ctx.settings.all() };
    return {
      onResponse(event) {
        globalThis.__spy_hosttest_settings.seen = ctx.settings.get("signature");
        return event.content;
      },
    };
  },
};
`;

  it("roundtrips settings and exposes defaults through the context", () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-settings", SETTINGS_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-settings", true);

    // Unset → schema defaults.
    expect(host.getSettings("hosttest-settings")).toEqual({
      signature: false,
      name: "anon",
      count: 3,
      style: "a",
    });
    expect(spy<{ read: Record<string, unknown> }>("hosttest-settings")?.read).toEqual({
      signature: false,
      name: "anon",
      count: 3,
      style: "a",
    });

    const result = host.putSettings("hosttest-settings", {
      signature: true,
      name: "real",
      count: 7,
      style: "b",
    });
    expect(result.ok).toBe(true);
    expect(repos.settings.get(settingsKey("hosttest-settings"))).toEqual({
      signature: true,
      name: "real",
      count: 7,
      style: "b",
    });
    expect(host.getSettings("hosttest-settings")).toEqual({
      signature: true,
      name: "real",
      count: 7,
      style: "b",
    });

    // Live read: the hook sees the stored value, not the default.
    host.response({ chatId: "c", content: "x", metadata: null });
    expect(spy<{ seen: unknown }>("hosttest-settings")?.seen).toBe(true);
  });

  it("rejects unknown keys, bad types, bad selects, and out-of-range numbers", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-settings", SETTINGS_PLUGIN);
    host.loadAll();

    const unknown = host.putSettings("hosttest-settings", { nope: 1 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(unknown.details)).toContain("nope");
    }

    const badType = host.putSettings("hosttest-settings", { signature: "yes" });
    expect(badType.ok).toBe(false);
    if (!badType.ok) {
      expect(JSON.stringify(badType.details)).toContain("must be a boolean");
    }

    const badSelect = host.putSettings("hosttest-settings", { style: "c" });
    expect(badSelect.ok).toBe(false);

    const badRange = host.putSettings("hosttest-settings", { count: 99 });
    expect(badRange.ok).toBe(false);
    if (!badRange.ok) {
      expect(JSON.stringify(badRange.details)).toContain("must be <= 10");
    }

    const ghost = host.putSettings("ghost", {});
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) {
      expect(ghost.status).toBe(404);
    }

    // Nothing above was stored:
    expect(host.getSettings("hosttest-settings")).toEqual({
      signature: false,
      name: "anon",
      count: 3,
      style: "a",
    });
  });
});

/** Small helper building a BeforeGenerateEvent with placeholder rows. */
function messagesEvent(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
): BeforeGenerateEvent {
  return {
    chat: { id: "chat" },
    character: { id: "char", name: "Char" },
    persona: null,
    messages: messages.map((message) => ({ ...message })),
    sampling: {},
  } as unknown as BeforeGenerateEvent;
}

describe("PluginHost generation surface", () => {
  it("chains message arrays and reply content through enabled plugins", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-editor",
      `
export default {
  id: "hosttest-editor",
  name: "Editor",
  version: "1.0.0",
  setup() {
    globalThis.__spy_hosttest_editor = { saw: [], deltas: [] };
    return {
      onBeforeGenerate(event) {
        globalThis.__spy_hosttest_editor.saw = event.messages.map((m) => m.content);
        return [...event.messages, { role: "system", content: "injected-by-editor" }];
      },
      onDelta(event) {
        globalThis.__spy_hosttest_editor.deltas.push(event.content);
      },
      onResponse(event) {
        return event.content + "-edited";
      },
    };
  },
};
`,
    );
    writePlugin(
      pluginsDir,
      "02-observer",
      `
export default {
  id: "hosttest-observer",
  name: "Observer",
  version: "1.0.0",
  setup() {
    return {
      onBeforeGenerate(event) {
        globalThis.__spy_hosttest_observer = { saw: event.messages.map((m) => m.content) };
      },
    };
  },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-editor", true);
    host.setEnabled("hosttest-observer", true);

    const messages = host.beforeGenerate(messagesEvent([{ role: "user", content: "hello" }]));
    // The later plugin (observer) saw the editor's injection:
    expect(spy<{ saw: string[] }>("hosttest-observer")?.saw).toEqual([
      "hello",
      "injected-by-editor",
    ]);
    expect(messages.map((message) => message.content)).toEqual(["hello", "injected-by-editor"]);

    // Chained response rewriting:
    expect(host.response({ chatId: "c", content: "raw", metadata: null })).toBe("raw-edited");

    // Fire-and-forget delta observation:
    host.delta({ chatId: "c", content: "chunk" });
    expect(spy<{ deltas: string[] }>("hosttest-editor")?.deltas).toEqual(["chunk"]);
  });

  it("skips throwing hooks — generation never fails because of a plugin", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-thrower",
      `
export default {
  id: "hosttest-thrower",
  name: "Thrower",
  version: "1.0.0",
  setup() {
    return {
      onBeforeGenerate() { throw new Error("before boom"); },
      onResponse() { throw new Error("response boom"); },
      onDelta() { throw new Error("delta boom"); },
    };
  },
};
`,
    );
    writePlugin(pluginsDir, "02-passthrough", BASIC_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-thrower", true);

    const input = [{ role: "user" as const, content: "hello" }];
    const messages = host.beforeGenerate(messagesEvent(input));
    expect(messages).toEqual(input); // unchanged (same content, no injection)
    expect(host.response({ chatId: "c", content: "raw", metadata: null })).toBe("raw");
    expect(() => host.delta({ chatId: "c", content: "chunk" })).not.toThrow();
  });

  it("turns a throwing setup into an error entry and keeps serving", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-setup-throw",
      `
export default {
  id: "hosttest-setupthrow",
  name: "Setup Throw",
  version: "1.0.0",
  setup() { throw new Error("setup boom"); },
};
`,
    );
    writePlugin(pluginsDir, "02-basic", BASIC_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-setupthrow", true);

    const entry = host.list().find((plugin) => plugin.id === "hosttest-setupthrow");
    expect(entry?.error).toContain("setup boom");
    expect(host.response({ chatId: "c", content: "raw", metadata: null })).toBe("raw");
  });
});

describe("PluginHost reserved ids and entry containment", () => {
  it("rejects a plugin declaring a built-in pipeline stage id", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-reserved-stage",
      `
export default {
  id: "hosttest-reservedstage",
  name: "Reserved Stage",
  version: "1.0.0",
  pipelineStages: [{ id: "memory", run: async () => {} }],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    // Error entry (keyed by folder name — the definition was rejected) and
    // it names the reserved id:
    const entry = host.list().find((plugin) => plugin.id === "01-reserved-stage");
    expect(entry?.error).toContain('"memory"');
    expect(entry?.error).toContain("reserved");
    expect(entry?.loaded).toBe(false);
    // The built-in stage was never appended next to:
    expect(engine.listPipelineStages().filter((stage) => stage.id === "memory")).toHaveLength(1);
  });

  it("rejects a plugin declaring a built-in memory strategy id", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-reserved-strategy",
      `
export default {
  id: "hosttest-reservedstrategy",
  name: "Reserved Strategy",
  version: "1.0.0",
  memoryStrategies: [
    { id: "trim", name: "Fake Trim", apply: async (history) => ({ history: [...history] }) },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();

    const entry = host.list().find((plugin) => plugin.id === "01-reserved-strategy");
    expect(entry?.error).toContain('"trim"');
    expect(entry?.error).toContain("reserved");
    expect(entry?.loaded).toBe(false);
    // The built-in strategy is still the very object the engine registered:
    expect(engine.getMemoryStrategy("trim")).toBe(engine.trimStrategy);
  });

  it("keeps the built-ins intact through a failed load and its unload", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-reserved-strategy",
      `
export default {
  id: "hosttest-reservedsurvivor",
  name: "Reserved Survivor",
  version: "1.0.0",
  memoryStrategies: [
    { id: "trim", name: "Fake Trim", apply: async (history) => ({ history: [...history] }) },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();
    host.unloadAll();

    // A preset selecting "trim" still finds the built-in — the failed entry
    // never registered anything, so unloading it removed nothing.
    expect(engine.getMemoryStrategy("trim")).toBe(engine.trimStrategy);
    expect(engine.getMemoryStrategy("summaries")).toBe(engine.summariesStrategy);
    const stageIds = engine.listPipelineStages().map((stage) => stage.id);
    for (const id of ["lorebook", "memory", "persona", "history"]) {
      expect(stageIds).toContain(id);
    }
    // And the generation surface keeps serving:
    expect(host.response({ chatId: "c", content: "raw", metadata: null })).toBe("raw");
  });

  it("rejects a package.json main that escapes the plugin folder", () => {
    const { host, pluginsDir } = harness();
    // A real, loadable module sitting OUTSIDE the plugins dir the main
    // points at — containment must reject it before anything is required.
    const outside = join(tmpRoot, "hosttest-outside.ts");
    writeFileSync(
      outside,
      'export default { id: "hosttest-escape", name: "Escape", version: "1.0.0", setup() {} };\n',
    );
    const dir = join(pluginsDir, "01-escape");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "../../hosttest-outside.ts" }));

    host.loadAll();

    const entry = host.list().find((plugin) => plugin.id === "01-escape");
    expect(entry?.error).toContain("inside the plugin folder");
    expect(entry?.loaded).toBe(false);
    // The outside module never ran — its plugin id appears nowhere:
    expect(host.list().find((plugin) => plugin.id === "hosttest-escape")).toBeUndefined();
  });
});

describe("PluginHost contributions", () => {
  it("registers and unregisters memory strategies and pipeline stages", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-contrib",
      `
export default {
  id: "hosttest-contrib",
  name: "Contributor",
  version: "1.0.0",
  memoryStrategies: [
    { id: "hosttest-strategy", name: "Fixture Strategy", apply: async (history) => ({ history: [...history] }) },
  ],
  pipelineStages: [{ id: "hosttest-stage", run: async () => {} }],
  setup() { return {}; },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-contrib", true);

    expect(engine.getMemoryStrategy("hosttest-strategy")?.name).toBe("Fixture Strategy");
    expect(engine.listPipelineStages().some((stage) => stage.id === "hosttest-stage")).toBe(true);

    host.setEnabled("hosttest-contrib", false);
    expect(engine.getMemoryStrategy("hosttest-strategy")).toBeUndefined();
    expect(engine.listPipelineStages().some((stage) => stage.id === "hosttest-stage")).toBe(false);
  });

  it("routes chat lifecycle events through onChatEvent (and isolates throwers)", () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-throwing-chat",
      `
export default {
  id: "hosttest-throwchat",
  name: "Throwing Chat",
  version: "1.0.0",
  setup() {
    return { onChatEvent() { throw new Error("chat boom"); } };
  },
};
`,
    );
    writePlugin(
      pluginsDir,
      "02-chat-spy",
      `
export default {
  id: "hosttest-chatspy",
  name: "Chat Spy",
  version: "1.0.0",
  setup() {
    globalThis.__spy_hosttest_chatspy = { events: [] };
    return {
      onChatEvent(event) { globalThis.__spy_hosttest_chatspy.events.push(event.event); },
    };
  },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-throwchat", true);
    host.setEnabled("hosttest-chatspy", true);

    const characterId = repos.characters.create({ name: "Hosty" }).id;
    const chat = repos.chats.create({ character_id: characterId });
    const message = repos.messages.insertMessage(chat.id, { role: "user", content: "hi" });
    repos.messages.editMessageContent(message.id, "edited");
    repos.messages.deleteMessage(message.id);

    expect(spy<{ events: string[] }>("hosttest-chatspy")?.events).toEqual([
      "beforeInsert",
      "afterInsert",
      "beforeEdit",
      "afterEdit",
      "beforeDelete",
      "afterDelete",
    ]);
  });
});

describe("PluginHost summary events", () => {
  /**
   * The cascade wiring coalesces deletions into microtask batches — the
   * lifecycle event lands one microtask after the deleting call returns,
   * so the tests await a tick before asserting.
   */
  const flushCascade = async (): Promise<void> => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  };

  it("forwards summary lifecycle events to active plugins, isolating throwers and skipping disabled ones", () => {
    const { host, summaryEvents, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-sum-thrower",
      `
export default {
  id: "hosttest-sumthrower",
  name: "Sum Thrower",
  version: "1.0.0",
  setup() {
    return { onSummariesChanged() { throw new Error("sum boom"); } };
  },
};
`,
    );
    writePlugin(
      pluginsDir,
      "02-sum-spy",
      `
export default {
  id: "hosttest-sumspy",
  name: "Sum Spy",
  version: "1.0.0",
  setup() {
    globalThis.__spy_hosttest_sumspy = { seen: [] };
    return {
      onSummariesChanged(event) { globalThis.__spy_hosttest_sumspy.seen.push(event); },
    };
  },
};
`,
    );
    writePlugin(
      pluginsDir,
      "03-sum-off",
      `
export default {
  id: "hosttest-sumoff",
  name: "Sum Off",
  version: "1.0.0",
  setup() {
    globalThis.__spy_hosttest_sumoff = { seen: [] };
    return {
      onSummariesChanged(event) { globalThis.__spy_hosttest_sumoff.seen.push(event); },
    };
  },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-sumthrower", true);
    host.setEnabled("hosttest-sumspy", true);
    // 03-sum-off stays disabled (the opt-in default) — it must see nothing.

    const deleted = {
      id: "s1",
      chat_id: "c1",
      level: 0,
      seq_from: 1,
      seq_to: 4,
      summary: "gone",
      tokens: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    expect(() =>
      summaryEvents.emit({ chatId: "c1", created: [], deleted: [deleted], unhiddenSeqs: [2, 3] }),
    ).not.toThrow();

    // The thrower was logged and skipped; the spy still got the event.
    expect(spy<{ seen: unknown[] }>("hosttest-sumspy")?.seen).toEqual([
      { chatId: "c1", created: [], deleted: [deleted], unhiddenSeqs: [2, 3] },
    ]);
    expect(spy<{ seen: unknown[] }>("hosttest-sumoff")?.seen).toBeUndefined();
  });

  it("end-to-end: deleting a covered message reaches plugins through the cascade", async () => {
    // Production-shaped wiring on the default buses — the same
    // composition createApp builds: repos cascade → summary bus → host.
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    wireSummaryCascade({ db, repos });
    const pluginsDir = mkdtempSync(join(tmpRoot, "plugins-"));
    const host = new PluginHost({ pluginsDir, repos });
    hosts.push(host);
    writePlugin(
      pluginsDir,
      "01-e2e-sum",
      `
export default {
  id: "hosttest-e2esum",
  name: "E2E Sum",
  version: "1.0.0",
  setup() {
    globalThis.__spy_hosttest_e2esum = { events: [] };
    return {
      onSummariesChanged(event) {
        globalThis.__spy_hosttest_e2esum.events.push({
          deleted: event.deleted.map((row) => row.seq_from),
          unhiddenSeqs: [...event.unhiddenSeqs],
        });
      },
    };
  },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-e2esum", true);

    const characterId = repos.characters.create({ name: "E2E" }).id;
    const chatId = repos.chats.create({ character_id: characterId }).id;
    for (let i = 0; i < 10; i++) {
      repos.messages.insertMessage(chatId, { role: "user", content: `m${i + 1}` });
    }
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 6,
      summary: "covers 1-6",
      tokens: null,
    });

    const doomed = repos.messages.listAll(chatId).find((message) => message.seq === 4);
    if (!doomed) {
      throw new Error("fixture message missing");
    }
    repos.messages.deleteMessage(doomed.id);
    await flushCascade();

    // The summary covering position 4 died with it, un-hiding the other
    // covered positions (4 itself is gone, so it never comes back).
    expect(
      spy<{ events: Array<{ deleted: number[]; unhiddenSeqs: number[] }> }>("hosttest-e2esum")
        ?.events,
    ).toEqual([{ deleted: [1], unhiddenSeqs: [1, 2, 3, 5, 6] }]);
  });

  it("serves hiddenSeqs — positions covered by summaries — in panel data", async () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-panel",
      `
      export default {
        id: "hosttest-panel",
        name: "Panel",
        version: "1.0.0",
        drawerTabs: [{ id: "tab", label: "Tab", htmlTemplate: "hidden: {{hiddenSeqs.length}}" }],
        setup() {
          globalThis.__spy_hosttest_panel = { hiddenSeqs: null };
          return {
            onPanelData(event) {
              globalThis.__spy_hosttest_panel.hiddenSeqs = event.hiddenSeqs;
              return {};
            },
          };
        },
      };
      `,
    );
    host.loadAll();
    host.setEnabled("hosttest-panel", true);

    const characterId = repos.characters.create({ name: "Pan" }).id;
    const chat = repos.chats.create({ character_id: characterId });
    for (let i = 0; i < 10; i++) {
      repos.messages.insertMessage(chat.id, { role: "user", content: `m${i + 1}` });
    }
    repos.summaries.create(chat.id, {
      level: 0,
      seq_from: 1,
      seq_to: 6,
      summary: "covers 1-6",
      tokens: null,
    });

    const result = await host.panelData("hosttest-panel", "tab", chat.id);
    expect(result.ok).toBe(true);
    expect(spy<{ hiddenSeqs: number[] }>("hosttest-panel")?.hiddenSeqs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("serves hiddenSeqs by row coverage — a mid-gap hole is not hidden", async () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-panel",
      `
      export default {
        id: "hosttest-panel",
        name: "Panel",
        version: "1.0.0",
        drawerTabs: [{ id: "tab", label: "Tab", htmlTemplate: "hidden: {{hiddenSeqs.length}}" }],
        setup() {
          globalThis.__spy_hosttest_panel = { hiddenSeqs: null };
          return {
            onPanelData(event) {
              globalThis.__spy_hosttest_panel.hiddenSeqs = event.hiddenSeqs;
              return {};
            },
          };
        },
      };
      `,
    );
    host.loadAll();
    host.setEnabled("hosttest-panel", true);

    // The reviewer's repro, post-cascade: [1-4] and [9-12] survive a
    // mid-range deletion that took [5-8] with message 6 — 5, 7, 8 have
    // nothing covering them and must NOT ride hiddenSeqs (a scalar
    // frontier would have hidden 1–12 wholesale).
    const characterId = repos.characters.create({ name: "Pan" }).id;
    const chat = repos.chats.create({ character_id: characterId });
    for (let i = 0; i < 12; i++) {
      repos.messages.insertMessage(chat.id, { role: "user", content: `m${i + 1}` });
    }
    repos.summaries.create(chat.id, {
      level: 0,
      seq_from: 1,
      seq_to: 4,
      summary: "covers 1-4",
      tokens: null,
    });
    repos.summaries.create(chat.id, {
      level: 0,
      seq_from: 9,
      seq_to: 12,
      summary: "covers 9-12",
      tokens: null,
    });

    const result = await host.panelData("hosttest-panel", "tab", chat.id);
    expect(result.ok).toBe(true);
    expect(spy<{ hiddenSeqs: number[] }>("hosttest-panel")?.hiddenSeqs).toEqual([
      1, 2, 3, 4, 9, 10, 11, 12,
    ]);
  });
});

describe("PluginHost themes and global CSS", () => {
  /**
   * A full valid `vars` map: every required token present, a concrete hex
   * for the three surface tokens (the web client's WCAG contrast math reads
   * those out of the computed style), and an arbitrary CSS value for the
   * rest. Derived from the SDK constants so the fixtures track the contract.
   */
  const validVars = (): Record<string, string> => {
    const vars: Record<string, string> = {};
    for (const token of PLUGIN_THEME_REQUIRED_TOKENS) {
      vars[token] = PLUGIN_THEME_HEX_TOKENS.includes(token) ? "#123456" : "oklch(0.5 0.1 200)";
    }
    return vars;
  };

  /** One fixture theme with a valid shape, plus overrides. */
  const themeDef = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: "hosttest-theme",
    name: "Fixture Theme",
    kind: "dark",
    vars: validVars(),
    ...overrides,
  });

  /** A valid plugin definition contributing one theme of id `themeId`. */
  const themePlugin = (id: string, themeId: string, globalCss?: string): string => `
export default {
  id: "${id}",
  name: "${id}",
  version: "1.0.0",
  themes: ${JSON.stringify([themeDef({ id: themeId })])},${
    globalCss === undefined ? "" : `\n  globalCss: ${JSON.stringify(globalCss)},`
  }
  setup() { return {}; },
};
`;

  it("lists a contributed theme (full vars) and global CSS", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-theme",
      themePlugin("hosttest-theme", "hosttest-theme-palette", "body { color: red; }"),
    );
    host.loadAll();

    const entry = host.list().find((plugin) => plugin.id === "hosttest-theme");
    expect(entry?.loaded).toBe(true);
    expect(entry?.error).toBeUndefined();
    expect(entry?.themes).toEqual([
      { id: "hosttest-theme-palette", name: "Fixture Theme", kind: "dark", vars: validVars() },
    ]);
    expect(entry?.globalCss).toBe("body { color: red; }");

    // A plugin declaring neither exposes neither field:
    writePlugin(pluginsDir, "02-basic", BASIC_PLUGIN);
    host.reloadAll();
    const basic = host.list().find((plugin) => plugin.id === "hosttest-basic");
    expect(basic?.themes).toBeUndefined();
    expect(basic?.globalCss).toBeUndefined();
  });

  it("rejects malformed themes and global CSS with precise messages", () => {
    const { host, pluginsDir } = harness();
    const withoutAccent = Object.fromEntries(
      Object.entries(validVars()).filter(([token]) => token !== "--accent"),
    );
    const cases: Array<{ folder: string; fields: string; phrases: string[] }> = [
      {
        folder: "01-reserved-id",
        fields: `  themes: ${JSON.stringify([themeDef({ id: "midnight" })])},`,
        phrases: ['"midnight"', "reserved"],
      },
      {
        folder: "02-missing-token",
        fields: `  themes: ${JSON.stringify([themeDef({ vars: withoutAccent })])},`,
        phrases: ['missing required token "--accent"'],
      },
      {
        folder: "03-bg-not-hex",
        fields: `  themes: ${JSON.stringify([
          themeDef({ vars: { ...validVars(), "--bg": "linear-gradient(#000, #fff)" } }),
        ])},`,
        phrases: ["#rrggbb"],
      },
      {
        // The common `bg` typo: the browser would silently drop the property.
        folder: "04-key-without-prefix",
        fields: `  themes: ${JSON.stringify([
          themeDef({ vars: { ...validVars(), bg: "#123456" } }),
        ])},`,
        phrases: ["CSS custom property name"],
      },
      {
        folder: "05-duplicate-id",
        fields: `  themes: ${JSON.stringify([
          themeDef({ id: "hosttest-dupe" }),
          themeDef({ id: "hosttest-dupe" }),
        ])},`,
        phrases: ["declared twice"],
      },
      {
        folder: "06-bad-kind",
        fields: `  themes: ${JSON.stringify([themeDef({ kind: "dim" })])},`,
        phrases: ['"dark" or "light"'],
      },
      {
        folder: "07-non-string-var",
        fields: `  themes: ${JSON.stringify([themeDef({ vars: { ...validVars(), "--fg": 123 } })])},`,
        phrases: ['vars["--fg"] must be a string'],
      },
      {
        folder: "08-bad-globalcss",
        fields: "  globalCss: 123,",
        phrases: ["globalCss must be a string"],
      },
      {
        folder: "09-bad-theme-id",
        fields: `  themes: ${JSON.stringify([themeDef({ id: "My_Theme" })])},`,
        phrases: ["kebab-case"],
      },
      {
        // Every var ships in GET /api/plugins — a runaway value must not
        // bloat every client response.
        folder: "10-var-too-long",
        fields: `  themes: ${JSON.stringify([
          themeDef({ vars: { ...validVars(), "--fg": "x".repeat(8193) } }),
        ])},`,
        phrases: ['vars["--fg"] must be shorter than 8192 characters'],
      },
      {
        // "" is a mistake, not a palette: the property would register empty.
        folder: "11-empty-var",
        fields: `  themes: ${JSON.stringify([
          themeDef({ vars: { ...validVars(), "--fg": "" } }),
        ])},`,
        phrases: ['vars["--fg"] must not be an empty string'],
      },
      {
        // Same response-bloat concern for the whole stylesheet.
        folder: "12-globalcss-too-long",
        fields: `  globalCss: "x".repeat(65537),`,
        phrases: ["globalCss must be shorter than 65536 characters"],
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      writePlugin(
        pluginsDir,
        testCase.folder,
        `
export default {
  id: "hosttest-themebad-${index}",
  name: "Bad Theme",
  version: "1.0.0",
${testCase.fields}
  setup() { return {}; },
};
`,
      );
    }

    host.loadAll();
    for (const testCase of cases) {
      // Rejected definitions key their error entry by folder name.
      const entry = host.list().find((plugin) => plugin.id === testCase.folder);
      expect(entry?.loaded).toBe(false);
      for (const phrase of testCase.phrases) {
        expect(entry?.error).toContain(phrase);
      }
    }
  });

  it("re-enabling an active theme-only plugin is a no-op — it does not poison itself", () => {
    const { host, pluginsDir } = harness();
    // The reference plugins/theme-plugin shape: a UI-only contribution whose
    // `setup` returns nothing, so `hooks` stays null and `activate`'s guard
    // cannot short-circuit a redundant enable.
    writePlugin(
      pluginsDir,
      "01-theme",
      `
export default {
  id: "hosttest-themeonly",
  name: "Theme Only",
  version: "1.0.0",
  themes: ${JSON.stringify([themeDef({ id: "hosttest-theme-only-palette" })])},
  setup() { return undefined; },
};
`,
    );
    host.loadAll();

    expect(host.setEnabled("hosttest-themeonly", true)).toBe(true);
    // PATCH { enabled: true } on an already-enabled plugin — must not re-run
    // contributionIssue against the plugin's own id.
    expect(host.setEnabled("hosttest-themeonly", true)).toBe(true);

    const entry = host.list().find((plugin) => plugin.id === "hosttest-themeonly");
    expect(entry?.enabled).toBe(true);
    expect(entry?.error).toBeUndefined();
    // Still contributed (the web client drops themes of an errored plugin):
    expect(entry?.themes?.map((theme) => theme.id)).toEqual(["hosttest-theme-only-palette"]);
  });

  it("re-enabling an active drawer-tab-only plugin is a no-op too (shared root cause)", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-tab",
      `
export default {
  id: "hosttest-tabonly",
  name: "Tab Only",
  version: "1.0.0",
  drawerTabs: [{ id: "tab", label: "Tab", htmlTemplate: "hi" }],
  setup() { return undefined; },
};
`,
    );
    host.loadAll();

    expect(host.setEnabled("hosttest-tabonly", true)).toBe(true);
    expect(host.setEnabled("hosttest-tabonly", true)).toBe(true);

    const entry = host.list().find((plugin) => plugin.id === "hosttest-tabonly");
    expect(entry?.enabled).toBe(true);
    expect(entry?.error).toBeUndefined();
    expect(entry?.drawerTabs?.map((tab) => tab.id)).toEqual(["tab"]);
  });

  it("rejects a second plugin claiming an already-contributed theme id", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-first", themePlugin("hosttest-themefirst", "shared-theme"));
    writePlugin(pluginsDir, "02-second", themePlugin("hosttest-themesecond", "shared-theme"));
    host.loadAll();

    expect(host.setEnabled("hosttest-themefirst", true)).toBe(true);
    expect(host.setEnabled("hosttest-themesecond", true)).toBe(true);

    const first = host.list().find((plugin) => plugin.id === "hosttest-themefirst");
    expect(first?.error).toBeUndefined();
    const second = host.list().find((plugin) => plugin.id === "hosttest-themesecond");
    expect(second?.error).toContain("already contributed");
    // Among healthy plugins the id is contributed exactly once:
    const contributed = host
      .list()
      .filter((plugin) => plugin.error === undefined)
      .flatMap((plugin) => plugin.themes ?? []);
    expect(contributed.filter((theme) => theme.id === "shared-theme")).toHaveLength(1);
  });

  it("releases a theme id at deactivation — another plugin can then claim it", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-a", themePlugin("hosttest-themea", "shared-theme"));
    writePlugin(pluginsDir, "02-b", themePlugin("hosttest-themeb", "shared-theme"));
    host.loadAll();

    expect(host.setEnabled("hosttest-themea", true)).toBe(true);
    // B collides while A holds the id:
    host.setEnabled("hosttest-themeb", true);
    expect(host.list().find((plugin) => plugin.id === "hosttest-themeb")?.error).toContain(
      "already contributed",
    );

    // Disabling A runs its guarded disposer, releasing the id...
    host.setEnabled("hosttest-themea", false);
    // ...so B activates cleanly now — proving the id is scoped to activation.
    host.setEnabled("hosttest-themeb", true);
    const b = host.list().find((plugin) => plugin.id === "hosttest-themeb");
    expect(b?.error).toBeUndefined();
  });

  it("reclaims a theme id after its holder is disabled (unload path)", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-holder", themePlugin("hosttest-themeholder", "shared-theme"));
    writePlugin(pluginsDir, "02-reclaimer", themePlugin("hosttest-themereclaim", "shared-theme"));
    host.loadAll();

    host.setEnabled("hosttest-themeholder", true);
    host.setEnabled("hosttest-themeholder", false);
    // The holder's disposer released the id, so the other plugin can claim it:
    expect(host.setEnabled("hosttest-themereclaim", true)).toBe(true);
    expect(
      host.list().find((plugin) => plugin.id === "hosttest-themereclaim")?.error,
    ).toBeUndefined();
  });
});

describe("PluginHost controls", () => {
  /** A plugin declaring one select and one toggle control. */
  const CONTROLS_PLUGIN = `
export default {
  id: "hosttest-controls",
  name: "Controls Plugin",
  version: "1.0.0",
  controls: [
    {
      id: "verbosity",
      label: "Verbosity",
      description: "How chatty",
      type: "select",
      default: "balanced",
      options: [
        { id: "terse", label: "Terse", value: "be terse" },
        { id: "balanced", label: "Balanced", value: "balanced detail" },
        { id: "rich", label: "Rich" },
      ],
    },
    {
      id: "signoff",
      label: "Sign off",
      type: "toggle",
      default: "off",
      options: [
        { id: "on", label: "On", value: "signed" },
        { id: "off", label: "Off" },
      ],
    },
  ],
  setup(ctx) {
    globalThis.__spy_hosttest_controls = {
      atSetup: ctx.controls.all(),
      get: ctx.controls.get("verbosity"),
      changes: [],
      setResult: null,
    };
    return {
      onControlChange(event) {
        globalThis.__spy_hosttest_controls.changes.push({
          source: event.source,
          ownerId: event.ownerId,
          controlId: event.controlId,
          value: event.value,
          merged: event.values["plugin:hosttest-controls:verbosity"],
        });
      },
      onBeforeGenerate(event) {
        globalThis.__spy_hosttest_controls.seen = event.controls;
      },
      // The writer hook: exercises ctx.controls.set end to end, including its
      // re-entrant onControlChange notification.
      onResponse(event) {
        try {
          ctx.controls.set("verbosity", "rich");
          globalThis.__spy_hosttest_controls.setResult = "ok";
        } catch (err) {
          globalThis.__spy_hosttest_controls.setResult = String(err);
        }
        return event.content;
      },
    };
  },
};
`;

  const spyControls = () =>
    spy<{
      atSetup: Record<string, string>;
      get: string | null;
      changes: Array<Record<string, unknown>>;
      seen?: Record<string, string>;
      setResult: string | null;
    }>("hosttest-controls");

  it("lists control declarations and resolved values, and reads them via ctx", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.loadAll();

    const entry = host.list().find((plugin) => plugin.id === "hosttest-controls");
    expect(entry?.controls?.map((control) => control.id)).toEqual(["verbosity", "signoff"]);
    // No stored choice → the declared defaults.
    expect(entry?.controlValues).toEqual({ verbosity: "balanced", signoff: "off" });

    // A plugin without controls exposes neither field:
    writePlugin(pluginsDir, "02-basic", BASIC_PLUGIN);
    host.reloadAll();
    const basic = host.list().find((plugin) => plugin.id === "hosttest-basic");
    expect(basic?.controls).toBeUndefined();
    expect(basic?.controlValues).toBeNull();
  });

  it("resolves stored values tolerantly and exposes the merged map", () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-controls", true);
    expect(spyControls()?.get).toBe("balanced");

    // A garbage stored value must not throw; the declaration's default wins.
    repos.settings.set(controlValuesKey("hosttest-controls"), {
      verbosity: "ghost",
      signoff: 123,
      unknown: "x",
    });
    expect(spyControls()?.atSetup).toBeDefined();
    const merged = host.mergedControlValues();
    expect(merged).toEqual({
      "plugin:hosttest-controls:verbosity": "balanced detail",
      "plugin:hosttest-controls:signoff": "Off",
    });

    // A real choice resolves and reaches the macro text (value over label).
    const result = host.putControlValues("hosttest-controls", { verbosity: "rich" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.controlValues).toEqual({ verbosity: "rich", signoff: "off" });
    }
    expect(host.mergedControlValues()[`${pluginControlPrefix("hosttest-controls")}verbosity`]).toBe(
      "Rich",
    );
  });

  it("a preset control and a plugin control coexist in the merged map", () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-controls", true);
    repos.presets.create({
      name: "P",
      settings: {
        controls: [
          {
            id: "pov",
            options: [
              { id: "first", label: "First", value: "first person" },
              { id: "third", label: "Third", value: "third person" },
            ],
          },
        ],
        control_values: { pov: "first" },
      },
    });
    // The preset half only appears when the resolved preset is passed.
    const withPreset = host.mergedControlValues(engine.loadPreset(repos));
    expect(withPreset.pov).toBe("first person");
    expect(withPreset["plugin:hosttest-controls:verbosity"]).toBe("balanced detail");
    // The plugin half (no preset) never carries a bare preset id.
    expect(host.mergedControlValues().pov).toBeUndefined();
  });

  it("putControlValues validates and 400s on unknown controls/options", () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.loadAll();

    expect(host.putControlValues("ghost", { verbosity: "rich" })).toMatchObject({
      ok: false,
      status: 404,
    });

    const unknownControl = host.putControlValues("hosttest-controls", { nope: "rich" });
    expect(unknownControl.ok).toBe(false);
    if (!unknownControl.ok) {
      expect(unknownControl.status).toBe(400);
      expect(unknownControl.details).toEqual([{ path: "nope", message: "Unknown control" }]);
    }

    const unknownOption = host.putControlValues("hosttest-controls", { verbosity: "ghost" });
    expect(unknownOption.ok).toBe(false);
    if (!unknownOption.ok) {
      expect(JSON.stringify(unknownOption.details)).toContain("expected one of");
    }

    // Nothing was persisted by the failed writes:
    expect(repos.settings.get(controlValuesKey("hosttest-controls"))).toBeNull();
  });

  it("a schema-less plugin 400s on controls; unknown values never throw", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-basic", BASIC_PLUGIN);
    host.loadAll();
    const result = host.putControlValues("hosttest-basic", { x: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("no controls");
    }
  });

  it("fires onControlChange on a settings write and on ctx.controls.set", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-controls", true);

    // The settings route's write path:
    expect(host.putControlValues("hosttest-controls", { signoff: "on" }).ok).toBe(true);
    const changes = spyControls()?.changes ?? [];
    expect(changes.at(-1)).toMatchObject({
      source: "plugin",
      ownerId: "hosttest-controls",
      controlId: "signoff",
      value: "on",
      // The merged map is recomputed after the write, so `values` reflects it.
      merged: "balanced detail",
    });

    // `ctx.controls.set` from inside a hook: the write persists and notifies.
    host.response({ chatId: "c", content: "raw", metadata: null });
    expect(spyControls()?.setResult).toBe("ok");
    const afterSet = spyControls()?.changes ?? [];
    expect(afterSet.at(-1)).toMatchObject({ controlId: "verbosity", value: "rich" });
  });

  it("a throwing onControlChange handler is logged and skipped", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-changethrow",
      `
export default {
  id: "hosttest-changethrow",
  name: "Change Thrower",
  version: "1.0.0",
  controls: [
    { id: "x", label: "X", type: "select", default: "a", options: [{ id: "a" }, { id: "b" }] },
  ],
  setup() {
    return { onControlChange() { throw new Error("change boom"); } };
  },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-changethrow", true);
    // The throw is isolated — the write path reports success.
    expect(() => host.putControlValues("hosttest-changethrow", { x: "b" })).not.toThrow();
    expect(host.putControlValues("hosttest-changethrow", { x: "a" }).ok).toBe(true);
  });

  it("observes a preset control change through controlChanged", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-controls", true);

    host.controlChanged({
      source: "preset",
      ownerId: "some-preset",
      controlId: "pov",
      value: "third",
      values: { pov: "third person" },
    });
    expect(spyControls()?.changes.at(-1)).toMatchObject({
      source: "preset",
      ownerId: "some-preset",
      controlId: "pov",
      value: "third",
    });
  });

  it("carries the merged control map on BeforeGenerateEvent and panel data", async () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-controls", true);

    host.putControlValues("hosttest-controls", { verbosity: "terse" });
    const event = messagesEvent([{ role: "user", content: "hi" }]);
    host.beforeGenerate({
      ...event,
      controls: host.mergedControlValues(engine.loadPreset(repos)),
    });
    expect(spyControls()?.seen?.["plugin:hosttest-controls:verbosity"]).toBe("be terse");

    // Panel data exposes the same map:
    writePlugin(
      pluginsDir,
      "02-panel",
      `
export default {
  id: "hosttest-controlpanel",
  name: "Control Panel",
  version: "1.0.0",
  drawerTabs: [{ id: "tab", label: "Tab", htmlTemplate: "x" }],
  setup() {
    return {
      onPanelData(event) {
        globalThis.__spy_hosttest_controlpanel = { controls: event.controls };
        return {};
      },
    };
  },
};
`,
    );
    host.reloadAll();
    host.setEnabled("hosttest-controlpanel", true);
    const characterId = repos.characters.create({ name: "C" }).id;
    const chat = repos.chats.create({ character_id: characterId });
    const result = await host.panelData("hosttest-controlpanel", "tab", chat.id);
    expect(result.ok).toBe(true);
    const panel = spy<{ controls: Record<string, string> }>("hosttest-controlpanel");
    expect(panel?.controls["plugin:hosttest-controls:verbosity"]).toBe("be terse");
  });

  it("never puts undefined into the merged map when an option omits a label", () => {
    const { host, pluginsDir } = harness();
    // `label` is legitimately OPTIONAL on a declaration — the loader rejects
    // only a PRESENT non-string — so a display-text fallback that compares
    // `chosen.label !== ""` directly would store `undefined` into the
    // `Record<string, string>` map (JSON then drops the key and plugin code
    // calling `.toUpperCase()` throws inside a swallowed hook).
    writePlugin(
      pluginsDir,
      "01-unlabeled",
      `
export default {
  id: "hosttest-unlabeled",
  name: "Unlabeled Options",
  version: "1.0.0",
  controls: [
    { id: "tone", label: "Tone", type: "select", default: "plain",
      options: [{ id: "plain" }, { id: "loud" }] },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-unlabeled", true);

    const merged = host.mergedControlValues();
    expect(merged["plugin:hosttest-unlabeled:tone"]).toBe("plain");
    // Every value is a real string, and survives serialization (the route
    // serves this map as JSON).
    for (const value of Object.values(merged)) {
      expect(typeof value).toBe("string");
    }
    expect(JSON.parse(JSON.stringify(merged))["plugin:hosttest-unlabeled:tone"]).toBe("plain");
  });

  it("putControlValues still succeeds when the default preset row is corrupt", () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-controls", CONTROLS_PLUGIN);
    host.loadAll();
    host.setEnabled("hosttest-controls", true);

    // A row the engine rejects (`prompts` entry without an `id`); the public
    // PATCH route creates exactly this, and migration 003 leaves it as-is.
    // `loadPreset` throws a ZodError on it — the plugin routes must degrade to
    // their plugin half rather than 500 after a durable write.
    repos.presets.create({ name: "Corrupt", prompts: [{ name: "no id" }] });
    expect(() => engine.loadPreset(repos)).toThrow();

    expect(() => host.putControlValues("hosttest-controls", { verbosity: "rich" })).not.toThrow();
    const result = host.putControlValues("hosttest-controls", { verbosity: "terse" });
    expect(result.ok).toBe(true);
    // The write persisted despite the unreadable preset. `terse.value` is set
    // (not just label/id), so the merged value is still plugin-side text.
    expect(repos.settings.get(controlValuesKey("hosttest-controls"))).toEqual({
      verbosity: "terse",
    });
    expect(host.mergedControlValues()["plugin:hosttest-controls:verbosity"]).toBe("be terse");
  });

  it("panelData degrades to the plugin half when the default preset is corrupt", async () => {
    const { host, repos, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-panel",
      `
export default {
  id: "hosttest-corruptpanel",
  name: "Corrupt-tolerant panel",
  version: "1.0.0",
  drawerTabs: [{ id: "tab", label: "Tab", htmlTemplate: "x" }],
  setup() {
    return { onPanelData(event) { globalThis.__spy_corruptpanel = { controls: event.controls }; } };
  },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-corruptpanel", true);
    repos.presets.create({ name: "Corrupt", prompts: [{ name: "no id" }] });

    const characterId = repos.characters.create({ name: "C" }).id;
    const chat = repos.chats.create({ character_id: characterId });
    const result = await host.panelData("hosttest-corruptpanel", "tab", chat.id);
    // Only a throwing `onPanelData` hook is a 500 here; an unreadable preset
    // is an unrelated state and must not widen that boundary.
    expect(result.ok).toBe(true);
  });

  it("caps an onControlChange mutual-write loop without overflowing the stack", () => {
    const { host, repos, pluginsDir } = harness();
    // A handler that writes its own control every time re-enters the notify
    // path synchronously; MAX_CONTROL_NOTIFY_DEPTH must stop it.
    writePlugin(
      pluginsDir,
      "01-loop",
      `
export default {
  id: "hosttest-loop",
  name: "Loop",
  version: "1.0.0",
  controls: [
    { id: "flip", label: "Flip", type: "toggle", default: "a", options: [{ id: "a" }, { id: "b" }] },
  ],
  setup(ctx) {
    globalThis.__spy_hosttest_loop = { count: 0 };
    return {
      onControlChange(event) {
        globalThis.__spy_hosttest_loop.count++;
        // Toggle to the other option on every notification: an unbounded
        // mutual-write loop without the cap.
        ctx.controls.set("flip", event.value === "a" ? "b" : "a");
      },
    };
  },
};
`,
    );
    host.loadAll();
    host.setEnabled("hosttest-loop", true);

    expect(() => host.putControlValues("hosttest-loop", { flip: "a" })).not.toThrow();
    const count = spy<{ count: number }>("hosttest-loop")?.count ?? 0;
    // Stopped at the cap: fires once per level (16), not unbounded.
    expect(count).toBe(16);
    // Every write in the cascade persisted; the loop ends on a real option.
    expect(repos.settings.get(controlValuesKey("hosttest-loop"))).toEqual({ flip: "a" });
  });
});

describe("PluginHost control validation at discovery", () => {
  it("rejects malformed control declarations with precise messages", () => {
    const { host, pluginsDir } = harness();
    const cases: Array<{ folder: string; fields: string; phrases: string[] }> = [
      {
        folder: "01-not-array",
        fields: '  controls: { id: "x" },',
        phrases: ["controls must be an array"],
      },
      {
        folder: "02-bad-id",
        fields:
          '  controls: [{ id: "Bad_ID", label: "X", type: "select", default: "a", options: [{ id: "a" }, { id: "b" }] }],',
        phrases: ["controls[0].id"],
      },
      {
        folder: "03-duplicate-id",
        fields:
          '  controls: [{ id: "x", label: "X", type: "select", default: "a", options: [{ id: "a" }, { id: "b" }] }, { id: "x", label: "X2", type: "select", default: "a", options: [{ id: "a" }, { id: "b" }] }],',
        phrases: ['controls[1].id "x" is declared twice'],
      },
      {
        folder: "04-one-option",
        fields:
          '  controls: [{ id: "x", label: "X", type: "select", default: "a", options: [{ id: "a" }] }],',
        phrases: ["at least two entries"],
      },
      {
        folder: "05-duplicate-option",
        fields:
          '  controls: [{ id: "x", label: "X", type: "select", default: "a", options: [{ id: "a" }, { id: "a" }] }],',
        phrases: ["declared twice"],
      },
      {
        folder: "06-toggle-three",
        fields:
          '  controls: [{ id: "x", label: "X", type: "toggle", default: "a", options: [{ id: "a" }, { id: "b" }, { id: "c" }] }],',
        phrases: ["exactly two entries for a toggle"],
      },
      {
        folder: "07-bad-type",
        fields:
          '  controls: [{ id: "x", label: "X", type: "slider", default: "a", options: [{ id: "a" }, { id: "b" }] }],',
        phrases: ['"select" or "toggle"'],
      },
      {
        folder: "08-dangling-default",
        fields:
          '  controls: [{ id: "x", label: "X", type: "select", default: "ghost", options: [{ id: "a" }, { id: "b" }] }],',
        phrases: ['default "ghost" names no option'],
      },
      {
        folder: "09-empty-label",
        fields:
          '  controls: [{ id: "x", label: "", type: "select", options: [{ id: "a" }, { id: "b" }] }],',
        phrases: ["label must be a non-empty string"],
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      writePlugin(
        pluginsDir,
        testCase.folder,
        `
export default {
  id: "hosttest-ctrlbad-${index}",
  name: "Bad Controls",
  version: "1.0.0",
${testCase.fields}
  setup() { return {}; },
};
`,
      );
    }

    host.loadAll();
    for (const testCase of cases) {
      const entry = host.list().find((plugin) => plugin.id === testCase.folder);
      expect(entry?.loaded).toBe(false);
      for (const phrase of testCase.phrases) {
        expect(entry?.error).toContain(phrase);
      }
    }
  });

  it("rejects an unknown setting type and accepts the new field types", () => {
    const { host, pluginsDir } = harness();
    writePlugin(
      pluginsDir,
      "01-unknown-type",
      `
export default {
  id: "hosttest-badtype",
  name: "Bad Type",
  version: "1.0.0",
  settings: [{ key: "x", label: "X", type: "slider", default: "a" }],
  setup() { return {}; },
};
`,
    );
    writePlugin(
      pluginsDir,
      "02-new-types",
      `
export default {
  id: "hosttest-newtypes",
  name: "New Types",
  version: "1.0.0",
  settings: [
    { key: "notes", label: "Notes", type: "textarea", default: "" },
    { key: "tags", label: "Tags", type: "multiselect", default: ["a"], options: [
      { label: "A", value: "a" }, { label: "B", value: "b" },
    ] },
  ],
  setup() { return {}; },
};
`,
    );
    host.loadAll();
    expect(host.list().find((plugin) => plugin.id === "01-unknown-type")?.error).toContain(
      "unknown type",
    );
    const good = host.list().find((plugin) => plugin.id === "hosttest-newtypes");
    expect(good?.error).toBeUndefined();
    expect(good?.settings).toEqual({ notes: "", tags: ["a"] });
  });

  it("validates textarea/multiselect writes and the default at discovery", () => {
    const { host, pluginsDir } = harness();
    writePlugin(pluginsDir, "01-new-types", SETTINGS_NEW_TYPES_PLUGIN);
    host.loadAll();

    expect(host.putSettings("hosttest-newtypes", { notes: "hello" }).ok).toBe(true);
    expect(host.putSettings("hosttest-newtypes", { notes: 5 }).ok).toBe(false);
    expect(host.putSettings("hosttest-newtypes", { tags: ["b"] }).ok).toBe(true);
    expect(host.putSettings("hosttest-newtypes", { tags: "b" }).ok).toBe(false);
    expect(host.putSettings("hosttest-newtypes", { tags: ["a", "c"] }).ok).toBe(false);
    expect(host.putSettings("hosttest-newtypes", { tags: [1] }).ok).toBe(false);

    // A multiselect option with a numeric value is not selectable into the
    // string[] — the default must be strings.
    writePlugin(
      pluginsDir,
      "02-numeric-default",
      `
export default {
  id: "hosttest-numericdefault",
  name: "Numeric Default",
  version: "1.0.0",
  settings: [{ key: "tags", label: "Tags", type: "multiselect", default: [1], options: [
    { label: "One", value: 1 }, { label: "Two", value: 2 },
  ] }],
  setup() { return {}; },
};
`,
    );
    host.reloadAll();
    expect(host.list().find((plugin) => plugin.id === "02-numeric-default")?.error).toContain(
      "array of strings",
    );
  });
});

/** A plugin with both new setting field types (shared by the tests above). */
const SETTINGS_NEW_TYPES_PLUGIN = `
export default {
  id: "hosttest-newtypes",
  name: "New Types",
  version: "1.0.0",
  settings: [
    { key: "notes", label: "Notes", type: "textarea", default: "" },
    { key: "tags", label: "Tags", type: "multiselect", default: ["a"], options: [
      { label: "A", value: "a" }, { label: "B", value: "b" },
    ] },
  ],
  setup() { return {}; },
};
`;

/**
 * Cross-package drift guard. The server rejects a plugin theme whose id is in
 * PLUGIN_THEME_RESERVED_IDS, and packages/web ships those same ids as its
 * built-in palettes — but packages/web does not depend on @suvoj/plugin-sdk,
 * so nothing links the two at build time. The web package asserts its own
 * THEMES against styles/themes.css (stores/themes.test.ts), and the SDK test
 * pins only the SDK constant; this is the one place all three agree. A new
 * built-in theme added to the web package without updating the SDK list would
 * otherwise become silently claimable (and shadowed) by a plugin.
 */
describe("built-in theme id drift", () => {
  it("PLUGIN_THEME_RESERVED_IDS matches the data-theme ids in themes.css", () => {
    const cssPath = join(import.meta.dir, "../../../../packages/web/src/styles/themes.css");
    // Mirror packages/web/src/stores/themes.test.ts's hand-rolled scan: strip
    // comments (the header lists theme ids in prose) and walk flat
    // `selector { ... }` blocks — custom-property values never contain braces.
    const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const ids: string[] = [];
    const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
    for (let match = blockPattern.exec(css); match !== null; match = blockPattern.exec(css)) {
      const selector = match[1]?.trim();
      if (!selector) {
        continue;
      }
      // Each palette block targets `:root[data-theme="<id>"]` (the default
      // block pairs that with a bare `:root`); a bare `:root` alone carries
      // no explicit id and is skipped rather than defaulting to midnight.
      const explicit = selector.match(/:root\[data-theme="([^"]+)"\]/);
      if (explicit?.[1]) {
        ids.push(explicit[1]);
      }
    }
    // Set equality (plus length) catches both a missing and a duplicated id:
    expect(new Set(ids)).toEqual(new Set(PLUGIN_THEME_RESERVED_IDS));
    expect(ids).toHaveLength(PLUGIN_THEME_RESERVED_IDS.length);
  });
});
