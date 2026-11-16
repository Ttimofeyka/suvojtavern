/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { PresetPrompt as WebPresetPrompt } from "../../../../web/src/lib/api-presets";
import {
  applyChoices as webApplyChoices,
  choiceMacroValues as webChoiceMacroValues,
  parseControls as webParseControls,
  resolveChoices as webResolveChoices,
  settingsControls as webSettingsControls,
} from "../../../../web/src/lib/preset-controls";
import {
  applyChoices as coreApplyChoices,
  choiceMacroValues as coreChoiceMacroValues,
  parseControls as coreParseControls,
  resolveChoices as coreResolveChoices,
  settingsControls as coreSettingsControls,
} from "./controls";
import type { PresetPrompt as CorePresetPrompt } from "./preset";

/**
 * Core↔web parity for preset controls.
 *
 * `packages/web/src/lib/preset-controls.ts` is a hand-written MIRROR of
 * `./controls.ts` (the web package cannot import `@suvoj/core`), and a third
 * implementation of the same precedence rules lives in the server host. Each
 * side's own suite only asserts itself, so drift between the engine and the
 * web editor ships silently — the host's copy was already wrong once (an
 * `undefined` label). This suite feeds ONE hostile input table through BOTH
 * implementations and asserts they agree: the editor's flags/macro text can
 * never disagree with what generation actually renders.
 *
 * The web module is imported by relative path (not `@suvoj/core`, which the
 * web package cannot resolve) and lives here rather than under
 * `packages/web/src/lib` because the test must run in both `bun test` and the
 * core typecheck.
 */

/** A valid declaration reused by the settings-blob cases. */
const POV: unknown = {
  id: "pov",
  label: "Point of view",
  description: "How the story is narrated.",
  type: "select",
  default: "third",
  options: [
    { id: "first", label: "First", value: "first person", prompts: ["pov-first"] },
    { id: "second", label: "Second", value: "", prompts: [] },
    { id: "third", label: "Third", value: "third person", prompts: ["pov-third"] },
  ],
};

/**
 * Every hostile `settings.controls` shape the editor tolerates — garbage
 * types, malformed entries, duplicate ids/options, toggle cuts, dangling
 * defaults, wrong-typed fields. Both parsers must drop exactly the same ones.
 */
const CONTROL_DECLARATIONS: unknown[] = [
  undefined,
  null,
  "nope",
  42,
  {},
  [],
  [null, 42, "x", {}],
  [POV],
  // Malformed entries are skipped without dropping the healthy siblings.
  [{ id: "", options: [{ id: "a" }, { id: "b" }] }, POV],
  // Cannot render: fewer than two options.
  [{ id: "one", options: [{ id: "a" }] }],
  [{ id: "none", options: [] }],
  // A control with a non-array options field is dropped whole.
  [{ id: "pov", options: "nope" }],
  // Duplicate option ids are unresolvable (they ARE the stored values).
  [
    {
      id: "pov",
      options: [
        { id: "a", prompts: ["x"] },
        { id: "a", prompts: ["y"] },
      ],
    },
  ],
  // A toggle is strictly binary; extras are cut, and a default naming a cut
  // option collapses.
  [
    {
      id: "flag",
      type: "toggle",
      options: [{ id: "on" }, { id: "off" }, { id: "maybe" }],
    },
  ],
  [
    {
      id: "flag",
      type: "toggle",
      default: "maybe",
      options: [{ id: "on" }, { id: "off" }, { id: "maybe" }],
    },
  ],
  [
    {
      id: "flag",
      type: "toggle",
      default: "off",
      options: [{ id: "on" }, { id: "off" }, { id: "maybe" }],
    },
  ],
  // Unknown type / dangling default / wrong-typed fields.
  [{ id: "pov", type: "slider", default: "a", options: [{ id: "a" }, { id: "b" }] }],
  [{ id: "pov", default: "ghost", options: [{ id: "a" }, { id: "b" }] }],
  [{ id: "pov", label: 5, options: [{ id: "a" }, { id: "b" }] }],
  [{ id: "pov", description: 5, options: [{ id: "a" }, { id: "b" }] }],
  [{ id: "pov", type: null, options: [{ id: "a" }, { id: "b" }] }],
  [{ id: "pov", default: null, options: [{ id: "a" }, { id: "b" }] }],
  // Option-level failures: empty id, non-string fields, bad prompts.
  [{ id: "pov", options: [{ id: "" }, { id: "b" }] }],
  [{ id: "pov", options: [{ id: "a", label: 5 }, { id: "b" }] }],
  [{ id: "pov", options: [{ id: "a", value: 5 }, { id: "b" }] }],
  [{ id: "pov", options: [{ id: "a", prompts: "nope" }, { id: "b" }] }],
  [{ id: "pov", options: [{ id: "a", prompts: ["ok", 3] }, { id: "b" }] }],
  [{ id: "pov", options: [null, { id: "b" }] }],
  // Duplicate control ids: first wins (and the later one is dropped whole).
  [
    { id: "pov", label: "First one", options: [{ id: "a" }, { id: "b" }] },
    { id: "pov", label: "Second one", options: [{ id: "c" }, { id: "d" }] },
  ],
  // An id that collides with an Object.prototype member is a normal id.
  [{ id: "constructor", options: [{ id: "a" }, { id: "b" }] }],
  // Unknown keys are stripped identically.
  [{ id: "pov", extra: true, options: [{ id: "a", extra: true }, { id: "b" }] }],
];

/** Hostile `settings.control_values` (and non-object blobs) for resolution. */
const STORED_CHOICES: unknown[] = [
  undefined,
  null,
  "nope",
  42,
  {},
  [],
  { pov: "first" },
  { pov: "second" },
  { pov: "ghost" },
  { pov: 1 },
  { pov: null },
  { pov: "third", missing: "x" },
];

/** Hostile settings blobs for the `settingsControls` entry point. */
const SETTINGS_BLOBS: unknown[] = [
  undefined,
  null,
  "nope",
  42,
  [],
  {},
  { controls: [POV] },
  { controls: "nope" },
  { controls: [POV], control_values: { pov: "first" } },
];

/** Prompt rows for `applyChoices`; plain shapes valid for both mirrors. */
const PROMPT_ROWS = [
  { id: "pov-first", enabled: true },
  { id: "pov-second", enabled: false },
  { id: "pov-third", enabled: true },
  { id: "shared", enabled: false },
  { id: "unrelated", enabled: true },
];
const CORE_PROMPTS = PROMPT_ROWS as unknown as readonly CorePresetPrompt[];
const WEB_PROMPTS = PROMPT_ROWS as unknown as readonly WebPresetPrompt[];

/** `enabled` flags keyed by prompt id — the only field the mirrors can differ on. */
function enabledById(rows: ReadonlyArray<{ id: string; enabled: boolean }>) {
  return rows.map((row) => ({ id: row.id, enabled: row.enabled }));
}

describe("core ↔ web preset-control parity", () => {
  it("parseControls agrees on every hostile declaration", () => {
    for (const declaration of CONTROL_DECLARATIONS) {
      expect(coreParseControls(declaration)).toEqual(webParseControls(declaration));
    }
  });

  it("settingsControls agrees on every hostile settings blob", () => {
    for (const settings of SETTINGS_BLOBS) {
      expect(coreSettingsControls(settings)).toEqual(webSettingsControls(settings));
    }
  });

  it("resolveChoices, choiceMacroValues and applyChoices agree pairwise", () => {
    for (const declaration of CONTROL_DECLARATIONS) {
      const coreControls = coreParseControls(declaration);
      const webControls = webParseControls(declaration);
      for (const stored of STORED_CHOICES) {
        const coreChoices = coreResolveChoices(coreControls, stored);
        const webChoices = webResolveChoices(webControls, stored);
        expect(coreChoices).toEqual(webChoices);

        expect(coreChoiceMacroValues(coreControls, coreChoices)).toEqual(
          webChoiceMacroValues(webControls, webChoices),
        );

        expect(enabledById(coreApplyChoices(CORE_PROMPTS, coreControls, coreChoices))).toEqual(
          enabledById(webApplyChoices(WEB_PROMPTS, webControls, webChoices)),
        );
      }
    }
  });
});
