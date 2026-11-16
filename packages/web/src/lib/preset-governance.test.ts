/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { PresetControl, PresetPrompt } from "./api-presets";
import { governedPromptIds, parseControls } from "./preset-controls";
import { effectiveRows, governanceOf } from "./preset-governance";

/** A fully-defaulted prompt row for the governance tests. */
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
  description: "",
  type: "select",
  default: "third",
  options: [
    { id: "first", label: "First", value: "", prompts: ["pov-first"] },
    { id: "third", label: "Third", value: "", prompts: ["pov-third"] },
  ],
};

describe("effectiveRows", () => {
  it("overlays the effective choice onto the seeded rows' flags", () => {
    // The stored flags are stale: the last write predates a flip, and the
    // server would normalize them on the next save regardless.
    const rows = [prompt("pov-first", true), prompt("pov-third", false)];
    const out = effectiveRows(rows, { controls: [POV], control_values: { pov: "third" } });
    expect(out.map((row) => row.enabled)).toEqual([false, true]);
  });

  it("copies rows by reference for a preset with no usable controls", () => {
    const unrelated = prompt("unrelated");
    const out = effectiveRows([unrelated], { control_values: { pov: "third" } });
    expect(out).toEqual([unrelated]);
    expect(out[0]).toBe(unrelated);
  });

  it("never throws on a malformed settings blob", () => {
    const rows = [prompt("pov-first")];
    expect(effectiveRows(rows, null)).toEqual(rows);
    expect(effectiveRows(rows, "nope")).toEqual(rows);
  });
});

describe("governanceOf", () => {
  const controls = parseControls([POV]);

  it("names the owning control and disables the switch", () => {
    const governance = governanceOf("pov-first", controls, governedPromptIds(controls));
    expect(governance.control?.id).toBe("pov");
    expect(governance.disabled).toBe(true);
  });

  it("leaves an ungoverned row's switch live", () => {
    const governance = governanceOf("unrelated", controls, governedPromptIds(controls));
    expect(governance.control).toBeUndefined();
    expect(governance.disabled).toBe(false);
  });

  it("keeps a switch live when the governing control is not in the draft", () => {
    // A stale governed id (a hand-edited file, a control dropped from the
    // draft) has nothing to point at: a dead switch with no explanation
    // reads as broken, so the row keeps its own switch instead.
    const governed = new Map([["pov-first", "pov"]]);
    const governance = governanceOf("pov-first", [] as PresetControl[], governed);
    expect(governance.control).toBeUndefined();
    expect(governance.disabled).toBe(false);
  });
});
