/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { storedCharacterSort } from "./character-sort-preference";

describe("storedCharacterSort", () => {
  it("passes the UI-choosable orders through unchanged", () => {
    expect(storedCharacterSort("created")).toBe("created");
    expect(storedCharacterSort("recent")).toBe("recent");
  });

  it("collapses the non-UI server order and empties to null", () => {
    expect(storedCharacterSort("name")).toBeNull();
    expect(storedCharacterSort("")).toBeNull();
  });

  it("collapses absent and non-string values to null", () => {
    expect(storedCharacterSort(null)).toBeNull();
    expect(storedCharacterSort(undefined)).toBeNull();
    expect(storedCharacterSort(42)).toBeNull();
    expect(storedCharacterSort({})).toBeNull();
    expect(storedCharacterSort([])).toBeNull();
  });
});
