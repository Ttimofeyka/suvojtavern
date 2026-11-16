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
} from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import { PluginHost } from "../plugins/host";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { generateRoutes } from "./generate";
import { messagesRoutes } from "./messages";
import { pluginsRoutes } from "./plugins";
import { presetsRoutes } from "./presets";

/**
 * Generation integration: plugins loaded through a real host rewrite the
 * prompt before the gateway call and the reply before persistence. The
 * gateway is stubbed exactly the way generate-regen.test.ts does; the fetch
 * stub also captures the request body so prompt rewrites are verifiable.
 */

const sse = (): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        c.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":" there"}}]}\n\n'),
        );
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
  );

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const parseEvents = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

let tmpRoot = "";
const hosts: PluginHost[] = [];

/** The last JSON body the fetch stub saw (the gateway's request payload). */
let lastRequestBody = "";

interface TestApp {
  app: Hono;
  host: PluginHost;
  pluginsDir: string;
  repos: ReturnType<typeof createRepositories>;
}

/** App + host over a fresh db and temp plugins dir; records gateway bodies. */
function setup(): TestApp {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const bus = new ChatHookBus();
  const repos = createRepositories(db, bus);
  repos.profiles.create(
    { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
    { is_default: true },
  );
  const fetchImpl: typeof fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      lastRequestBody = typeof init?.body === "string" ? init.body : "";
      return sse();
    },
    { preconnect: () => {} },
  );
  const pluginsDir = mkdtempSync(join(tmpRoot, "plugins-"));
  const host = new PluginHost({ pluginsDir, repos, hooks: bus });
  hosts.push(host);
  host.loadAll();
  const deps: RouteDeps & { plugins: PluginHost } = {
    repos,
    gateway: createGateway({ repos, fetchImpl }),
    plugins: host,
  };
  const app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", generateRoutes(deps));
  app.route("/", pluginsRoutes(deps));
  app.route("/", presetsRoutes(deps));
  return { app, host, pluginsDir, repos };
}

/** Writes one fixture plugin folder. */
function writePlugin(pluginsDir: string, folder: string, source: string): void {
  const dir = join(pluginsDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
}

/** Creates a character + chat through the API; returns the chat id. */
async function newChat(app: Hono, repos: TestApp["repos"]): Promise<string> {
  const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
  const chatRes = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  const { chat } = (await chatRes.json()) as { chat: { id: string } };
  return chat.id;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "suvoj-plugin-generate-"));
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

describe("POST /api/chats/:id/generate with plugins", () => {
  it("an active plugin rewrites the prompt and the persisted/done reply", async () => {
    const { app, host, pluginsDir, repos } = setup();
    writePlugin(
      pluginsDir,
      "01-editor",
      `
export default {
  id: "gentest-editor",
  name: "Editor",
  version: "1.0.0",
  setup() {
    globalThis.__spy_gentest_editor = { events: [] };
    return {
      onBeforeGenerate(event) {
        return [...event.messages, { role: "system", content: "injected-by-plugin" }];
      },
      onResponse(event) {
        return event.content + "[signed]";
      },
      onChatEvent(event) {
        globalThis.__spy_gentest_editor.events.push(event.event);
      },
    };
  },
};
`,
    );
    host.reloadAll();
    host.setEnabled("gentest-editor", true);
    const chatId = await newChat(app, repos);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    const done = events.find((event) => event.type === "done");
    expect(done?.content).toBe("Hi there[signed]");

    // The prompt rewrite reached the gateway:
    expect(lastRequestBody).toContain("injected-by-plugin");
    // Deltas stream raw (plugins observe, never modify):
    expect(events.filter((event) => event.type === "delta").map((event) => event.content)).toEqual([
      "Hi",
      " there",
    ]);
    // Persisted message carries the plugin's version (the last assistant
    // message is the reply; the greeting is also stored as one):
    const persisted = repos.messages
      .listActive(chatId)
      .filter((message) => message.role === "assistant")
      .at(-1);
    expect(persisted?.content).toBe("Hi there[signed]");
    // The message lifecycle reached the plugin through the hook bus:
    expect((globalThis as Record<string, unknown>).__spy_gentest_editor).toMatchObject({
      events: expect.arrayContaining(["beforeInsert", "afterInsert"]),
    });
  });

  it("a throwing plugin never fails the generation", async () => {
    const { app, host, pluginsDir, repos } = setup();
    writePlugin(
      pluginsDir,
      "01-thrower",
      `
export default {
  id: "gentest-thrower",
  name: "Thrower",
  version: "1.0.0",
  setup() {
    return {
      onBeforeGenerate() { throw new Error("boom before"); },
      onResponse() { throw new Error("boom response"); },
      onDelta() { throw new Error("boom delta"); },
    };
  },
};
`,
    );
    host.reloadAll();
    host.setEnabled("gentest-thrower", true);
    const chatId = await newChat(app, repos);

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    expect(events.find((event) => event.type === "done")?.content).toBe("Hi there");
  });

  it("a newly discovered plugin stays inert during generation until enabled", async () => {
    const { app, host, pluginsDir, repos } = setup();
    writePlugin(
      pluginsDir,
      "01-fresh",
      `
export default {
  id: "gentest-fresh",
  name: "Fresh",
  version: "1.0.0",
  setup() {
    globalThis.__spy_gentest_fresh = { ran: true };
    return {
      onBeforeGenerate(event) {
        return [...event.messages, { role: "system", content: "injected-by-fresh" }];
      },
      onResponse(event) { return event.content + "[fresh]"; },
    };
  },
};
`,
    );
    host.reloadAll();
    const chatId = await newChat(app, repos);

    // Listed but disabled — generation runs as if it didn't exist:
    expect(host.list().find((plugin) => plugin.id === "gentest-fresh")?.enabled).toBe(false);
    let res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    let events = parseEvents(await res.text());
    expect(events.find((event) => event.type === "done")?.content).toBe("Hi there");
    expect(lastRequestBody).not.toContain("injected-by-fresh");
    expect((globalThis as Record<string, unknown>).__spy_gentest_fresh).toBeUndefined();
    let persisted = repos.messages
      .listActive(chatId)
      .filter((message) => message.role === "assistant")
      .at(-1);
    expect(persisted?.content).toBe("Hi there");

    // Enabling activates it — the next generation goes through its hooks:
    host.setEnabled("gentest-fresh", true);
    res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    events = parseEvents(await res.text());
    expect(events.find((event) => event.type === "done")?.content).toBe("Hi there[fresh]");
    expect(lastRequestBody).toContain("injected-by-fresh");
    persisted = repos.messages
      .listActive(chatId)
      .filter((message) => message.role === "assistant")
      .at(-1);
    expect(persisted?.content).toBe("Hi there[fresh]");
  });

  it("resolves plugin control values into {{ui:…}} and the hook's controls map", async () => {
    const { app, host, pluginsDir, repos } = setup();
    // A plugin whose control text lands in the prompt via {{ui:…}}: the
    // preset's main content carries the macro, and the plugin injects a
    // system row reading `event.controls` so both halves are verifiable.
    writePlugin(
      pluginsDir,
      "01-controlled",
      `
export default {
  id: "gentest-controlled",
  name: "Controlled",
  version: "1.0.0",
  controls: [
    {
      id: "verbosity",
      label: "Verbosity",
      type: "select",
      default: "balanced",
      options: [
        { id: "terse", label: "Terse", value: "be terse" },
        { id: "balanced", label: "Balanced", value: "balanced detail" },
      ],
    },
  ],
  setup(ctx) {
    globalThis.__spy_gentest_controlled = { controls: null, read: ctx.controls.get("verbosity") };
    return {
      onBeforeGenerate(event) {
        globalThis.__spy_gentest_controlled.controls = event.controls;
        return [
          ...event.messages,
          { role: "system", content: "plugin-verbosity=" + event.controls["plugin:gentest-controlled:verbosity"] },
        ];
      },
      onControlChange(event) {
        globalThis.__spy_gentest_controlled.changes = [
          ...(globalThis.__spy_gentest_controlled.changes ?? []),
          event.controlId + "=" + event.value,
        ];
      },
    };
  },
};
`,
    );
    host.reloadAll();

    // A preset whose main prompt reads the plugin control macro. The route
    // resolves the preset itself; storing it as the default is enough.
    const preset = (await (
      await app.request("/api/presets", jsonInit("POST", { name: "Controlled" }))
    ).json()) as { id: string };
    repos.presets.update(preset.id, {
      prompts: [
        {
          id: "main",
          name: "Main",
          marker: "main",
          enabled: true,
          content: "Tone: {{ui:plugin:gentest-controlled:verbosity}}.",
        },
      ],
      settings: {},
    });
    repos.settings.set("default_preset_id", preset.id);

    host.setEnabled("gentest-controlled", true);
    const chatId = await newChat(app, repos);

    // Default choice (balanced) resolves to the option's `value` text.
    let res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    // Drain the SSE stream so the fire-and-forget route work (fetch, hooks)
    // has finished before asserting on captured state.
    await res.text();
    expect(lastRequestBody).toContain("Tone: balanced detail.");
    let spyState = (globalThis as Record<string, unknown>).__spy_gentest_controlled as {
      controls: Record<string, string>;
      read: string | null;
      changes?: string[];
    };
    expect(spyState.controls["plugin:gentest-controlled:verbosity"]).toBe("balanced detail");
    expect(spyState.read).toBe("balanced");

    // Changing the control changes the prompt on the next generation —
    // through the plugin's launch route, which fires onControlChange.
    const put = await app.request(
      "/api/plugins/gentest-controlled/controls",
      jsonInit("PUT", { values: { verbosity: "terse" } }),
    );
    expect(put.status).toBe(200);
    spyState = (globalThis as Record<string, unknown>).__spy_gentest_controlled as {
      controls: Record<string, string>;
      read: string | null;
      changes: string[];
    };
    expect(spyState.changes).toEqual(["verbosity=terse"]);

    res = await app.request(`/api/chats/${chatId}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    await res.text();
    expect(lastRequestBody).toContain("Tone: be terse.");
  });

  it("a throwing onControlChange handler never fails the plugin write route", async () => {
    const { app, host, pluginsDir } = setup();
    writePlugin(
      pluginsDir,
      "01-changethrow",
      `
export default {
  id: "gentest-changethrow",
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
    host.reloadAll();
    const res = await app.request(
      "/api/plugins/gentest-changethrow/controls",
      jsonInit("PUT", { values: { x: "b" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ control_values: { x: "b" } });
  });
});
