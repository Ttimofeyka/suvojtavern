/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { at } from "../test-utils";
import {
  applyChoices,
  applyChoicesToRows,
  CONTROL_ID_PATTERN,
  choiceMacroValues,
  controlIdProblem,
  type PresetControl,
  parseControls,
  resolveChoices,
  settingsChoices,
  settingsControls,
} from "./controls";
import { type PresetPrompt, promptSchema } from "./preset";

/** A fully-defaulted prompt row for applyChoices tests. */
function prompt(id: string, enabled = true): PresetPrompt {
  return promptSchema.parse({ id, name: id, enabled });
}

const POV: unknown = {
  id: "pov",
  label: "Point of view",
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

  it("dedupes by id, first wins", () => {
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
  });
});

describe("settingsControls / settingsChoices", () => {
  it("tolerate a non-object settings blob", () => {
    expect(settingsControls(null)).toEqual([]);
    expect(settingsChoices(null)).toEqual({});
    expect(settingsChoices("nope")).toEqual({});
  });

  it("read controls and values out of a settings object", () => {
    const settings = { controls: [POV], control_values: { pov: "first" } };
    expect(settingsControls(settings).map((control) => control.id)).toEqual(["pov"]);
    expect(settingsChoices(settings)).toEqual({ pov: "first" });
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
});

describe("applyChoices", () => {
  const controls = parseControls([POV]);

  it("returns a new array for no controls (input untouched)", () => {
    const prompts = [prompt("a")];
    const out = applyChoices(prompts, [], {});
    expect(out).toEqual(prompts);
    expect(out).not.toBe(prompts);
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
    expect(out[1]).not.toBe(undefined);
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
    const first = at(
      parseControls([
        {
          id: "a",
          options: [
            { id: "on", prompts: ["shared"] },
            { id: "off", prompts: [] },
          ],
        },
      ]),
      0,
    );
    const second = at(
      parseControls([
        {
          id: "b",
          options: [
            { id: "on", prompts: [] },
            { id: "off", prompts: ["shared"] },
          ],
        },
      ]),
      0,
    );
    // Control `a`'s chosen option enables "shared"; control `b`'s chosen
    // option enables nothing and disables its sibling, which names "shared".
    const choices = { a: "on", b: "on" };
    const out = applyChoices([prompt("shared", false)], [first, second], choices);
    expect(out[0]?.enabled).toBe(false);

    // Reversed order flips the winner, proving it is position, not content.
    const reversed = applyChoices([prompt("shared", false)], [second, first], choices);
    expect(reversed[0]?.enabled).toBe(true);
  });

  it("the chosen option beats a sibling sharing the same row", () => {
    const control = at(
      parseControls([
        {
          id: "pov",
          options: [
            { id: "a", prompts: ["shared"] },
            { id: "b", prompts: ["shared"] },
          ],
        },
      ]),
      0,
    );
    const out = applyChoices([prompt("shared", false)], [control], { pov: "b" });
    expect(out[0]?.enabled).toBe(true);
  });
});

describe("applyChoicesToRows", () => {
  const controls = parseControls([POV]);

  /** A loose stored row — arbitrary JSON, not a parsed `PresetPrompt`. */
  function row(id: unknown, enabled: unknown = true): Record<string, unknown> {
    return { id, name: String(id), enabled };
  }

  it("returns a new array for no controls (input untouched)", () => {
    const rows = [row("a")];
    const out = applyChoicesToRows(rows, [], {});
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it("enables the chosen option's rows and disables its siblings'", () => {
    const rows = [row("pov-first", true), row("pov-third", false)];
    const out = applyChoicesToRows(rows, controls, { pov: "third" });
    expect(out.find((entry) => entry.id === "pov-first")?.enabled).toBe(false);
    expect(out.find((entry) => entry.id === "pov-third")?.enabled).toBe(true);
  });

  it("leaves rows no option names untouched, by reference", () => {
    const untouched = row("unrelated");
    const out = applyChoicesToRows([untouched, row("pov-first")], controls, { pov: "first" });
    expect(out[0]).toBe(untouched);
    expect(out[1]).toMatchObject({ id: "pov-first", enabled: true });
  });

  it("never throws on a row with a non-string id, and leaves it untouched", () => {
    // Stored rows are hand-editable JSON: a numeric/null/object id is not a
    // shape an option can name, so it is passed through, not rejected.
    const numeric = row(42, false);
    const missing: Record<string, unknown> = { name: "no id" };
    const out = applyChoicesToRows([numeric, missing, row("pov-first", false)], controls, {
      pov: "first",
    });
    expect(out[0]).toBe(numeric);
    expect(out[1]).toBe(missing);
    expect(out[2]?.enabled).toBe(true);
  });

  it("passes non-object row entries through untouched", () => {
    // The `prompts` column is never object-checked on read, so a hand-edited
    // primitive/null entry is a real shape — it must not be spread or thrown on.
    const rows = [null, "junk", row("pov-first", false)] as unknown as Array<
      Record<string, unknown>
    >;
    const out = applyChoicesToRows(rows, controls, { pov: "first" }) as unknown[];
    expect(out[0]).toBeNull();
    expect(out[1]).toBe("junk");
    expect((out[2] as Record<string, unknown>).enabled).toBe(true);
  });

  it("lets a later control win when two controls name the same row", () => {
    const first = at(
      parseControls([
        {
          id: "a",
          options: [
            { id: "on", prompts: ["shared"] },
            { id: "off", prompts: [] },
          ],
        },
      ]),
      0,
    );
    const second = at(
      parseControls([
        {
          id: "b",
          options: [
            { id: "on", prompts: [] },
            { id: "off", prompts: ["shared"] },
          ],
        },
      ]),
      0,
    );
    const out = applyChoicesToRows([row("shared", false)], [first, second], { a: "on", b: "on" });
    expect(out[0]?.enabled).toBe(false);
    expect(
      applyChoicesToRows([row("shared", false)], [second, first], { a: "on", b: "on" })[0]?.enabled,
    ).toBe(true);
  });

  it("agrees with applyChoices on the same input (shared semantics)", () => {
    // The row variant exists only for the loose stored shape — the flags it
    // computes must be exactly what the engine's parsed variant computes,
    // else a stored preset would drift from its own generation.
    const inputs = [
      { choices: { pov: "first" } as Record<string, string>, first: true, third: false },
      { choices: { pov: "third" } as Record<string, string>, first: true, third: false },
      { choices: {} as Record<string, string>, first: false, third: false },
      { choices: { pov: "ghost" } as Record<string, string>, first: false, third: true },
    ];
    for (const input of inputs) {
      const parsed = [
        prompt("pov-first", input.first),
        prompt("pov-third", input.third),
        prompt("unrelated", true),
      ];
      const rows = [
        row("pov-first", input.first),
        row("pov-third", input.third),
        row("unrelated", true),
      ];
      const fromRows = applyChoicesToRows(rows, controls, input.choices);
      const fromParsed = applyChoices(parsed, controls, input.choices);
      expect(fromRows.map((entry) => ({ id: entry.id, enabled: entry.enabled }))).toEqual(
        fromParsed.map((entry) => ({ id: entry.id, enabled: entry.enabled })),
      );
    }
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

// Phase 2 builds controls in memory before storing them, so the type must be
// usable as an annotation from consumer code (not just inferred).
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
