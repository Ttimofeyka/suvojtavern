/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { RegexRule } from "./api-regex";
import {
  detailIssues,
  draftFrom,
  draftToRule,
  hasRuleChanges,
  isRuleEqual,
  issueMessage,
  mapsToRow,
  previewReplace,
  type RegexIssue,
  splitEditorDetails,
  splitRegexSource,
  validateDraft,
  validateRules,
} from "./regex-draft";

/** A stored rule fixture with overridable fields. */
function rule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    id: "r1",
    name: "Quote Cleaner",
    find: "/[“”]/ig",
    replace: '"',
    placement: ["ai"],
    enabled: true,
    ...overrides,
  };
}

describe("draftFrom", () => {
  it("starts blank for a new rule with the ai placement and enabled on", () => {
    expect(draftFrom(null)).toEqual({
      name: "",
      find: "",
      replace: "",
      placement: ["ai"],
      enabled: true,
    });
  });

  it("mirrors an existing rule, copying the placement array", () => {
    const source = rule({ placement: ["ai", "prompt"] });
    const draft = draftFrom(source);
    expect(draft).toEqual({
      name: "Quote Cleaner",
      find: "/[“”]/ig",
      replace: '"',
      placement: ["ai", "prompt"],
      enabled: true,
    });
    // A copy, not an alias: editing one must not mutate the other.
    draft.placement.push("user");
    expect(source.placement).toEqual(["ai", "prompt"]);
  });

  it("carries a disabled rule's flag over", () => {
    expect(draftFrom(rule({ enabled: false })).enabled).toBe(false);
  });
});

describe("draftToRule", () => {
  it("round-trips a draft through draftToRule back into draftFrom", () => {
    const original = rule({ id: "keep", name: "  Spaced  ", find: "/x/g", replace: " y " });
    const stored = draftToRule(draftFrom(original), original.id);
    // The name is trimmed; find/replace keep their whitespace (both are
    // meaningful in a pattern and a replacement).
    expect(stored).toEqual({
      id: "keep",
      name: "Spaced",
      find: "/x/g",
      replace: " y ",
      placement: ["ai"],
      enabled: true,
    });
    expect(draftFrom(stored)).toEqual({ ...draftFrom(original), name: "Spaced" });
  });

  it("uses the caller's id and copies the placement", () => {
    const draft = draftFrom(rule({ placement: ["user"] }));
    const stored = draftToRule(draft, "fresh");
    expect(stored.id).toBe("fresh");
    stored.placement.push("ai");
    expect(draft.placement).toEqual(["user"]);
  });
});

describe("splitRegexSource", () => {
  it("splits /pattern/flags at the last unescaped slash", () => {
    expect(splitRegexSource("/a/b/i")).toEqual({ pattern: "a/b", flags: "i" });
    expect(splitRegexSource("/foo/gi")).toEqual({ pattern: "foo", flags: "gi" });
  });

  it("keeps an escaped slash inside the pattern", () => {
    expect(splitRegexSource("/a\\/b/g")).toEqual({ pattern: "a\\/b", flags: "g" });
  });

  it("treats a bare string as a pattern with the default g flag", () => {
    expect(splitRegexSource("foo")).toEqual({ pattern: "foo", flags: "g" });
  });

  it("keeps the whole string when there is no closing slash", () => {
    expect(splitRegexSource("/unclosed")).toEqual({ pattern: "/unclosed", flags: "g" });
    expect(splitRegexSource("/")).toEqual({ pattern: "/", flags: "g" });
  });

  it("splits at the last slash, so a pattern may contain unescaped slashes", () => {
    expect(splitRegexSource("/a/b/c/i")).toEqual({ pattern: "a/b/c", flags: "i" });
  });
});

describe("validateDraft", () => {
  it("accepts a valid rule", () => {
    expect(validateDraft(draftFrom(rule()))).toEqual([]);
  });

  it("accepts a bare pattern (flags default to g)", () => {
    expect(validateDraft({ ...draftFrom(null), name: "Bare", find: "foo" })).toEqual([]);
  });

  it("rejects an uncompilable find with the server's exact pair", () => {
    const draft = { ...draftFrom(rule()), find: "/[/g" };
    expect(validateDraft(draft)).toEqual([{ path: "rules.0.find", message: "invalid regex" }]);
  });

  it("rejects unknown/duplicate flags through the same compile test", () => {
    expect(validateDraft({ ...draftFrom(rule()), find: "/a/zz" })).toEqual([
      { path: "rules.0.find", message: "invalid regex" },
    ]);
    expect(validateDraft({ ...draftFrom(rule()), find: "/a/gg" })).toEqual([
      { path: "rules.0.find", message: "invalid regex" },
    ]);
  });

  it("rejects an empty find (the server schema requires a non-empty source)", () => {
    expect(validateDraft({ ...draftFrom(rule()), find: "" })).toEqual([
      { path: "rules.0.find", message: "invalid regex" },
    ]);
  });

  it("rejects a missing name with rules.0.name", () => {
    expect(validateDraft({ ...draftFrom(rule()), name: "   " })).toEqual([
      { path: "rules.0.name", message: "name is required" },
    ]);
  });

  it("rejects an empty placement with rules.0.placement", () => {
    expect(validateDraft({ ...draftFrom(rule()), placement: [] })).toEqual([
      { path: "rules.0.placement", message: "select at least one target" },
    ]);
  });

  it("reports every issue at once, in name/find/placement order", () => {
    expect(
      validateDraft({ name: "", find: "(", replace: "", placement: [], enabled: true }),
    ).toEqual([
      { path: "rules.0.name", message: "name is required" },
      { path: "rules.0.find", message: "invalid regex" },
      { path: "rules.0.placement", message: "select at least one target" },
    ]);
  });
});

describe("validateRules", () => {
  it("accepts a clean set", () => {
    expect(validateRules([rule({ id: "a" }), rule({ id: "b", find: "/z/i" })])).toEqual([]);
  });

  it("names the right index for an invalid find", () => {
    const rules = [rule({ id: "a" }), rule({ id: "b", find: "/[/g" })];
    expect(validateRules(rules)).toEqual([{ path: "rules.1.find", message: "invalid regex" }]);
  });

  it("names the second occurrence for a duplicate id", () => {
    const rules = [rule({ id: "same" }), rule({ id: "same", name: "Two" })];
    expect(validateRules(rules)).toEqual([{ path: "rules.1.id", message: "duplicate rule id" }]);
  });

  it("reports both a bad find and a duplicate at their real indices", () => {
    const rules = [rule({ id: "same" }), rule({ id: "same", find: "/[/g" })];
    expect(validateRules(rules)).toEqual([
      { path: "rules.1.find", message: "invalid regex" },
      { path: "rules.1.id", message: "duplicate rule id" },
    ]);
  });
});

describe("previewReplace", () => {
  it("applies the rule to the input", () => {
    expect(previewReplace("/[“”]/g", '"', "say “hi”")).toBe('say "hi"');
  });

  it("honours capture groups", () => {
    expect(previewReplace("/(\\w+)@(\\w+)/g", "$2/$1", "me@here")).toBe("here/me");
  });

  it("returns null for an uncompilable source", () => {
    expect(previewReplace("/[/g", "x", "text")).toBeNull();
  });
});

describe("isRuleEqual", () => {
  it("compares placement order-insensitively (the engine only uses includes)", () => {
    expect(
      isRuleEqual(rule({ placement: ["ai", "user"] }), rule({ placement: ["user", "ai"] })),
    ).toBe(true);
  });

  it("detects a genuinely changed field", () => {
    expect(isRuleEqual(rule(), rule({ replace: "changed" }))).toBe(false);
    expect(isRuleEqual(rule(), rule({ enabled: false }))).toBe(false);
    expect(isRuleEqual(rule(), rule({ id: "other" }))).toBe(false);
  });
});

describe("hasRuleChanges", () => {
  it("is false when the draft mirrors the stored rule", () => {
    const stored = rule();
    expect(hasRuleChanges(draftFrom(stored), stored)).toBe(false);
  });

  it("ignores a pure whitespace difference in the name (draftToRule trims)", () => {
    const stored = rule({ name: "Quote Cleaner" });
    expect(hasRuleChanges({ ...draftFrom(stored), name: "  Quote Cleaner  " }, stored)).toBe(false);
  });

  it("is false for an order-only placement change", () => {
    const stored = rule({ placement: ["ai", "user"] });
    expect(hasRuleChanges({ ...draftFrom(stored), placement: ["user", "ai"] }, stored)).toBe(false);
  });

  it("is true when a field actually changed", () => {
    const stored = rule();
    expect(hasRuleChanges({ ...draftFrom(stored), replace: "different" }, stored)).toBe(true);
    expect(hasRuleChanges({ ...draftFrom(stored), enabled: false }, stored)).toBe(true);
    expect(hasRuleChanges({ ...draftFrom(stored), placement: ["ai", "prompt"] }, stored)).toBe(
      true,
    );
  });
});

describe("detailIssues", () => {
  it("keeps well-formed {path, message} entries and drops anything else", () => {
    expect(
      detailIssues([
        { path: "rules.0.find", message: "invalid regex" },
        { path: "rules.1.id", message: "duplicate rule id" },
        "nope",
        { path: 3, message: "bad" },
        { path: "x" },
        null,
      ]),
    ).toEqual([
      { path: "rules.0.find", message: "invalid regex" },
      { path: "rules.1.id", message: "duplicate rule id" },
    ]);
  });

  it("returns [] for a non-array details payload", () => {
    expect(detailIssues(undefined)).toEqual([]);
    expect(detailIssues({ path: "rules.0.find" })).toEqual([]);
  });
});

describe("issueMessage", () => {
  const issues: RegexIssue[] = [
    { path: "rules.0.find", message: "invalid regex" },
    { path: "rules.1.find", message: "invalid regex" },
  ];

  it("matches on the exact rules.<index>.<field> path", () => {
    expect(issueMessage(issues, 1, "find")).toBe("invalid regex");
    expect(issueMessage(issues, 2, "find")).toBeUndefined();
    expect(issueMessage(issues, 0, "name")).toBeUndefined();
  });
});

describe("mapsToRow", () => {
  it("accepts a numbered rules path with a field the row renders", () => {
    expect(mapsToRow("rules.0.find")).toBe(true);
    expect(mapsToRow("rules.12.id")).toBe(true);
    expect(mapsToRow("rules.3.placement")).toBe(true);
  });

  it("rejects a body-shape path, a non-numeric index, and unknown fields", () => {
    expect(mapsToRow("rules")).toBe(false);
    expect(mapsToRow("rules.x.find")).toBe(false);
    expect(mapsToRow("rules.0.unknown")).toBe(false);
    // `replace` is accepted by the schema but the row has no error line for it.
    expect(mapsToRow("rules.0.replace")).toBe(false);
  });
});

describe("splitEditorDetails", () => {
  it("re-anchors the edited rule's field issues onto rules.0.<field>", () => {
    const issues: RegexIssue[] = [
      { path: "rules.2.find", message: "invalid regex" },
      { path: "rules.2.name", message: "name is required" },
    ];
    expect(splitEditorDetails(issues, 2)).toEqual({
      mine: [
        { path: "rules.0.find", message: "invalid regex" },
        { path: "rules.0.name", message: "name is required" },
      ],
      others: [],
    });
  });

  it("hands a sibling rule's issue and a rules.<n>.id issue to the list", () => {
    const issues: RegexIssue[] = [
      { path: "rules.0.find", message: "invalid regex" },
      { path: "rules.1.id", message: "duplicate rule id" },
      { path: "rules.1.find", message: "invalid regex" },
    ];
    expect(splitEditorDetails(issues, 1)).toEqual({
      // The edited rule's own find; its `.id` issue has no editor field.
      mine: [{ path: "rules.0.find", message: "invalid regex" }],
      others: [
        { path: "rules.0.find", message: "invalid regex" },
        { path: "rules.1.id", message: "duplicate rule id" },
      ],
    });
  });
});
