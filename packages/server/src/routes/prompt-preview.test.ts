/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatHookBus,
  createRepositories,
  engine,
  migrations,
  openDatabase,
  runMigrations,
} from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import { PluginHost } from "../plugins/host";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { messagesRoutes } from "./messages";
import { promptPreviewRoutes } from "./prompt-preview";

/**
 * Prompt inspector integration: assembly parity with the generate path plus
 * the three side-effect guarantees (no summary insert, no variable write, no
 * turn advance) and the plugin rewrite flag. The gateway's fetch is wired to
 * throw so any accidental upstream call fails the test loudly — the preview
 * must never reach the network.
 */

interface PreviewMessage {
  role: "system" | "user" | "assistant";
  name?: string;
  content: string;
  tokens: number;
}

interface PromptPreview {
  messages: PreviewMessage[];
  tokenCount: number;
  budget: { context: number; used: number; remaining: number };
  summary?: { seqFrom: number; seqTo: number; text: string };
  lorebook: { activations: unknown[] } | null;
  plugin_rewritten: boolean;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** A fetch that fails the test if the route ever performs an upstream call. */
const noNetworkFetch: typeof fetch = Object.assign(
  async () => {
    throw new Error("prompt-preview performed an upstream request");
  },
  { preconnect: () => {} },
);

interface TestApp {
  app: Hono;
  repos: ReturnType<typeof createRepositories>;
  host?: PluginHost;
  pluginsDir?: string;
}

/** App over a fresh in-memory database; `withPlugins` swaps in a real host. */
function setup(opts?: { withPlugins?: boolean }): TestApp {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps & { plugins?: PluginHost } = {
    repos,
    gateway: createGateway({ repos, fetchImpl: noNetworkFetch }),
  };
  let host: PluginHost | undefined;
  let pluginsDir: string | undefined;
  if (opts?.withPlugins) {
    const bus = new ChatHookBus();
    pluginsDir = mkdtempSync(join(tmpdir(), "suvoj-preview-plugins-"));
    host = new PluginHost({ pluginsDir, repos, hooks: bus });
    host.loadAll();
    deps.plugins = host;
  }
  const app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", promptPreviewRoutes(deps));
  return { app, repos, host, pluginsDir };
}

/** Writes one fixture plugin folder. */
function writePlugin(pluginsDir: string, folder: string, source: string): void {
  const dir = join(pluginsDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
}

/** Stores a preset whose layout is the built-in skeleton with a `main` body. */
function storePresetWithMain(
  repos: TestApp["repos"],
  main: string,
  settings: Record<string, unknown> = {},
): string {
  const preset = engine.defaultPreset();
  const mainPrompt = preset.prompts.find((prompt) => prompt.id === "main");
  if (!mainPrompt) {
    throw new Error("default preset has no main marker");
  }
  mainPrompt.content = main;
  return repos.presets.create({
    name: preset.name,
    description: preset.description,
    prompts: preset.prompts,
    settings: { ...preset.settings, ...settings },
  }).id;
}

/** Creates a chat through the API; returns its id (greeting inserted). */
async function newChat(
  app: Hono,
  repos: TestApp["repos"],
  character: Parameters<TestApp["repos"]["characters"]["create"]>[0],
): Promise<string> {
  const created = repos.characters.create(character);
  const res = await app.request("/api/chats", jsonInit("POST", { character_id: created.id }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { chat: { id: string } }).chat.id;
}

async function preview(app: Hono, chatId: string): Promise<PromptPreview> {
  const res = await app.request(`/api/chats/${chatId}/prompt-preview`);
  expect(res.status).toBe(200);
  return (await res.json()) as PromptPreview;
}

const tmpRoots: string[] = [];
const hosts: PluginHost[] = [];

afterEach(() => {
  for (const host of hosts) {
    host.unloadAll();
  }
  hosts.length = 0;
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tmpRoots.length = 0;
});

describe("GET /api/chats/:id/prompt-preview", () => {
  it("assembles the same prompt a generation would send, with a consistent budget", async () => {
    const { app, repos } = setup();
    const profile = repos.profiles.create({
      name: "Test",
      model: "test-model",
      sampling: { context_size: 2000, max_tokens: 500 },
    });
    repos.settings.set("active_connection_profile_id", profile.id);
    const presetId = storePresetWithMain(repos, "MAIN SYSTEM PROMPT");
    repos.settings.set("default_preset_id", presetId);

    const chatId = await newChat(app, repos, {
      name: "Aria",
      first_mes: "Hello there!",
      description: "Aria is a {{char}}.",
    });
    await app.request(
      `/api/chats/${chatId}/messages`,
      jsonInit("POST", {
        role: "user",
        content: "Hi Aria",
      }),
    );

    const body = await preview(app, chatId);
    const contents = body.messages.map((message) => message.content);

    // main prompt → character description → new-chat marker → live history.
    expect(contents[0]).toBe("MAIN SYSTEM PROMPT");
    const mainIndex = contents.indexOf("MAIN SYSTEM PROMPT");
    const descriptionIndex = contents.indexOf("Aria is a Aria.");
    const markerIndex = contents.indexOf("[Start a new chat]");
    const greetingIndex = contents.indexOf("Hello there!");
    const userIndex = contents.indexOf("Hi Aria");
    expect(descriptionIndex).toBeGreaterThan(mainIndex);
    expect(markerIndex).toBeGreaterThan(descriptionIndex);
    expect(greetingIndex).toBeGreaterThan(markerIndex);
    expect(userIndex).toBeGreaterThan(greetingIndex);

    // The generation role/name wiring is preserved.
    const userMessage = body.messages.find((message) => message.content === "Hi Aria");
    expect(userMessage?.role).toBe("user");
    expect(userMessage?.name).toBe("User");

    // The budget mirrors the profile samplers: context − max_tokens is the
    // usable window, and used + remaining is exactly that.
    expect(body.budget.context).toBe(2000);
    expect(body.budget.used).toBe(body.tokenCount);
    expect(body.budget.used + body.budget.remaining).toBe(1500);

    // Per-message counts agree with the assembly total (no plugin rewrite).
    const summed = body.messages.reduce((sum, message) => sum + message.tokens, 0);
    expect(summed).toBe(body.tokenCount);
    expect(body.plugin_rewritten).toBe(false);
  });

  it("matches the default budget when no profile is configured", async () => {
    const { app, repos } = setup();
    const chatId = await newChat(app, repos, { name: "Aria", first_mes: "Hello!" });
    const body = await preview(app, chatId);
    // No profile → empty sampling → the assembler's defaults.
    expect(body.budget.context).toBe(128000);
    expect(body.budget.used + body.budget.remaining).toBe(128000 - 4096);
  });

  it("rolls up summaries under budget pressure without persisting anything", async () => {
    const { app, repos } = setup();
    // Global memory wiring: the summaries strategy with a 2-snippet promotion
    // so the two seeded level-0 rows are rollable.
    repos.settings.set("memory_strategy", "summaries");
    repos.settings.set("memory_config", {
      summaries: { snippets_per_promotion: 2, summarize_after: 2 },
    });
    const profile = repos.profiles.create({
      name: "Tight",
      model: "test-model",
      // context − max_tokens = 50: far below the live history, forcing the
      // strategy into its budget-pressure fallback.
      sampling: { context_size: 100, max_tokens: 50 },
    });
    repos.settings.set("active_connection_profile_id", profile.id);

    // A sticky lorebook entry: commitTurn WOULD write turn state if called.
    const character = repos.characters.create({ name: "Aria", first_mes: "Hello!" });
    const book = repos.lorebooks.create({ name: "Sticky book" });
    repos.lorebooks.addEntry(book.id, {
      keys: [],
      content: "Sticky lore.",
      constant: true,
      position: 0,
      sticky: 5,
    });
    repos.lorebooks.attachToCharacter(character.id, book.id);
    const chatId = repos.chats.create({ character_id: character.id }).id;
    for (let i = 1; i <= 8; i++) {
      repos.messages.insertMessage(chatId, { role: "user", content: `history line ${i}` });
    }
    // Two uncovered level-0 rows covering 1-2 and 3-4 — the roll-up material.
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 2,
      summary: "sum1",
      tokens: 5,
    });
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 3,
      seq_to: 4,
      summary: "sum2",
      tokens: 5,
    });

    const body = await preview(app, chatId);

    // Over budget → the fallback rolled the two snippets into ONE level-1 row
    // in memory. The preview's summary text is that single rolled-up row
    // (joined "sum1\n\nsum2" wrapped once); without the roll-up it would be
    // two separately wrapped snippets. This proves the branch really ran.
    expect(body.summary).toBeDefined();
    expect(body.summary?.text).toBe("[Summary of past events: sum1\n\nsum2]");
    expect(body.summary?.seqFrom).toBe(1);
    expect(body.summary?.seqTo).toBe(4);
    expect(body.messages.some((message) => message.content.includes("Sticky lore."))).toBe(true);

    // GUARANTEE 1 — the synthetic roll-up row never reached the table.
    const rows = repos.summaries.list(chatId);
    expect(rows.map((row) => `${row.level}:${row.seq_from}-${row.seq_to}`)).toEqual([
      "0:1-2",
      "0:3-4",
    ]);
    expect(rows.every((row) => row.id.startsWith("preview-summary"))).toBe(false);

    // GUARANTEE 3 — no lorebook turn advance (commitTurn never called).
    expect(repos.variables.get("chat", chatId, "__wi:turn")).toBeNull();
    expect(repos.variables.get("chat", chatId, "__wi:state")).toBeNull();
  });

  it("evaluates variable macros without writing to the variables repo", async () => {
    const { app, repos } = setup();
    const character = repos.characters.create({
      name: "Aria",
      first_mes: "Hello!",
      description: "{{setvar::mood::happy}}mood={{getvar::mood}} existing={{getvar::existing}}",
    });
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: character.id }),
    );
    const chatId = ((await chatRes.json()) as { chat: { id: string } }).chat.id;
    // A pre-existing chat-scoped variable must still read back.
    repos.variables.set("chat", chatId, "existing", "42");

    const body = await preview(app, chatId);
    const description = body.messages.find((message) => message.content.startsWith("mood="));
    expect(description?.content).toBe("mood=happy existing=42");

    // GUARANTEE 2 — the `{{setvar}}` result was in-memory only.
    expect(repos.variables.get("chat", chatId, "mood")).toBeNull();
    expect(repos.variables.get("global", null, "mood")).toBeNull();
    expect(repos.variables.get("chat", chatId, "existing")).toBe("42");
  });

  it("returns 404 with the standard error shape for an unknown chat", async () => {
    const { app } = setup();
    const res = await app.request("/api/chats/does-not-exist/prompt-preview");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chat not found" });
  });

  it("reflects an onBeforeGenerate rewrite in plugin_rewritten", async () => {
    const { app, repos, host, pluginsDir } = setup({ withPlugins: true });
    if (!host || !pluginsDir) {
      throw new Error("plugin host missing");
    }
    writePlugin(
      pluginsDir,
      "01-rewriter",
      `
export default {
  id: "preview-rewriter",
  name: "Rewriter",
  version: "1.0.0",
  setup() {
    return {
      onBeforeGenerate(event) {
        return [...event.messages, { role: "system", content: "injected-by-plugin" }];
      },
    };
  },
};
`,
    );
    host.reloadAll();
    hosts.push(host);
    const chatId = await newChat(app, repos, { name: "Aria", first_mes: "Hello!" });

    // Discovered but disabled → inert, the prompt is untouched.
    const before = await preview(app, chatId);
    expect(before.plugin_rewritten).toBe(false);
    expect(before.messages.some((message) => message.content === "injected-by-plugin")).toBe(false);

    host.setEnabled("preview-rewriter", true);
    const after = await preview(app, chatId);
    expect(after.plugin_rewritten).toBe(true);
    expect(after.messages.at(-1)?.content).toBe("injected-by-plugin");
    // The rewrite invalidated the counts: recounted the generate way.
    expect(after.budget.used).toBe(after.tokenCount);
    expect(after.budget.used + after.budget.remaining).toBe(128000 - 4096);
  });

  it("emits the summary and lorebook fields in their contract shapes", async () => {
    const { app, repos } = setup();
    const character = repos.characters.create({ name: "Aria", first_mes: "Hello!" });
    const book = repos.lorebooks.create({ name: "Book" });
    repos.lorebooks.addEntry(book.id, {
      keys: [],
      content: "Always-on lore.",
      constant: true,
      position: 0,
    });
    repos.lorebooks.attachToCharacter(character.id, book.id);
    const chatId = repos.chats.create({ character_id: character.id }).id;

    const body = await preview(app, chatId);
    // No summaries strategy → no summary block, but the lorebook is reported.
    expect(body.summary).toBeUndefined();
    expect(body.lorebook).not.toBeNull();
    expect(body.lorebook?.activations).toHaveLength(1);
    // `commitTurn` is not JSON-serializable; the wire shape carries only
    // activations (the route never exposes the closure).
    expect(Object.keys(body.lorebook ?? {})).toEqual(["activations"]);
  });

  it("reflects plugin control values in {{ui:…}} exactly like a real generation", async () => {
    const { app, repos, host, pluginsDir } = setup({ withPlugins: true });
    if (!host || !pluginsDir) {
      throw new Error("plugin host missing");
    }
    writePlugin(
      pluginsDir,
      "01-controlled",
      `
export default {
  id: "preview-controlled",
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
    globalThis.__spy_preview_controlled = { read: ctx.controls.get("verbosity") };
    return {
      onBeforeGenerate(event) {
        // A control-dependent rewrite: the preview must show it too.
        if (event.controls["plugin:preview-controlled:verbosity"] === "be terse") {
          return [...event.messages, { role: "system", content: "terse-by-plugin" }];
        }
      },
    };
  },
};
`,
    );
    host.reloadAll();
    hosts.push(host);

    // A preset whose main prompt reads the plugin control macro, stored as
    // the default so the preview resolves it.
    const preset = engine.defaultPreset();
    const main = preset.prompts.find((prompt) => prompt.id === "main");
    if (main) {
      main.content = "Tone: {{ui:plugin:preview-controlled:verbosity}}.";
    }
    const presetId = repos.presets.create({
      name: preset.name,
      description: preset.description,
      prompts: preset.prompts,
      settings: preset.settings,
    }).id;
    repos.settings.set("default_preset_id", presetId);

    const chatId = await newChat(app, repos, { name: "Aria", first_mes: "Hello!" });

    // Disabled plugin → the macro stays verbatim, no rewrite.
    const before = await preview(app, chatId);
    expect(before.plugin_rewritten).toBe(false);
    expect(before.messages.some((message) => message.content === "Tone: balanced detail.")).toBe(
      false,
    );

    // Enabled → the default choice resolves and the plugin sees it.
    host.setEnabled("preview-controlled", true);
    const withDefault = await preview(app, chatId);
    expect(
      withDefault.messages.some((message) => message.content === "Tone: balanced detail."),
    ).toBe(true);
    expect(withDefault.plugin_rewritten).toBe(false);
    expect(
      (globalThis as Record<string, unknown>).__spy_preview_controlled as { read: string | null },
    ).toMatchObject({ read: "balanced" });

    // Change the control → the macro and the plugin's rewrite both change,
    // exactly as generate.ts would render them.
    expect(host.putControlValues("preview-controlled", { verbosity: "terse" }).ok).toBe(true);
    const changed = await preview(app, chatId);
    expect(changed.messages.some((message) => message.content === "Tone: be terse.")).toBe(true);
    expect(changed.plugin_rewritten).toBe(true);
    expect(changed.messages.at(-1)?.content).toBe("terse-by-plugin");
  });
});
