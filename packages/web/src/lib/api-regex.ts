/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { api } from "./api";

/** Which message classes a rule touches (mirrors core's `regexPlacementSchema`). */
export type RegexPlacement = "ai" | "user" | "prompt";

/**
 * A stored regex rule (GET/PUT /api/regex/rules). Mirrors core's
 * `regexRuleSchema`: `find` is the raw source — a `/pattern/flags` literal or
 * a bare pattern whose flags default to "g" — and `placement` names exactly
 * which message classes the rule is applied to.
 */
export interface RegexRule {
  id: string;
  name: string;
  find: string;
  replace: string;
  /** At least one entry; unknown values are rejected server-side. */
  placement: RegexPlacement[];
  enabled: boolean;
}

/** One entry the server's importer could not use, with the reason why. */
export interface RegexImportSkipped {
  name: string;
  reason: string;
}

/** Response of POST /api/regex/rules/import: the stored set and what was skipped. */
export interface RegexImportResult {
  rules: RegexRule[];
  skipped: RegexImportSkipped[];
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Every stored rule. Rules live under the `regex_rules` settings key, which is
 * deliberately excluded from GET/PUT /api/settings — these routes are its
 * only readers and writers.
 */
export function listRegexRules(): Promise<RegexRule[]> {
  return api<{ rules: RegexRule[] }>("/api/regex/rules").then((body) => body.rules);
}

/**
 * Replaces the whole stored rule set. The write is all-or-nothing: on a 400
 * the `details` array names the offending index (`rules.<n>.find` for an
 * uncompilable pattern, `rules.<n>.id` for a duplicate id) and nothing is
 * written, so the caller can surface those next to the named rule.
 */
export function putRegexRules(rules: RegexRule[]): Promise<RegexRule[]> {
  return api<{ rules: RegexRule[] }>("/api/regex/rules", jsonInit("PUT", { rules })).then(
    (body) => body.rules,
  );
}

/**
 * Imports a native (or hand-written) regex document. `mode` "append" keeps the
 * stored rules (renaming name collisions) and "replace" swaps the whole set.
 * The document's shape is detected leniently server-side; unusable entries are
 * reported in `skipped` instead of failing the whole import.
 */
export function importRegexRules(
  doc: unknown,
  mode: "append" | "replace",
): Promise<RegexImportResult> {
  return api(`/api/regex/rules/import?mode=${mode}`, jsonInit("POST", doc));
}

/** Download URL of the native regex export — a plain anchor's `download` target. */
export function regexExportUrl(): string {
  return "/api/regex/rules/export";
}
