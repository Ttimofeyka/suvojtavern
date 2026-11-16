/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createRepositories, engine, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { PluginHost } from "./host";
import { resolveDefaultPluginsDir } from "./loader";

/**
 * Loads the REAL example plugin (plugins/example-plugin) through the real
 * loader. This also proves the `@suvoj/plugin-sdk` import resolves from a
 * plugin folder at the repo root (through the root node_modules link) — if
 * it didn't, discovery would produce an error entry instead of a
 * definition.
 */

const repoPluginsDir = join(import.meta.dir, "../../../../plugins");

const hosts: PluginHost[] = [];

function loadExamplePlugin(): PluginHost {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const host = new PluginHost({ pluginsDir: repoPluginsDir, repos: createRepositories(db) });
  hosts.push(host);
  host.loadAll();
  return host;
}

afterEach(() => {
  for (const host of hosts) {
    host.unloadAll();
  }
  hosts.length = 0;
});

describe("example plugin", () => {
  it("discovers, validates, and activates against the real SDK import", () => {
    const host = loadExamplePlugin();
    const list = host.list();
    const example = list.find((plugin) => plugin.id === "example-plugin");

    // The definition imported cleanly (SDK resolution works):
    expect(example?.error).toBeUndefined();
    expect(example?.name).toBe("Example Plugin");
    expect(example?.version).toBe("0.1.0");

    // Ships disabled (opt-in default) but loaded — the toggle is usable:
    expect(example?.enabled).toBe(false);
    expect(example?.loaded).toBe(true);

    // Settings defaults surface through the API:
    expect(example?.settings).toMatchObject({
      signature: false,
      signatureText: "\n\n— Example Plugin",
      logPrompts: false,
    });

    // UI contribution is intact:
    expect(example?.ui).toEqual({
      sidebarItems: [{ label: "Example", href: "/settings#plugins", icon: "Sparkles" }],
    });

    // Discovery activated nothing — the contributed strategy is not registered:
    expect(engine.getMemoryStrategy("none")).toBeUndefined();

    // Enabling activates it — the contributed memory strategy is live:
    host.setEnabled("example-plugin", true);
    expect(engine.getMemoryStrategy("none")).toBeDefined();

    // Signature off by default: responses pass through unchanged.
    expect(host.response({ chatId: "c", content: "hello", metadata: null })).toBe("hello");

    // With the setting on, onResponse appends the signature:
    host.putSettings("example-plugin", { signature: true });
    expect(host.response({ chatId: "c", content: "hello", metadata: null })).toBe(
      "hello\n\n— Example Plugin",
    );

    // Disabling unregisters the contributed strategy and silences hooks again:
    host.setEnabled("example-plugin", false);
    expect(engine.getMemoryStrategy("none")).toBeUndefined();
    expect(host.response({ chatId: "c", content: "hello", metadata: null })).toBe("hello");
  });

  it("resolveDefaultPluginsDir finds the repo plugins folder from any cwd depth", () => {
    const dir = resolveDefaultPluginsDir();
    expect(dir).not.toBeNull();
    expect(basename(dir ?? "")).toBe("plugins");
    expect(existsSync(dir ?? "")).toBe(true);
  });
});
