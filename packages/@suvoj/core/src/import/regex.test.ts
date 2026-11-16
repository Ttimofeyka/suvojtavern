/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { RegexRule } from "../schema/regex";
import { parseRegexFile } from "./regex";

const valid: RegexRule = {
  id: "quote-cleaner",
  name: "Quote Cleaner",
  find: "/[“”]/g",
  replace: '"',
  placement: ["ai"],
  enabled: true,
};

describe("parseRegexFile", () => {
  it("parses a full native document", () => {
    const parsed = parseRegexFile({
      format: "suvoj.regex",
      version: 1,
      rules: [valid],
    });
    expect(parsed.rules).toEqual([valid]);
    expect(parsed.skipped).toEqual([]);
  });

  it("accepts a bare array of rules", () => {
    expect(parseRegexFile([valid]).rules).toEqual([valid]);
  });

  it("accepts a single bare rule object", () => {
    expect(parseRegexFile(valid).rules).toEqual([valid]);
  });

  it("tolerates unknown format/version values", () => {
    const parsed = parseRegexFile({ format: "something.else", version: 99, rules: [valid] });
    expect(parsed.rules).toEqual([valid]);
  });

  it("fills defaults for missing optional fields", () => {
    const parsed = parseRegexFile([{ find: "/a/g" }]);
    expect(parsed.rules).toHaveLength(1);
    const [entry] = parsed.rules;
    expect(entry?.name).toBe("Untitled rule");
    expect(entry?.replace).toBe("");
    expect(entry?.placement).toEqual(["ai", "user"]);
    expect(entry?.enabled).toBe(true);
    expect(entry?.id).toBeTruthy();
  });

  it("returns a skip with a reason for non-object input", () => {
    expect(parseRegexFile(null)).toEqual({
      rules: [],
      skipped: [{ name: "Untitled rule", reason: "not an object" }],
    });
    expect(parseRegexFile(42).rules).toEqual([]);
    expect(parseRegexFile("nope").rules).toEqual([]);
  });

  it("skips an entry with a missing find pattern", () => {
    const parsed = parseRegexFile([{ name: "No pattern" }]);
    expect(parsed.rules).toEqual([]);
    expect(parsed.skipped).toEqual([{ name: "No pattern", reason: "missing find pattern" }]);
  });

  it("skips an invalid regex and keeps its siblings", () => {
    const parsed = parseRegexFile([
      { ...valid, id: "bad", name: "Bad", find: "/[/g" },
      { ...valid, id: "good", name: "Good" },
    ]);
    expect(parsed.rules.map((entry) => entry.id)).toEqual(["good"]);
    expect(parsed.skipped).toEqual([{ name: "Bad", reason: "invalid regex pattern or flags" }]);
  });

  it("drops unknown placements and falls back when none remain", () => {
    expect(parseRegexFile([{ ...valid, placement: ["ai", "nope"] }]).rules[0]?.placement).toEqual([
      "ai",
    ]);
    expect(parseRegexFile([{ ...valid, placement: ["nope"] }]).rules[0]?.placement).toEqual([
      "ai",
      "user",
    ]);
    expect(parseRegexFile([{ ...valid, placement: "ai" }]).rules[0]?.placement).toEqual([
      "ai",
      "user",
    ]);
  });

  it("regenerates ids that are missing or duplicated within the import", () => {
    const parsed = parseRegexFile([
      valid,
      { ...valid, name: "Second" },
      { ...valid, id: "", name: "Third" },
    ]);
    const ids = parsed.rules.map((entry) => entry.id);
    expect(ids[0]).toBe("quote-cleaner");
    expect(ids[1]).toBeTruthy();
    expect(ids[1]).not.toBe("quote-cleaner");
    expect(ids[2]).toBeTruthy();
    expect(new Set(ids).size).toBe(3);
  });

  it("renames duplicate names within the imported set", () => {
    const parsed = parseRegexFile([
      { ...valid, id: "a" },
      { ...valid, id: "b" },
      { ...valid, id: "c" },
    ]);
    expect(parsed.rules.map((entry) => entry.name)).toEqual([
      "Quote Cleaner",
      "Quote Cleaner (2)",
      "Quote Cleaner (3)",
    ]);
  });
});
