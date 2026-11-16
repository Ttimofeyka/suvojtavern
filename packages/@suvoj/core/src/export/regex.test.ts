/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { parseRegexFile } from "../import/regex";
import type { RegexRule } from "../schema/regex";
import { buildRegexFile, REGEX_FILE_FORMAT, REGEX_FILE_VERSION } from "./regex";

const rules: RegexRule[] = [
  {
    id: "quote-cleaner",
    name: "Quote Cleaner",
    find: "/[“”]/g",
    replace: '"',
    placement: ["ai"],
    enabled: true,
  },
  {
    id: "strip-tags",
    name: "Strip tags",
    find: "/<[^>]+>/g",
    replace: "",
    placement: ["ai", "user"],
    enabled: false,
  },
];

describe("buildRegexFile", () => {
  it("emits the format marker, version and rules", () => {
    const file = buildRegexFile(rules);
    expect(file.format).toBe(REGEX_FILE_FORMAT);
    expect(file.version).toBe(REGEX_FILE_VERSION);
    expect(file.rules).toEqual(rules);
  });

  it("copies rules so callers cannot mutate the store's objects", () => {
    const file = buildRegexFile(rules);
    file.rules[0]?.placement.push("prompt");
    expect(rules[0]?.placement).toEqual(["ai"]);
  });

  it("round-trips through parseRegexFile with ids preserved", () => {
    const parsed = parseRegexFile(buildRegexFile(rules));
    expect(parsed.skipped).toEqual([]);
    expect(parsed.rules).toEqual(rules);
  });

  it("handles an empty rule list", () => {
    expect(buildRegexFile([]).rules).toEqual([]);
    expect(parseRegexFile(buildRegexFile([]))).toEqual({ rules: [], skipped: [] });
  });
});
