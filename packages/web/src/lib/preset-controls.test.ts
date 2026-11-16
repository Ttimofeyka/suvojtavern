/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { PresetPrompt } from "./api-presets";
import {
  applyChoices,
  CONTROL_ID_PATTERN,
  choiceMacroValues,
  controlIdProblem,
  governedPromptIds,
  type PresetControl,
  parseControls,
  resolveChoices,
  settingsControls,
  settingsControlValues,
  withControlValues,
} from "./preset-controls";

/** A fully-defaulted prompt row for applyChoices tests. */
function prompt(id: string, enabled = true): PresetPrompt {
  return {
    id,
    name: id,
    role: "system",
    content: "",
    enabled,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    injection_trigger: [],
  };
}

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

describe("parseControls", () => {
  it("returns [] for garbage and never throws", () => {
    expect(parseControls(undefined)).toEqual([]);
    expect(parseControls(null)).toEqual([]);
    expect(parseControls("nope")).toEqual([]);
    expect(parseControls(7)).toEqual([]);
    expect(parseControls({ id: "pov" })).toEqual([]);
    expect(parseControls([null, 42, "x", {}])).toEqual([]);
  });

  it("fills defaults for omitted fields", () => {
    const [control] = parseControls([{ id: "pov", options: [{ id: "a" }, { id: "b" }] }]);
    expect(control).toMatchObject({
      id: "pov",
      label: "",
      description: "",
      type: "select",
      default: "",
    });
    expect(control?.options[0]).toMatchObject({ id: "a", label: "", value: "", prompts: [] });
  });

  it("skips entries that fail the schema without dropping the rest", () => {
    const controls = parseControls([
      { id: "", options: [{ id: "a" }, { id: "b" }] },
      { id: "keep", options: [{ id: "a" }, { id: "b" }] },
      { id: "bad-type", type: "slider", options: [{ id: "a" }, { id: "b" }] },
    ]);
    expect(controls.map((control) => control.id)).toEqual(["keep"]);
  });

  it("rejects a field of the wrong type instead of coercing it", () => {
    expect(parseControls([{ id: "x", label: 5, options: [{ id: "a" }, { id: "b" }] }])).toEqual([]);
    expect(
      parseControls([{ id: "x", options: [{ id: "a", prompts: "not-an-array" }, { id: "b" }] }]),
    ).toEqual([]);
    expect(
      parseControls([{ id: "x", options: [{ id: "a", prompts: ["ok", 3] }, { id: "b" }] }]),
    ).toEqual([]);
  });

  it("dedupes by id, first wins (and the later duplicate is dropped whole)", () => {
    const controls = parseControls([
      { id: "pov", label: "First one", options: [{ id: "a" }, { id: "b" }] },
      { id: "pov", label: "Second one", options: [{ id: "c" }, { id: "d" }] },
    ]);
    expect(controls).toHaveLength(1);
    expect(controls[0]?.label).toBe("First one");
    expect(controls[0]?.options.map((option) => option.id)).toEqual(["a", "b"]);
  });

  it("drops a control with fewer than two options", () => {
    expect(parseControls([{ id: "one", options: [{ id: "a" }] }])).toEqual([]);
    expect(parseControls([{ id: "none", options: [] }])).toEqual([]);
    expect(parseControls([{ id: "absent" }])).toEqual([]);
  });

  it("drops a control with duplicate option ids", () => {
    // Option ids ARE the stored choice values, so a duplicate is unresolvable.
    expect(
      parseControls([
        {
          id: "pov",
          options: [
            { id: "a", prompts: ["x"] },
            { id: "a", prompts: ["y"] },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("falls back to the first option when `default` names nothing", () => {
    const controls = parseControls([
      { id: "pov", default: "ghost", options: [{ id: "a" }, { id: "b" }] },
    ]);
    expect(controls[0]?.default).toBe("");
    expect(resolveChoices(controls, {})).toEqual({ pov: "a" });
  });

  it("keeps only the first two options of a toggle", () => {
    const controls = parseControls([
      {
        id: "flag",
        type: "toggle",
        options: [{ id: "on" }, { id: "off" }, { id: "maybe" }],
      },
    ]);
    expect(controls[0]?.options.map((option) => option.id)).toEqual(["on", "off"]);
  });

  it("keeps a toggle's `default` only while it survives the two-option cut", () => {
    const cut = parseControls([
      {
        id: "flag",
        type: "toggle",
        default: "maybe",
        options: [{ id: "on" }, { id: "off" }, { id: "maybe" }],
      },
    ]);
    expect(cut[0]?.default).toBe("");

    const kept = parseControls([
      {
        id: "flag",
        type: "toggle",
        default: "off",
        options: [{ id: "on" }, { id: "off" }, { id: "maybe" }],
      },
    ]);
    expect(kept[0]?.default).toBe("off");
  });
});

describe("settingsControls / settingsControlValues", () => {
  it("tolerate a non-object settings blob", () => {
    expect(settingsControls(null)).toEqual([]);
    expect(settingsControls("nope")).toEqual([]);
    expect(settingsControls(undefined)).toEqual([]);
    expect(settingsControlValues(null)).toEqual({});
    expect(settingsControlValues("nope")).toEqual({});
  });

  it("read controls and raw values out of a settings object", () => {
    const settings = { controls: [POV], control_values: { pov: "first", extra: "kept" } };
    expect(settingsControls(settings).map((control) => control.id)).toEqual(["pov"]);
    expect(settingsControlValues(settings)).toEqual({ pov: "first", extra: "kept" });
  });

  it("ignores a non-object control_values and non-string entries", () => {
    expect(settingsControlValues({ control_values: "nope" })).toEqual({});
    expect(settingsControlValues({ control_values: null })).toEqual({});
    expect(settingsControlValues({ control_values: { a: "x", b: 2, c: null } })).toEqual({
      a: "x",
    });
  });
});

describe("resolveChoices", () => {
  const controls = parseControls([POV]);

  it("returns {} for no controls", () => {
    expect(resolveChoices([], { whatever: "x" })).toEqual({});
  });

  it("uses the stored value when it names a real option", () => {
    expect(resolveChoices(controls, { pov: "second" })).toEqual({ pov: "second" });
  });

  it("falls back to `default`, then to the first option", () => {
    expect(resolveChoices(controls, { pov: "ghost" })).toEqual({ pov: "third" });
    expect(resolveChoices(controls, {})).toEqual({ pov: "third" });
    expect(resolveChoices(controls, "nope")).toEqual({ pov: "third" });

    const noDefault = parseControls([{ id: "pov", options: [{ id: "a" }, { id: "b" }] }]);
    expect(resolveChoices(noDefault, {})).toEqual({ pov: "a" });
  });

  it("ignores stored values for unknown controls", () => {
    expect(resolveChoices(controls, { missing: "x", pov: "first" })).toEqual({ pov: "first" });
  });

  it("ignores a non-string stored value", () => {
    expect(resolveChoices(controls, { pov: 1 })).toEqual({ pov: "third" });
  });
});

describe("applyChoices", () => {
  const controls = parseControls([POV]);

  it("returns a new array for no controls (input untouched)", () => {
    const prompts = [prompt("a")];
    const out = applyChoices(prompts, [], {});
    expect(out).toEqual(prompts);
    expect(out).not.toBe(prompts);
    expect(out[0]).toBe(prompts[0]);
  });

  it("enables the chosen option's rows and disables its siblings'", () => {
    const prompts = [prompt("pov-first", true), prompt("pov-third", false)];
    const out = applyChoices(prompts, controls, { pov: "third" });
    expect(out.find((row) => row.id === "pov-first")?.enabled).toBe(false);
    expect(out.find((row) => row.id === "pov-third")?.enabled).toBe(true);
  });

  it("leaves rows no option names untouched, by reference", () => {
    const untouched = prompt("unrelated");
    const out = applyChoices([untouched, prompt("pov-first")], controls, { pov: "first" });
    expect(out[0]).toBe(untouched);
    expect(out[1]).toMatchObject({ id: "pov-first", enabled: true });
  });

  it("ignores prompt ids that match no row", () => {
    const out = applyChoices([prompt("only")], controls, { pov: "first" });
    expect(out).toEqual([prompt("only")]);
  });

  it("resolves the choice like resolveChoices when stored is garbage", () => {
    const out = applyChoices([prompt("pov-third", false)], controls, {});
    expect(out[0]?.enabled).toBe(true);
  });

  it("lets a later control win when two controls name the same row", () => {
    const first = parseControls([
      {
        id: "a",
        options: [
          { id: "on", prompts: ["shared"] },
          { id: "off", prompts: [] },
        ],
      },
    ])[0] as PresetControl;
    const second = parseControls([
      {
        id: "b",
        options: [
          { id: "on", prompts: [] },
          { id: "off", prompts: ["shared"] },
        ],
      },
    ])[0] as PresetControl;
    // Control `a`'s chosen option enables "shared"; control `b`'s chosen
    // option enables nothing and disables its sibling, which names "shared".
    const choices = { a: "on", b: "on" };
    const out = applyChoices([prompt("shared", false)], [first, second], choices);
    expect(out[0]?.enabled).toBe(false);

    // Reversed order flips the winner, proving it is position, not content.
    const reversed = applyChoices([prompt("shared", false)], [second, first], choices);
    expect(reversed[0]?.enabled).toBe(true);
  });

  it("lets the chosen option beat a sibling sharing the same row", () => {
    const control = parseControls([
      {
        id: "pov",
        options: [
          { id: "a", prompts: ["shared"] },
          { id: "b", prompts: ["shared"] },
        ],
      },
    ])[0] as PresetControl;
    const out = applyChoices([prompt("shared", false)], [control], { pov: "b" });
    expect(out[0]?.enabled).toBe(true);
  });
});

describe("governedPromptIds", () => {
  it("maps a row to the control that names it, across every option", () => {
    const controls = parseControls([POV]);
    const governed = governedPromptIds(controls);
    expect(governed.get("pov-first")).toBe("pov");
    expect(governed.get("pov-third")).toBe("pov");
    expect(governed.get("pov-missing")).toBeUndefined();
  });

  it("keeps the later control when two name the same row", () => {
    const controls = parseControls([
      {
        id: "a",
        options: [
          { id: "x", prompts: ["shared"] },
          { id: "y", prompts: [] },
        ],
      },
      {
        id: "b",
        options: [
          { id: "x", prompts: ["shared"] },
          { id: "y", prompts: [] },
        ],
      },
    ]);
    expect(governedPromptIds(controls).get("shared")).toBe("b");
  });

  it("returns an empty map for no controls", () => {
    expect(governedPromptIds([]).size).toBe(0);
  });
});

describe("choiceMacroValues", () => {
  const controls = parseControls([POV]);

  it("prefers value, then label, then the option id", () => {
    expect(choiceMacroValues(controls, { pov: "first" })).toEqual({ pov: "first person" });
    // `second` has a blank value but a label.
    expect(choiceMacroValues(controls, { pov: "second" })).toEqual({ pov: "Second" });
    const unlabeled = parseControls([
      {
        id: "pov",
        options: [{ id: "a", label: "", value: "" }, { id: "b" }],
      },
    ]);
    expect(choiceMacroValues(unlabeled, { pov: "a" })).toEqual({ pov: "a" });
  });

  it("returns {} when nothing resolves", () => {
    expect(choiceMacroValues([], {})).toEqual({});
  });

  it("resolves a missing choice like the flags (same fallback order)", () => {
    // Text and rows must never disagree: an absent/stale choice resolves to
    // the control default here exactly as it does for `enabled` flags.
    expect(choiceMacroValues(controls, {})).toEqual({ pov: "third person" });
    expect(choiceMacroValues(controls, { pov: "ghost" })).toEqual({ pov: "third person" });
  });
});

describe("withControlValues", () => {
  it("preserves every other settings key", () => {
    const settings = { scan_depth: 4, memory: { strategy: "trim" }, controls: [POV] };
    const merged = withControlValues(settings, { pov: "first" });
    expect(merged).toEqual({
      scan_depth: 4,
      memory: { strategy: "trim" },
      controls: [POV],
      control_values: { pov: "first" },
    });
  });

  it("merges over existing control_values, other controls kept", () => {
    const settings = { control_values: { tone: "warm", pov: "third" } };
    expect(withControlValues(settings, { pov: "first" })).toEqual({
      control_values: { tone: "warm", pov: "first" },
    });
  });

  it("replaces a non-object control_values outright", () => {
    expect(withControlValues({ control_values: "nope" }, { pov: "first" })).toEqual({
      control_values: { pov: "first" },
    });
  });

  it("tolerates a non-object settings blob", () => {
    expect(withControlValues(null, { pov: "first" })).toEqual({
      control_values: { pov: "first" },
    });
    expect(withControlValues([1, 2], {})).toEqual({ control_values: {} });
  });
});

describe("control id validation", () => {
  it("accepts slugs and rejects everything else", () => {
    expect(CONTROL_ID_PATTERN.test("pov")).toBe(true);
    expect(CONTROL_ID_PATTERN.test("point-of-view-2")).toBe(true);
    expect(CONTROL_ID_PATTERN.test("2nd-person")).toBe(true);
    expect(CONTROL_ID_PATTERN.test("PointOfView")).toBe(false);
    expect(CONTROL_ID_PATTERN.test("-pov")).toBe(false);
    expect(CONTROL_ID_PATTERN.test("pov_2")).toBe(false);
  });

  it("reports a human reason or null", () => {
    const taken = new Set(["pov"]);
    expect(controlIdProblem("", taken)).toBe("Enter an id.");
    expect(controlIdProblem("Bad Id", taken)).toBe(
      "Use lowercase letters, digits and hyphens, starting with a letter or digit.",
    );
    expect(controlIdProblem("pov", taken)).toBe('The id "pov" is already used by another control.');
    expect(controlIdProblem("tone", taken)).toBeNull();
  });
});

// The editor builds controls in memory before storing them, so the type must
// be usable as an annotation from consumer code (not just inferred).
const editorControl: PresetControl = {
  id: "pov",
  label: "Point of view",
  description: "",
  type: "select",
  default: "first",
  options: [{ id: "first", label: "First", value: "", prompts: ["pov-first"] }],
};

describe("PresetControl public shape", () => {
  it("annotates a control literal that parseControls then tolerates", () => {
    // Only one option → parseControls drops it; the point is that the literal
    // above typechecks against the exported surface.
    expect(parseControls([editorControl])).toEqual([]);
  });
});
