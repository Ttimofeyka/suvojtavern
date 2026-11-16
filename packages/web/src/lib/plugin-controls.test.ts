/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { PluginControl } from "./api-plugins";
import {
  pluginControlDisplay,
  pluginControlLabel,
  pluginControlState,
  pluginOptionLabel,
  resolvePluginChoices,
  storedControlValues,
} from "./plugin-controls";

/** A select control fixture, roughly the example plugin's `verbosity`. */
const verbosity: PluginControl = {
  id: "verbosity",
  label: "Verbosity",
  description: "How much detail.",
  type: "select",
  default: "balanced",
  options: [
    { id: "terse", label: "Terse", value: "be terse" },
    { id: "balanced", label: "Balanced", value: "balanced detail" },
    { id: "rich", label: "Rich", value: "rich detail" },
  ],
};

/** A toggle fixture: exactly two options, first = on. */
const flag: PluginControl = {
  id: "flag",
  label: "Flag",
  type: "toggle",
  default: "on",
  options: [
    { id: "on", label: "Enabled" },
    { id: "off", label: "Disabled" },
  ],
};

describe("resolvePluginChoices", () => {
  it("returns {} for no controls", () => {
    expect(resolvePluginChoices([], { verbosity: "rich" })).toEqual({});
  });

  it("uses the stored value when it names a real option", () => {
    expect(resolvePluginChoices([verbosity], { verbosity: "rich" })).toEqual({
      verbosity: "rich",
    });
  });

  it("falls back to `default`, then to the first option", () => {
    expect(resolvePluginChoices([verbosity], { verbosity: "ghost" })).toEqual({
      verbosity: "balanced",
    });
    expect(resolvePluginChoices([verbosity], {})).toEqual({ verbosity: "balanced" });
    expect(resolvePluginChoices([verbosity], "nope")).toEqual({ verbosity: "balanced" });
    expect(resolvePluginChoices([verbosity], null)).toEqual({ verbosity: "balanced" });

    const noDefault: PluginControl = { ...verbosity, default: "" };
    expect(resolvePluginChoices([noDefault], {})).toEqual({ verbosity: "terse" });
  });

  it("ignores stored values for unknown controls and non-string entries", () => {
    expect(resolvePluginChoices([verbosity], { missing: "x", verbosity: "terse" })).toEqual({
      verbosity: "terse",
    });
    expect(resolvePluginChoices([verbosity], { verbosity: 1 })).toEqual({
      verbosity: "balanced",
    });
  });

  it("resolves every control (one entry each)", () => {
    expect(resolvePluginChoices([verbosity, flag], { flag: "off" })).toEqual({
      verbosity: "balanced",
      flag: "off",
    });
  });
});

describe("labels", () => {
  it("never returns a blank control label", () => {
    expect(pluginControlLabel(verbosity)).toBe("Verbosity");
    expect(pluginControlLabel({ ...verbosity, label: "   " })).toBe("verbosity");
  });

  it("never returns a blank option label", () => {
    const [first] = verbosity.options;
    expect(pluginOptionLabel(first ?? { id: "", label: "" })).toBe("Terse");
    expect(pluginOptionLabel({ id: "bare", label: "" })).toBe("bare");
  });
});

describe("pluginControlState", () => {
  it("returns one entry per control with the resolved choice", () => {
    const [state, flagState] = pluginControlState([verbosity, flag], { flag: "off" });
    expect(state).toMatchObject({
      label: "Verbosity",
      value: "balanced",
      chosenLabel: "Balanced",
      macroText: "balanced detail",
      toggle: false,
    });
    expect(flagState).toMatchObject({
      label: "Flag",
      value: "off",
      chosenLabel: "Disabled",
      toggle: true,
    });
  });

  it("exposes a toggle's on/off pair in declaration order", () => {
    const [state] = pluginControlState([flag], {});
    expect(state?.on?.id).toBe("on");
    expect(state?.off?.id).toBe("off");
  });

  it("resolves macro text as value → label → id", () => {
    const withBlankValue: PluginControl = {
      ...verbosity,
      options: [
        { id: "a", label: "A", value: "" }, // blank value → label
        { id: "b", label: "", value: "" }, // blank both → id
      ],
    };
    expect(pluginControlState([withBlankValue], {})[0]?.macroText).toBe("A");
    expect(pluginControlState([{ ...withBlankValue, default: "b" }], {})[0]?.macroText).toBe("b");
  });

  it("shows the resolved option id when a control has no renderable option", () => {
    const empty: PluginControl = { ...verbosity, options: [], default: "" };
    const [state] = pluginControlState([empty], { verbosity: "stale" });
    expect(state?.value).toBe("");
    expect(state?.chosenLabel).toBe("");
    expect(state?.macroText).toBe("");
  });

  it("is tolerant of a garbage stored map", () => {
    expect(pluginControlState([verbosity], undefined)[0]?.value).toBe("balanced");
    expect(pluginControlState([verbosity], 42)[0]?.value).toBe("balanced");
  });
});

describe("pluginControlDisplay", () => {
  it("resolves a single control against a choices map", () => {
    const display = pluginControlDisplay(verbosity, { verbosity: "rich" });
    expect(display).toMatchObject({
      label: "Verbosity",
      value: "rich",
      chosenLabel: "Rich",
      macroText: "rich detail",
      toggle: false,
    });
    // The declaration is returned by reference so a stable For keeps its row.
    expect(display.control).toBe(verbosity);
  });

  it("treats a missing choice as unresolved (the caller passes a resolved map)", () => {
    const display = pluginControlDisplay(flag, {});
    expect(display.value).toBe("");
    expect(display.on?.id).toBe("on");
    expect(display.off?.id).toBe("off");
  });
});

describe("storedControlValues", () => {
  it("returns {} for null/garbage", () => {
    expect(storedControlValues(null)).toEqual({});
    expect(storedControlValues(undefined)).toEqual({});
    expect(storedControlValues("nope")).toEqual({});
    expect(storedControlValues([1, 2])).toEqual({});
  });

  it("keeps only string entries", () => {
    expect(storedControlValues({ a: "x", b: 2, c: null })).toEqual({ a: "x" });
  });
});
