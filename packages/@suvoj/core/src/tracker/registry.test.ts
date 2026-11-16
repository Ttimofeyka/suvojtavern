/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import { suvojTrackerMechanism } from "./mechanism-suvoj-tracker";
import {
  BUILTIN_TRACKER_MECHANISM_IDS,
  getTrackerMechanism,
  listTrackerMechanisms,
  registerBuiltinTrackerMechanisms,
  registerTrackerMechanism,
  resetTrackerMechanisms,
  unregisterTrackerMechanism,
} from "./registry";

describe("tracker mechanism registry", () => {
  afterEach(() => {
    // Restore the shared registry for other test files in this process.
    resetTrackerMechanisms();
    registerBuiltinTrackerMechanisms();
  });

  it("registers the built-in suvoj-tracker mechanism at module load", () => {
    expect(getTrackerMechanism("suvoj-tracker")).toBe(suvojTrackerMechanism);
    expect(listTrackerMechanisms().map((mechanism) => mechanism.id)).toContain("suvoj-tracker");
    expect(BUILTIN_TRACKER_MECHANISM_IDS).toEqual(["suvoj-tracker"]);
  });

  it("registers, lists and unregisters custom mechanisms", () => {
    const custom = {
      id: "custom-tracker",
      name: "Custom",
      buildGenerationMessages: () => [],
      parseResponse: () => ({ ok: true }),
    };
    registerTrackerMechanism(custom);
    expect(getTrackerMechanism("custom-tracker")).toBe(custom);
    expect(listTrackerMechanisms().map((mechanism) => mechanism.id)).toEqual([
      "suvoj-tracker",
      "custom-tracker",
    ]);
    expect(unregisterTrackerMechanism("custom-tracker")).toBe(true);
    expect(getTrackerMechanism("custom-tracker")).toBeUndefined();
    expect(unregisterTrackerMechanism("custom-tracker")).toBe(false);
  });

  it("refuses to unregister the built-in mechanism", () => {
    expect(unregisterTrackerMechanism("suvoj-tracker")).toBe(false);
    expect(getTrackerMechanism("suvoj-tracker")).toBe(suvojTrackerMechanism);
  });

  it("returns undefined for unknown ids", () => {
    expect(getTrackerMechanism("nope")).toBeUndefined();
  });

  it("reset clears everything; registerBuiltinTrackerMechanisms restores", () => {
    resetTrackerMechanisms();
    expect(listTrackerMechanisms()).toEqual([]);
    registerBuiltinTrackerMechanisms();
    expect(getTrackerMechanism("suvoj-tracker")).toBe(suvojTrackerMechanism);
  });
});
