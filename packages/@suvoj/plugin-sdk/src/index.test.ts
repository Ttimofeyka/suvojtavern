/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  definePlugin,
  PLUGIN_ID_PATTERN,
  PLUGIN_THEME_HEX_TOKENS,
  PLUGIN_THEME_REQUIRED_TOKENS,
  PLUGIN_THEME_RESERVED_IDS,
  type PluginTheme,
  type TrackerMechanism,
  type TrackerPartsConfig,
  type TrackerSchemaPart,
} from "./index";

describe("definePlugin", () => {
  it("returns the definition unchanged (typed identity)", () => {
    const definition = {
      id: "test-plugin",
      name: "Test Plugin",
      version: "0.1.0",
      setup: () => undefined,
    };
    expect(definePlugin(definition)).toBe(definition);
  });

  it("accepts full definitions with hooks, strategies, and UI", () => {
    const definition = definePlugin({
      id: "full-plugin",
      name: "Full Plugin",
      version: "1.2.3",
      ui: { sidebarItems: [{ label: "Full", href: "/settings#plugins", icon: "Sparkles" }] },
      settings: [{ key: "on", label: "On", type: "boolean", default: false }],
      memoryStrategies: [
        {
          id: "passthrough",
          name: "Passthrough",
          apply: async (history) => ({ history: [...history] }),
        },
      ],
      pipelineStages: [{ id: "noop", run: async () => {} }],
      setup: (ctx) => {
        ctx.log("ready");
        return {
          onResponse: (event) => event.content,
          onUnload: () => {},
        };
      },
    });
    expect(definition.id).toBe("full-plugin");
    expect(definition.settings?.[0]?.default).toBe(false);
    expect(definition.memoryStrategies?.[0]?.id).toBe("passthrough");
  });

  it("accepts themes with a full token map plus a global stylesheet", () => {
    // Build vars covering every required token so the definition type-checks
    // through the SDK; the parsed-at-runtime hex tokens get concrete hex.
    const vars: Record<string, string> = {};
    for (const token of PLUGIN_THEME_REQUIRED_TOKENS) {
      vars[token] = PLUGIN_THEME_HEX_TOKENS.includes(token) ? "#101010" : "0 0 0 1px #202020";
    }
    const theme: PluginTheme = { id: "sunset", name: "Sunset", kind: "dark", vars };
    const definition = definePlugin({
      id: "theme-plugin",
      name: "Theme Plugin",
      version: "0.1.0",
      themes: [theme],
      globalCss: "body { letter-spacing: 0.01em; }",
      setup: () => undefined,
    });
    expect(definition.themes?.[0]?.id).toBe("sunset");
    expect(definition.themes?.[0]?.kind).toBe("dark");
    expect(definition.themes?.[0]?.vars["--bg"]).toBe("#101010");
    expect(definition.globalCss).toBe("body { letter-spacing: 0.01em; }");

    // Identity: definePlugin returns the exact object it was handed.
    const authored = {
      id: "theme-identity",
      name: "Theme Identity",
      version: "0.1.0",
      themes: [theme],
      globalCss: "html { scrollbar-gutter: stable; }",
      setup: () => undefined,
    };
    expect(definePlugin(authored)).toBe(authored);
  });

  it("accepts a multi-request tracker mechanism (optional pair + parts)", () => {
    // Compile-time surface proof: the optional `buildGenerationRequests` /
    // `parseResponses` pair plus the `TrackerSchemaPart` / `TrackerPartsConfig`
    // plan types must type-check through the SDK re-exports, and definePlugin
    // stays identity.
    const splitConfig: TrackerPartsConfig = { count: 2, fields: { place: 2 } };
    const mechanism: TrackerMechanism = {
      id: "split-digest",
      name: "Split Digest",
      description: `split into ${splitConfig.count}`,
      buildGenerationMessages: (input) => [
        { role: "system", content: String(input.schema.type ?? "") },
      ],
      parseResponse: (raw) => ({ raw }),
      buildGenerationRequests: (input) =>
        input.parts.map((part: TrackerSchemaPart) => ({
          messages: [{ role: "system", content: `part ${part.index}: ${part.fields.join(",")}` }],
        })),
      parseResponses: (raws, input) =>
        Object.fromEntries(input.parts.map((part, i) => [part.fields[0], raws[i]])),
    };
    const definition = definePlugin({
      id: "split-plugin",
      name: "Split Plugin",
      version: "0.3.0",
      trackerMechanisms: [mechanism],
      setup: () => undefined,
    });
    expect(definition.trackerMechanisms?.[0]).toBe(mechanism);

    // Identity: definePlugin returns the exact object it was handed.
    const authored = {
      id: "split-identity",
      name: "Split Identity",
      version: "0.3.0",
      trackerMechanisms: [mechanism],
      setup: () => undefined,
    };
    expect(definePlugin(authored)).toBe(authored);
  });

  it("accepts the summaries and hidden-position hook shapes", () => {
    const seen: string[] = [];
    const definition = definePlugin({
      id: "summaries-plugin",
      name: "Summaries Plugin",
      version: "0.2.0",
      setup: () => ({
        onSummariesChanged: (event) => {
          seen.push(
            `${event.chatId}:${event.created.length}:${event.deleted.length}:${event.unhiddenSeqs.join("+")}`,
          );
        },
        onPanelData: (event) => ({ hidden: [...event.hiddenSeqs] }),
      }),
    });
    const hooks = definition.setup({
      pluginId: "summaries-plugin",
      settings: { get: () => undefined, all: () => ({}) },
      controls: { get: () => null, all: () => ({}), set: () => {} },
      log: () => {},
    });
    if (!hooks) {
      throw new Error("setup returned no hooks");
    }

    // The observation hook receives the full lifecycle shape:
    hooks.onSummariesChanged?.({
      chatId: "chat-1",
      created: [
        {
          id: "s1",
          chat_id: "chat-1",
          level: 0,
          seq_from: 1,
          seq_to: 4,
          summary: "made",
          tokens: 5,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      deleted: [],
      unhiddenSeqs: [],
    });
    expect(seen).toEqual(["chat-1:1:0:"]);

    // Panel data exposes the covered positions:
    expect(
      hooks.onPanelData?.({
        pluginId: "summaries-plugin",
        chatId: "chat-1",
        tab: { id: "t", label: "T", htmlTemplate: "" },
        chat: null,
        character: null,
        persona: null,
        messages: [],
        hiddenSeqs: [1, 2, 3],
        controls: { pov: "third" },
      }),
    ).toEqual({
      hidden: [1, 2, 3],
    });
  });

  it("accepts controls, onControlChange, and the richer field types", () => {
    // Compile-time surface proof for phase 3: a control declaration, the
    // observation hook, the controls reader, and the new setting field types
    // must all type-check through definePlugin.
    const seenControl: string[] = [];
    const definition = definePlugin({
      id: "controls-plugin",
      name: "Controls Plugin",
      version: "0.4.0",
      settings: [
        {
          key: "notes",
          label: "Notes",
          type: "textarea",
          default: "",
          placeholder: "free text",
        },
        {
          key: "tags",
          label: "Tags",
          type: "multiselect",
          default: ["a"],
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "b" },
          ],
        },
      ],
      controls: [
        {
          id: "verbosity",
          label: "Verbosity",
          description: "How chatty the model should be.",
          type: "select",
          default: "balanced",
          options: [
            { id: "terse", label: "Terse" },
            { id: "balanced", label: "Balanced", value: "medium detail" },
            { id: "rich", label: "Rich" },
          ],
        },
      ],
      setup: (ctx) => {
        const value = ctx.controls.get("verbosity");
        const all = ctx.controls.all();
        seenControl.push(`${value ?? ""}:${Object.keys(all).length}`);
        ctx.controls.set("verbosity", "rich");
        return {
          onControlChange(event) {
            if (event.source === "plugin") {
              seenControl.push(`${event.ownerId}:${event.controlId}=${event.value}`);
            }
          },
          onBeforeGenerate(event) {
            // The merged map is always present on the event.
            seenControl.push(event.controls["plugin:controls-plugin:verbosity"] ?? "");
            return undefined;
          },
        };
      },
    });
    expect(definition.controls?.[0]?.id).toBe("verbosity");
    expect(definition.settings?.map((field) => field.type)).toEqual(["textarea", "multiselect"]);
  });
});

describe("PLUGIN_ID_PATTERN", () => {
  it("accepts kebab-case ids and rejects everything else", () => {
    expect(PLUGIN_ID_PATTERN.test("example-plugin")).toBe(true);
    expect(PLUGIN_ID_PATTERN.test("a")).toBe(true);
    expect(PLUGIN_ID_PATTERN.test("a-b-2")).toBe(true);
    expect(PLUGIN_ID_PATTERN.test("")).toBe(false);
    expect(PLUGIN_ID_PATTERN.test("Example_Plugin")).toBe(false);
    expect(PLUGIN_ID_PATTERN.test("with space")).toBe(false);
  });
});

describe("theme contract constants", () => {
  it("reserves the built-in theme ids", () => {
    expect([...PLUGIN_THEME_RESERVED_IDS]).toEqual([
      "tavern",
      "midnight",
      "coffee",
      "aurora",
      "nebula",
      "daylight",
      "paper",
      "mist",
      "lagoon",
    ]);
    expect(new Set(PLUGIN_THEME_RESERVED_IDS).size).toBe(PLUGIN_THEME_RESERVED_IDS.length);
  });

  it("keeps the hex-required tokens a subset of the required tokens", () => {
    // A hex token missing from the required list would be unvalidated (or a
    // theme could omit it), so subset-ness is part of the contract.
    for (const token of PLUGIN_THEME_HEX_TOKENS) {
      expect(PLUGIN_THEME_REQUIRED_TOKENS).toContain(token);
    }
    expect(new Set(PLUGIN_THEME_REQUIRED_TOKENS).size).toBe(PLUGIN_THEME_REQUIRED_TOKENS.length);
  });
});
