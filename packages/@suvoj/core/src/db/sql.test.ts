/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { assignSql } from "./sql";

describe("assignSql", () => {
  it("returns null when no pair is applicable", () => {
    expect(assignSql([])).toBeNull();
    expect(
      assignSql([
        ["name", undefined],
        ["depth", undefined],
      ]),
    ).toBeNull();
  });

  it("double-quotes column names so SQLite keywords are safe", () => {
    const set = assignSql([
      ["order", 5],
      ["group", "faction"],
    ]);
    expect(set?.assignments).toBe('"order" = ?, "group" = ?');
    expect(set?.params).toEqual([5, "faction"]);
  });

  it("joins fragments in pair order and keeps params aligned", () => {
    const set = assignSql([
      ["comment", "note"],
      ["content", "text"],
      ["display_index", 3],
    ]);
    expect(set?.assignments).toBe('"comment" = ?, "content" = ?, "display_index" = ?');
    expect(set?.params).toEqual(["note", "text", 3]);
  });

  it("skips undefined pairs but keeps null (column clear)", () => {
    const set = assignSql([
      ["scan_depth", undefined],
      ["role", null],
      ["group_weight", undefined],
      ["content", "kept"],
    ]);
    expect(set?.assignments).toBe('"role" = ?, "content" = ?');
    expect(set?.params).toEqual([null, "kept"]);
  });

  it("binds booleans as 0/1", () => {
    const set = assignSql([
      ["constant", true],
      ["enabled", false],
      ["vectorized", true],
    ]);
    expect(set?.assignments).toBe('"constant" = ?, "enabled" = ?, "vectorized" = ?');
    expect(set?.params).toEqual([1, 0, 1]);
  });
});
