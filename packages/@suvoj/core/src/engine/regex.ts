/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Repositories } from "../repositories";
import {
  type RegexPlacement,
  type RegexRule,
  regexPlacementSchema,
  regexRuleSchema,
} from "../schema/regex";

/**
 * The regex schema is re-exported here so consumers of the `engine`
 * namespace reach the rule types and their zod validators without also
 * importing the schema namespace (`engine.regexRuleSchema`).
 */
export { type RegexPlacement, type RegexRule, regexPlacementSchema, regexRuleSchema };

/**
 * The regex rule engine — user-defined find/replace rules applied during
 * prompt assembly (and, in later phases, to persisted replies).
 *
 * A rule's `find` is stored raw: either a `/pattern/flags` literal or a bare
 * pattern (flags then default to "g"). Parsing is deliberately tolerant — an
 * unmatched `[` or a lone `/` must never throw here; whether the result is a
 * usable regex is decided once, by `compileRegexRule`'s `try/catch`.
 *
 * SECURITY / ReDoS: patterns are user-supplied and execute in-process. v1
 * only validates that a pattern COMPILES and caps the rule count — it does
 * no backtracking analysis, so a catastrophic-backtracking pattern can still
 * stall a generation. A per-replace timeout or a safe-regex check is a known
 * follow-up, not part of v1.
 */

/** Settings key holding the global regex rule array. */
export const REGEX_RULES_KEY = "regex_rules";

/**
 * Hard cap on stored rules. The rules load on EVERY prompt build, so an
 * absurd array (a corrupt store or a hostile import) would make each
 * generation walk thousands of regexes; anything past the cap is ignored
 * rather than failing the read.
 */
export const MAX_REGEX_RULES = 500;

/**
 * The built-in rule set seeded into an empty settings store. The id is a
 * readable, stable slug (NOT `newId()`) so the default is deterministic and
 * re-seeding is idempotent.
 */
export function defaultRegexRules(): RegexRule[] {
  return [
    {
      id: "quote-cleaner",
      name: "Quote Cleaner",
      find: "/[“”„″‟❝❞«»]/ig",
      replace: '"',
      placement: ["ai"],
      enabled: true,
    },
  ];
}

/** True when `index` sits behind an odd number of backslashes (i.e. escaped). */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Splits `/pattern/flags` into parts; a bare string is a pattern with flags
 * "g". The split point is the LAST unescaped `/` after the leading one, so a
 * pattern may itself contain escaped slashes.
 */
export function parseRegexSource(source: string): { pattern: string; flags: string } {
  if (!source.startsWith("/")) {
    return { pattern: source, flags: "g" };
  }
  let end = -1;
  for (let i = source.length - 1; i >= 1; i--) {
    if (source[i] === "/" && !isEscaped(source, i)) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // No closing slash: keep the whole string as the pattern. Whether that is
    // a usable regex is `compileRegexRule`'s call, not ours.
    return { pattern: source, flags: "g" };
  }
  return { pattern: source.slice(1, end), flags: source.slice(end + 1) };
}

/**
 * Compiles one rule, or null when the pattern/flags are invalid. Validation
 * is exactly "does `new RegExp` accept it" — duplicate or unknown flags fail
 * through the same constructor throw, so there is no hand-rolled flag check
 * to drift from the engine's.
 */
export function compileRegexRule(rule: RegexRule): RegExp | null {
  const { pattern, flags } = parseRegexSource(rule.find);
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** One rule paired with its compiled regex (`null` when uncompilable). */
export interface CompiledRegexRule {
  rule: RegexRule;
  regex: RegExp | null;
}

/** Compiles a rule list in order (uncompilable rules are kept, with regex null). */
export function compileRegexRules(rules: readonly RegexRule[]): CompiledRegexRule[] {
  return rules.map((rule) => ({ rule, regex: compileRegexRule(rule) }));
}

/** True when at least one ENABLED rule targets `placement`. */
export function hasRulesFor(
  rules: readonly CompiledRegexRule[],
  placement: RegexPlacement,
): boolean {
  return rules.some((entry) => entry.rule.enabled && entry.rule.placement.includes(placement));
}

/**
 * Applies every enabled rule targeting `placement`, in array order. The
 * early return keeps the common "no rules" case allocation-free.
 *
 * `lastIndex` is reset before each replace: the same compiled object is
 * reused across every rendered block of a generation, and a global regex is
 * stateful — a stale index would silently skip the start of the next string.
 */
export function applyRegexRules(
  text: string,
  rules: readonly CompiledRegexRule[],
  placement: RegexPlacement,
): string {
  let result = text;
  for (const entry of rules) {
    const { rule, regex } = entry;
    if (!rule.enabled || regex === null || !rule.placement.includes(placement)) {
      continue;
    }
    regex.lastIndex = 0;
    result = result.replace(regex, rule.replace);
  }
  return result;
}

/**
 * Reads + validates the stored rules (empty array when unset/corrupt).
 * Entries are validated INDIVIDUALLY: one bad entry is dropped while its
 * valid siblings survive, so a single corrupt rule can never disable every
 * other rule (nor the generation).
 */
export function getRegexRules(repos: Repositories): RegexRule[] {
  const stored = repos.settings.get(REGEX_RULES_KEY);
  if (!Array.isArray(stored)) {
    return [];
  }
  const rules: RegexRule[] = [];
  for (const entry of stored.slice(0, MAX_REGEX_RULES)) {
    const parsed = regexRuleSchema.safeParse(entry);
    if (parsed.success) {
      rules.push(parsed.data);
    }
  }
  return rules;
}
