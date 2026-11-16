/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { mergeRowsById, rowsEqual } from "./row-merge";

interface Row {
  id: string;
  label: string;
  tags?: string[];
}

describe("rowsEqual", () => {
  it("treats distinct Date instances as unequal", () => {
    expect(rowsEqual(new Date(0), new Date(0))).toBe(false);
    expect(rowsEqual(new Date(0), new Date(1000))).toBe(false);
  });

  it("matches the same Date instance by reference", () => {
    const date = new Date(0);
    expect(rowsEqual(date, date)).toBe(true);
  });

  it("deep-compares plain rows", () => {
    const row: Row = { id: "1", label: "a", tags: ["x", "y"] };
    expect(rowsEqual(row, { id: "1", label: "a", tags: ["x", "y"] })).toBe(true);
    expect(rowsEqual(row, { id: "1", label: "a", tags: ["x"] })).toBe(false);
  });
});

describe("mergeRowsById", () => {
  it("returns the previous array untouched when nothing changed", () => {
    const previous: Row[] = [{ id: "1", label: "a" }];
    const incoming: Row[] = [{ id: "1", label: "a" }];
    expect(mergeRowsById(previous, incoming)).toBe(previous);
  });

  it("reuses an unchanged row's object instance", () => {
    const previous: Row[] = [{ id: "1", label: "a" }];
    const incoming: Row[] = [{ id: "1", label: "a" }];
    expect(mergeRowsById(previous, incoming)[0]).toBe(previous[0]);
  });

  it("takes the incoming object for a changed row", () => {
    const previous: Row[] = [{ id: "1", label: "a" }];
    const incoming: Row[] = [{ id: "1", label: "b" }];
    expect(mergeRowsById(previous, incoming)[0]).toBe(incoming[0]);
  });

  it("marks a pure reorder as changed", () => {
    const a: Row = { id: "1", label: "a" };
    const b: Row = { id: "2", label: "b" };
    const previous: Row[] = [a, b];
    const merged = mergeRowsById(previous, [b, a]);
    expect(merged).not.toBe(previous);
    expect(merged[0]).toBe(b);
    expect(merged[1]).toBe(a);
  });

  it("replaces rows holding distinct Dates even when the times match", () => {
    const previous: Array<{ id: string; at: Date }> = [{ id: "1", at: new Date(0) }];
    const incoming: Array<{ id: string; at: Date }> = [{ id: "1", at: new Date(0) }];
    expect(mergeRowsById(previous, incoming)[0]).toBe(incoming[0]);
  });
});
