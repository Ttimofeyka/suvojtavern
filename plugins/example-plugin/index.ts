/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Example Plugin — the living walkthrough of the SuvojTavern plugin API.
 *
 * Each plugin is one folder inside the repo's `plugins/` directory, with an
 * `index.ts` entry exporting a `definePlugin(...)` result. Drop a folder in
 * (or delete it) and press "Reload" in Settings → Plugins — no server
 * restart needed. Full reference: docs/PLUGINS.md.
 *
 * This plugin demonstrates, with deliberately small code:
 *
 *   1. settings — typed fields the Settings UI renders for you (including
 *      the textarea and multiselect types);
 *   2. controls — an app-level value the plugin owns, readable from prompt
 *      text as `{{ui:plugin:example-plugin:verbosity}}`;
 *   3. `ctx.controls` — reading YOUR control values in setup/hooks;
 *   4. `onControlChange` — observing control edits (from Settings or a
 *      writer);
 *   5. `onBeforeGenerate` — reading (and optionally rewriting) the prompt;
 *   6. `onResponse` — editing the final reply before it is saved/sent;
 *   7. a custom memory strategy ("none") contributed to the Memory settings;
 *   8. a UI contribution (one sidebar item).
 *
 * The plugin id must be kebab-case, unique, and stable — enabled state and
 * settings persist under settings keys `plugin:<id>:enabled`,
 * `plugin:<id>:settings`, and `plugin:<id>:control_values`.
 */
import { definePlugin, type MemoryStrategy } from "@suvoj/plugin-sdk";

/**
 * A custom memory strategy: passes the whole history through untouched.
 *
 * Strategies are selected by id in Settings → Memory (or wired by a
 * preset's `memory.strategy`). A strategy receives the seq-ordered active
 * history and a token budget, and returns the history that survives plus
 * an optional summary block. Returning everything ignores the budget on
 * purpose — this is the "I'll manage context myself" strategy.
 *
 * While this plugin is enabled, "none" appears alongside "trim" and
 * "summaries"; disabling the plugin unregisters it again.
 */
const noneStrategy: MemoryStrategy = {
  id: "none",
  name: "None (keep full history)",
  apply: async (history) => ({ history: [...history] }),
};

export default definePlugin({
  id: "example-plugin",
  name: "Example Plugin",
  version: "0.1.0",
  description:
    "Demonstrates settings, prompt access, response editing, a custom memory strategy, and a sidebar item. Safe to keep enabled.",
  author: "SuvojTavern",

  // UI contributions are declarative: the web client renders them (adding
  // sidebar entries here; more surfaces in the future).
  ui: {
    sidebarItems: [{ label: "Example", href: "/settings#plugins", icon: "Sparkles" }],
  },

  // Settings are typed form fields. The user's values are stored under
  // `plugin:example-plugin:settings`; inside `setup` you read them through
  // `ctx.settings.get(key)` — unset keys fall back to the `default`s here.
  settings: [
    {
      key: "signature",
      label: "Add signature",
      type: "boolean",
      default: false,
      hint: "Append the signature text to every generated reply.",
    },
    {
      key: "signatureText",
      label: "Signature text",
      type: "string",
      default: "\n\n— Example Plugin",
      hint: "Appended to the model's reply when 'Add signature' is on.",
      placeholder: "\n\n— Example Plugin",
    },
    {
      key: "logPrompts",
      label: "Log prompts",
      type: "boolean",
      default: false,
      hint: "Server-log every outgoing prompt (size is always logged).",
    },
    {
      // A textarea is a multi-line string — same storage, larger editor.
      key: "notes",
      label: "Notes",
      type: "textarea",
      default: "",
      hint: "Free-form notes for yourself; the plugin never reads them.",
      placeholder: "Anything you want to remember here…",
    },
    {
      // A multiselect stores a string[] of the chosen option values.
      key: "tags",
      label: "Tags",
      type: "multiselect",
      default: ["example"],
      hint: "Example multi-select; stored as an array.",
      options: [
        { label: "Example", value: "example" },
        { label: "Demo", value: "demo" },
        { label: "Test", value: "test" },
      ],
    },
  ],

  // Controls are APP-LEVEL values this plugin owns (unlike a preset's
  // controls, they never switch prompt rows). Read them through
  // `ctx.controls`, or from prompt text as `{{ui:plugin:example-plugin:verbosity}}`.
  // Values persist under `plugin:example-plugin:control_values`.
  controls: [
    {
      id: "verbosity",
      label: "Verbosity",
      description: "How much detail the plugin asks the model for.",
      type: "select",
      default: "balanced",
      options: [
        // `value` is the text `{{ui:…}}` expands to; an empty value falls
        // back to the label, then the option id.
        { id: "terse", label: "Terse", value: "be terse" },
        { id: "balanced", label: "Balanced", value: "balanced detail" },
        { id: "rich", label: "Rich", value: "rich detail" },
      ],
    },
  ],

  // Contributed while the plugin is enabled; unregistered on disable.
  memoryStrategies: [noneStrategy],

  /**
   * `setup` runs once whenever the plugin is activated (server start, being
   * re-enabled, or a folder reload). It returns the runtime hooks — close
   * over whatever you need here. If setup throws, only THIS plugin fails:
   * it shows up as an error entry in Settings while the server keeps
   * running.
   */
  setup(ctx) {
    ctx.log("loaded"); // always prefixed [plugin:example-plugin]

    // `ctx.controls` reads THIS plugin's controls by their bare id. `get`
    // returns the resolved option id (stored choice → `default` → first),
    // never null for a declared control.
    ctx.log(`verbosity control: ${ctx.controls.get("verbosity")}`);

    return {
      /**
       * After prompt assembly, before the model call. `event.messages` is
       * the fully assembled prompt (system blocks, lorebook injections,
       * history — all macro-expanded). Returning a NEW array replaces it;
       * returning nothing leaves it alone. The settings read is live, so
       * toggling "Log prompts" takes effect on the next message without
       * reloading anything.
       */
      onBeforeGenerate(event) {
        ctx.log(`prompt assembled: ${event.messages.length} messages`);
        // The merged control map: preset controls under their bare id, every
        // plugin's controls namespaced `plugin:<id>:<control>`.
        const verbosity = ctx.controls.get("verbosity") ?? "balanced";
        const detail = event.controls["plugin:example-plugin:verbosity"] ?? "balanced detail";
        ctx.log(`  verbosity=${verbosity} ({{ui:…}} renders "${detail}")`);
        if (ctx.settings.get("logPrompts") === true) {
          for (const [index, message] of event.messages.entries()) {
            ctx.log(`  [${index}] ${message.role}: ${message.content}`);
          }
        }
        // To demonstrate rewriting, you could return a modified array:
        //   return [...event.messages, { role: "system", content: "Be brief." }];
      },

      /**
       * Observation only — fires whenever a control changes: a preset control
       * via `PUT /api/presets/:id/controls`, or this plugin's own control via
       * Settings or `ctx.controls.set`. The change is already persisted, so a
       * throw here is logged and skipped, never propagated.
       */
      onControlChange(event) {
        if (event.ownerId === ctx.pluginId) {
          ctx.log(`control changed: ${event.controlId} → ${event.value}`);
        }
      },

      /**
       * When the model reply completes, before it is persisted. Returning
       * a string replaces the content that is stored in the chat AND sent
       * in the `done` SSE event — streamed deltas are untouched (plugins
       * observe those via onDelta). This is how translation layers,
       * post-processors, or signatures plug in.
       */
      onResponse(event) {
        if (ctx.settings.get("signature") === true) {
          const signature = ctx.settings.get<string>("signatureText") ?? "";
          return `${event.content}${signature}`;
        }
        // Returning nothing keeps the model's reply as-is.
      },

      // Other hooks (not used here):
      //   onDelta(event)   — observe every streamed chunk (chatId, content).
      //   onChatEvent(e)   — message insert/edit/delete lifecycle.
      //   onPanelData(e)   — feed a chat-drawer tab's data (docs/PLUGINS.md);
      //                      `e.controls` carries the merged control map.
      //   onUnload()       — clean up timers, watchers, temp files.
    };
  },
});
