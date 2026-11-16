/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { storedPersonaId } from "./persona-preference";

describe("storedPersonaId", () => {
  it("passes a non-empty string through unchanged", () => {
    expect(storedPersonaId("abc")).toBe("abc");
  });

  it("collapses an empty string to null", () => {
    expect(storedPersonaId("")).toBeNull();
  });

  it("collapses absent and non-string values to null", () => {
    expect(storedPersonaId(null)).toBeNull();
    expect(storedPersonaId(undefined)).toBeNull();
    expect(storedPersonaId(42)).toBeNull();
    expect(storedPersonaId({})).toBeNull();
    expect(storedPersonaId([])).toBeNull();
  });
});
