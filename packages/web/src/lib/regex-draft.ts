/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RegexPlacement, RegexRule } from "./api-regex";

/**
 * Pure logic behind the Regex settings panel — the draft shape the editor
 * edits, its validation, and the comparisons the Save button gates on.
 *
 * Kept out of the component so the rules can be unit-tested without a DOM:
 * the web package's test surface is `*.test.ts` beside the source (there is
 * no `*.test.tsx`), mirroring `profile-draft.ts`.
 */

/**
 * The three placements, in display order, with the exact meanings the server
 * applies (core's `regexRuleSchema` documents the same three classes).
 */
export const PLACEMENT_OPTIONS: ReadonlyArray<{
  id: RegexPlacement;
  label: string;
  hint: string;
}> = [
  {
    id: "ai",
    label: "AI replies",
    hint: "Applied to what the model produces before it is saved; also cleans older replies.",
  },
  {
    id: "user",
    label: "Your messages",
    hint: "Used when building the prompt; your stored text is never rewritten.",
  },
  {
    id: "prompt",
    label: "Prompt blocks",
    hint: "Preset prompts, character fields, persona, lorebook entries, and summaries.",
  },
];

/**
 * Editor form state. The id is deliberately absent: a rule's identity is
 * decided by the caller (an existing rule keeps its id, a new one gets a
 * fresh uuid), so a draft can be round-tripped through `draftToRule` with
 * either.
 */
export interface RegexDraft {
  name: string;
  find: string;
  replace: string;
  placement: RegexPlacement[];
  enabled: boolean;
}

/** The validation issue shape `PUT /api/regex/rules` reports in `details`. */
export interface RegexIssue {
  path: string;
  message: string;
}

/**
 * Splits `/pattern/flags` into parts; a bare string is a pattern with flags
 * "g". The split point is the LAST unescaped `/` after the leading one, so a
 * pattern may itself contain escaped slashes.
 *
 * A local mirror of core's `engine/regex.parseRegexSource`: the web bundle
 * must not depend on @suvoj/core, but the parse MUST behave identically or
 * the editor would accept sources the server then rejects (or vice versa).
 * Tolerant on purpose — an unmatched `[` or a lone `/` never throws here;
 * whether the result compiles is decided by `new RegExp` in the validators,
 * exactly as `compileRegexRule` does server-side.
 */
export function splitRegexSource(source: string): { pattern: string; flags: string } {
  if (!source.startsWith("/")) {
    return { pattern: source, flags: "g" };
  }
  let end = -1;
  for (let i = source.length - 1; i >= 1; i--) {
    // Odd backslash run directly before the slash means it is escaped.
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && source[j] === "\\"; j--) {
      backslashes += 1;
    }
    if (source[i] === "/" && backslashes % 2 === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // No closing slash: the whole string is the pattern, matching core.
    return { pattern: source, flags: "g" };
  }
  return { pattern: source.slice(1, end), flags: source.slice(end + 1) };
}

/**
 * True when `find` compiles. This is the same test the server runs
 * (`compileRegexRule`): "does `new RegExp` accept it" — duplicate or unknown
 * flags fail through the same constructor throw, so there is no hand-rolled
 * flag list to drift from the engine's.
 *
 * A blank source is rejected too. `new RegExp("", "g")` is technically valid
 * but the server's schema requires a non-empty `find`, and an empty pattern
 * would match at every position — never what the user meant.
 */
function findCompiles(find: string): boolean {
  if (find === "") {
    return false;
  }
  const { pattern, flags } = splitRegexSource(find);
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one rule's transform for the editor's live preview. Returns null when
 * the `find` source does not compile (the preview then shows "invalid regex"
 * instead of a stale result).
 */
export function previewReplace(find: string, replace: string, input: string): string | null {
  if (!findCompiles(find)) {
    return null;
  }
  const { pattern, flags } = splitRegexSource(find);
  // findCompiles proved the constructor accepts it, so this cannot throw.
  return input.replace(new RegExp(pattern, flags), replace);
}

/** A blank draft, or one mirroring `rule`; placement is copied, never aliased. */
export function draftFrom(rule: RegexRule | null): RegexDraft {
  return {
    name: rule?.name ?? "",
    find: rule?.find ?? "",
    replace: rule?.replace ?? "",
    placement: rule === null ? ["ai"] : [...rule.placement],
    enabled: rule?.enabled ?? true,
  };
}

/** The stored rule a draft describes; the `id` stays the caller's. */
export function draftToRule(draft: RegexDraft, id: string): RegexRule {
  return {
    id,
    name: draft.name.trim(),
    // `find` and `replace` are NOT trimmed: leading/trailing whitespace is
    // meaningful in both a regex source and a replacement string.
    find: draft.find,
    replace: draft.replace,
    placement: [...draft.placement],
    enabled: draft.enabled,
  };
}

/**
 * Client-side mirror of the server's per-rule checks, exactly the same
 * `path`/`message` strings the route's `details` carry, plus the two the zod
 * schema enforces before the route ever sees the rule. The editor edits one
 * rule at a time, so the index is always 0; `validateRules` covers a whole
 * list.
 */
export function validateDraft(draft: RegexDraft): RegexIssue[] {
  const issues: RegexIssue[] = [];
  if (draft.name.trim() === "") {
    issues.push({ path: "rules.0.name", message: "name is required" });
  }
  if (!findCompiles(draft.find)) {
    issues.push({ path: "rules.0.find", message: "invalid regex" });
  }
  // The server schema rejects an empty placement list outright: a rule that
  // touches nothing is always a bug, never a no-op.
  if (draft.placement.length === 0) {
    issues.push({ path: "rules.0.placement", message: "select at least one target" });
  }
  return issues;
}

/**
 * Whole-set validation with real indices, for the rules about to be PUT: every
 * `find` must compile and no two rules may share an id. Mirrors the server's
 * `ruleIssues` so a doomed save is caught before the round-trip (and a 400's
 * `details` still map back onto the same paths if one slips through).
 */
export function validateRules(rules: RegexRule[]): RegexIssue[] {
  const issues: RegexIssue[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    if (!findCompiles(rule.find)) {
      issues.push({ path: `rules.${index}.find`, message: "invalid regex" });
    }
    if (seen.has(rule.id)) {
      issues.push({ path: `rules.${index}.id`, message: "duplicate rule id" });
    }
    seen.add(rule.id);
  });
  return issues;
}

/**
 * Placement equality is order-insensitive: the engine only ever asks
 * `.includes(placement)`, so a rule listed as ["user", "ai"] behaves exactly
 * like ["ai", "user"]. Comparing sets keeps a pure reorder from lighting up
 * the Save button.
 */
function samePlacement(a: RegexPlacement[], b: RegexPlacement[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((entry) => b.includes(entry));
}

/** Field-wise rule equality (id included). */
export function isRuleEqual(a: RegexRule, b: RegexRule): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.find === b.find &&
    a.replace === b.replace &&
    a.enabled === b.enabled &&
    samePlacement(a.placement, b.placement)
  );
}

/** True when saving `draft` over `rule` would actually change the stored rule. */
export function hasRuleChanges(draft: RegexDraft, rule: RegexRule): boolean {
  return !isRuleEqual(draftToRule(draft, rule.id), rule);
}

// --- Mapping a server 400's `details` back onto controls ---
//
// A PUT 400 carries `details: Array<{ path, message }>` where `path` is
// `rules.<index>.<field>`. Two surfaces consume that: the bottom Save shows
// issues on the offending ROW, and the editor shows them on the FIELD it is
// editing. These helpers keep the (subtle) index re-anchoring pure and tested.

/** The rule fields the editor renders an inline error for. */
export const EDITOR_FIELDS: ReadonlySet<string> = new Set(["name", "find", "placement"]);

/**
 * Fields a per-row list error can name and the row actually renders. Anything
 * else (a body-shape error on `rules`, or a zod issue on a field the row has
 * no place for) must fall back to the banner rather than be dropped silently.
 */
export const ROW_FIELDS: ReadonlySet<string> = new Set(["name", "find", "placement", "id"]);

/** The `{path, message}` entries of an error's free-form `details`, or []. */
export function detailIssues(details: unknown): RegexIssue[] {
  if (!Array.isArray(details)) {
    return [];
  }
  return (details as Array<{ path?: unknown; message?: unknown }>).filter(
    (detail): detail is RegexIssue =>
      typeof detail?.path === "string" && typeof detail.message === "string",
  );
}

/** One issue's message by `rules.<index>.<field>` path, or undefined. */
export function issueMessage(
  issues: RegexIssue[],
  index: number,
  field: string,
): string | undefined {
  return issues.find((issue) => issue.path === `rules.${index}.${field}`)?.message;
}

/** True when a detail path names a rule index AND a field the row renders. */
export function mapsToRow(path: string): boolean {
  const parts = path.split(".");
  return parts[0] === "rules" && /^\d+$/.test(parts[1] ?? "") && ROW_FIELDS.has(parts[2] ?? "");
}

/**
 * Splits a server 400's details for the editor: the ones naming the edited
 * rule (`index`) are re-anchored onto `rules.0.<field>` so the editor's
 * `issueMessage` lookups find them; everything else — a sibling rule the PUT
 * also carried, or a `rules.<n>.id` issue — is left for the list to render on
 * the offending row.
 */
export function splitEditorDetails(
  issues: RegexIssue[],
  index: number,
): { mine: RegexIssue[]; others: RegexIssue[] } {
  const mine: RegexIssue[] = [];
  const others: RegexIssue[] = [];
  for (const issue of issues) {
    const parts = issue.path.split(".");
    const field = parts[parts.length - 1] ?? "";
    if (parts[1] === String(index) && EDITOR_FIELDS.has(field)) {
      mine.push({ path: `rules.0.${field}`, message: issue.message });
    } else {
      others.push(issue);
    }
  }
  return { mine, others };
}
