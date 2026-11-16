/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import type { RegexRule } from "../schema/regex";
import { createTestDb } from "../test-utils";
import {
  applyRegexRules,
  compileRegexRule,
  compileRegexRules,
  defaultRegexRules,
  getRegexRules,
  hasRulesFor,
  MAX_REGEX_RULES,
  parseRegexSource,
  REGEX_RULES_KEY,
} from "./regex";

/** A minimal rule with overridable fields (defaults match the schema). */
function rule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    id: "r1",
    name: "Rule",
    find: "/foo/g",
    replace: "bar",
    placement: ["ai"],
    enabled: true,
    ...overrides,
  };
}

let repos: Repositories;
beforeEach(() => {
  repos = createRepositories(createTestDb());
});

describe("parseRegexSource", () => {
  it("splits a delimited literal into pattern and flags", () => {
    expect(parseRegexSource("/foo/gi")).toEqual({ pattern: "foo", flags: "gi" });
    expect(parseRegexSource("/a\\/b/g")).toEqual({ pattern: "a\\/b", flags: "g" });
  });

  it("uses the LAST unescaped slash as the delimiter", () => {
    expect(parseRegexSource("/a/b/c/i")).toEqual({ pattern: "a/b/c", flags: "i" });
  });

  it("treats a bare pattern as flags 'g'", () => {
    expect(parseRegexSource("foo")).toEqual({ pattern: "foo", flags: "g" });
  });

  it("tolerates malformed input without throwing", () => {
    expect(parseRegexSource("/unclosed")).toEqual({ pattern: "/unclosed", flags: "g" });
    expect(parseRegexSource("/")).toEqual({ pattern: "/", flags: "g" });
    expect(parseRegexSource("[")).toEqual({ pattern: "[", flags: "g" });
  });
});

describe("compileRegexRule", () => {
  it("compiles a valid rule", () => {
    const regex = compileRegexRule(rule({ find: "/a.b/gi" }));
    expect(regex).not.toBeNull();
    expect(regex?.flags).toBe("gi");
  });

  it("returns null for an invalid pattern", () => {
    expect(compileRegexRule(rule({ find: "/[/g" }))).toBeNull();
  });

  it("returns null for invalid or duplicate flags", () => {
    expect(compileRegexRule(rule({ find: "/a/zz" }))).toBeNull();
    expect(compileRegexRule(rule({ find: "/a/gg" }))).toBeNull();
  });
});

describe("hasRulesFor", () => {
  it("is true only for an enabled rule targeting the placement", () => {
    const rules = compileRegexRules([
      rule({ id: "a", placement: ["ai"] }),
      rule({ id: "b", placement: ["user"], enabled: false }),
    ]);
    expect(hasRulesFor(rules, "ai")).toBe(true);
    expect(hasRulesFor(rules, "user")).toBe(false);
    expect(hasRulesFor(rules, "prompt")).toBe(false);
  });
});

describe("applyRegexRules", () => {
  it("applies only rules targeting the placement", () => {
    const rules = compileRegexRules([
      rule({ id: "ai", find: "/foo/g", replace: "AI", placement: ["ai"] }),
      rule({ id: "user", find: "/foo/g", replace: "USER", placement: ["user"] }),
    ]);
    expect(applyRegexRules("foo foo", rules, "ai")).toBe("AI AI");
    expect(applyRegexRules("foo foo", rules, "user")).toBe("USER USER");
    expect(applyRegexRules("foo foo", rules, "prompt")).toBe("foo foo");
  });

  it("skips disabled rules", () => {
    const rules = compileRegexRules([rule({ find: "/foo/g", replace: "bar", enabled: false })]);
    expect(applyRegexRules("foo", rules, "ai")).toBe("foo");
  });

  it("applies rules in array order", () => {
    const rules = compileRegexRules([
      rule({ id: "a", find: "/foo/g", replace: "bar", placement: ["ai"] }),
      rule({ id: "b", find: "/bar/g", replace: "baz", placement: ["ai"] }),
    ]);
    expect(applyRegexRules("foo", rules, "ai")).toBe("baz");
  });

  it("supports $1 group replacement", () => {
    const rules = compileRegexRules([
      rule({ find: "/(\\w+)@(\\w+)/g", replace: "$1 at $2", placement: ["ai"] }),
    ]);
    expect(applyRegexRules("bob@example", rules, "ai")).toBe("bob at example");
  });

  it("returns the identical string when nothing matches", () => {
    const rules = compileRegexRules([rule({ find: "/zzz/g", replace: "x", placement: ["ai"] })]);
    const input = "hello world";
    expect(applyRegexRules(input, rules, "ai")).toBe(input);
  });

  it("keeps uncompilable rules but never runs them", () => {
    const rules = compileRegexRules([rule({ find: "/[/g", replace: "x", placement: ["ai"] })]);
    expect(rules[0]?.regex).toBeNull();
    expect(applyRegexRules("a", rules, "ai")).toBe("a");
  });

  it("resets lastIndex so a reused global regex does not skip the next string", () => {
    const rules = compileRegexRules([rule({ find: "/a/g", replace: "X", placement: ["ai"] })]);
    // The same compiled global regex object is reused across messages; without
    // the lastIndex reset the second call would only match at index > 0.
    expect(applyRegexRules("a a", rules, "ai")).toBe("X X");
    expect(applyRegexRules("a a", rules, "ai")).toBe("X X");
    expect(applyRegexRules("ab", rules, "ai")).toBe("Xb");
  });
});

describe("getRegexRules", () => {
  it("returns [] when unset", () => {
    expect(getRegexRules(repos)).toEqual([]);
  });

  it("returns [] for a non-array value", () => {
    repos.settings.set(REGEX_RULES_KEY, { nope: true });
    expect(getRegexRules(repos)).toEqual([]);
  });

  it("round-trips a valid array", () => {
    const rules = [rule(), rule({ id: "r2", find: "/z/i", replace: "" })];
    repos.settings.set(REGEX_RULES_KEY, rules);
    expect(getRegexRules(repos)).toEqual(rules);
  });

  it("drops invalid entries individually", () => {
    repos.settings.set(REGEX_RULES_KEY, [
      rule({ id: "good" }),
      { id: "bad" }, // missing name/find
      "not an object",
      { id: "x", name: "Wrong placement", find: "/a/g", placement: ["nope"] },
      rule({ id: "empty-placement", placement: [] }),
    ]);
    const rules = getRegexRules(repos);
    expect(rules.map((entry) => entry.id)).toEqual(["good"]);
  });

  it("caps absurd rule counts", () => {
    const many = Array.from({ length: MAX_REGEX_RULES + 10 }, (_, index) =>
      rule({ id: `r${index}` }),
    );
    repos.settings.set(REGEX_RULES_KEY, many);
    expect(getRegexRules(repos)).toHaveLength(MAX_REGEX_RULES);
  });
});

describe("defaultRegexRules", () => {
  it("ships exactly the Quote Cleaner rule, enabled, ai-only", () => {
    const rules = defaultRegexRules();
    expect(rules).toHaveLength(1);
    const [quote] = rules;
    expect(quote?.id).toBe("quote-cleaner");
    expect(quote?.name).toBe("Quote Cleaner");
    expect(quote?.find).toBe("/[“”„″‟❝❞«»]/ig");
    expect(quote?.replace).toBe('"');
    expect(quote?.placement).toEqual(["ai"]);
    expect(quote?.enabled).toBe(true);
  });

  it("maps curly quotes to straight quotes and leaves non-ai text alone", () => {
    const rules = compileRegexRules(defaultRegexRules());
    expect(applyRegexRules("“a”", rules, "ai")).toBe('"a"');
    expect(applyRegexRules("“a”", rules, "user")).toBe("“a”");
    expect(applyRegexRules("“a”", rules, "prompt")).toBe("“a”");
  });
});
