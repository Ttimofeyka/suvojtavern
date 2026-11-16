/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { engine, st } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";

/**
 * Regex rule routes — the only writer of the `regex_rules` settings key.
 *
 * `regex_rules` is deliberately NOT part of settings.ts' `SETTINGS_KEYS`: an
 * arbitrary client `PUT /api/settings` must never be able to wipe (or
 * half-overwrite) the rule set. These dedicated routes are its sole writers.
 *
 * The rule engine (`engine/regex`) owns parsing/validation/applying; this
 * module owns the HTTP contract: all-or-nothing writes, attachment
 * import/export, and the append-time dedupe/limit bookkeeping core cannot
 * know about (it has no view of the stored rules).
 */

/** Body of PUT /api/regex/rules: the complete replacement rule set. */
const putRulesSchema = z.object({
  rules: z.array(engine.regexRuleSchema).max(engine.MAX_REGEX_RULES),
});

/** Why a rule cannot be stored, tied to the field the UI must highlight. */
interface RuleIssue {
  path: string;
  message: string;
}

/**
 * Validates the candidate set beyond zod: every rule must compile through
 * the same path the engine runs (`compileRegexRule`), and no two rules may
 * share an id. Returns the issues to report, or null when the set is clean.
 *
 * All-or-nothing on purpose: a half-stored rule set (some rules saved, some
 * rejected) is worse than a rejected save — the UI shows the per-field
 * details and the store still holds the last good set.
 */
function ruleIssues(rules: readonly engine.RegexRule[]): RuleIssue[] | null {
  const issues: RuleIssue[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    if (engine.compileRegexRule(rule) === null) {
      issues.push({ path: `rules.${index}.find`, message: "invalid regex" });
    }
    if (seen.has(rule.id)) {
      issues.push({ path: `rules.${index}.id`, message: "duplicate rule id" });
    }
    seen.add(rule.id);
  });
  return issues.length > 0 ? issues : null;
}

/**
 * Download headers — a deliberate local copy of transfer-export.ts' private
 * `download` helper (nothing new is exported from there). The regex export
 * has one fixed filename, so the sibling `downloadName` sanitiser is not
 * needed and is not copied.
 */
function download(
  filename: string,
  type: string,
): { "Content-Type": string; "Content-Disposition": string } {
  return {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
}

/**
 * Dedupes a freshly imported rule's name against the names already stored
 * (and the ones taken earlier in this same import loop): "Name (2)", "Name
 * (3)", … — the same suffix scheme core's `parseRegexFile` applies within the
 * imported set, continued over the union. `taken` is updated in place.
 *
 * Division of labour: core dedupes and regenerates ids WITHIN the imported
 * document (it never sees storage); this loop extends that against the
 * ALREADY-STORED set — a job only the route can do.
 */
function uniqueStoredName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${name} (${suffix})`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

export function regexRoutes(deps: RouteDeps): Hono {
  const { repos } = deps;
  const app = new Hono();

  app.get("/api/regex/rules", (c) => c.json({ rules: engine.getRegexRules(repos) }));

  app.put("/api/regex/rules", async (c) => {
    const parsed = parseJsonBody(putRulesSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const issues = ruleIssues(parsed.value.rules);
    if (issues !== null) {
      return c.json(badRequest("Invalid regex rule", issues), 400);
    }
    repos.settings.set(engine.REGEX_RULES_KEY, parsed.value.rules);
    return c.json({ rules: parsed.value.rules });
  });

  app.get("/api/regex/rules/export", () => {
    const json = JSON.stringify(st.buildRegexFile(engine.getRegexRules(repos)), null, 2);
    return new Response(json, { headers: download("suvoj-regex.json", "application/json") });
  });

  app.post("/api/regex/rules/import", async (c) => {
    const mode = c.req.query("mode") ?? "append";
    if (mode !== "append" && mode !== "replace") {
      return c.json(badRequest("mode must be one of: append, replace"), 400);
    }
    const stored = engine.getRegexRules(repos);
    const imported = st.parseRegexFile(await c.req.json().catch(() => null));
    const skipped = [...imported.skipped];

    let rules: engine.RegexRule[];
    if (mode === "replace") {
      // Replace starts clean: core's in-import dedupe is all that is needed,
      // and the only cap below is the limit.
      rules = imported.rules;
    } else {
      // Append keeps the stored rules verbatim, then folds the imported ones
      // in after them. Names are deduped against the STORED set (core only
      // dedupes within the import), and an imported rule whose id already
      // exists is re-issued a fresh one — an import must never silently
      // overwrite a stored rule.
      const takenNames = new Set(stored.map((rule) => rule.name.toLowerCase()));
      const takenIds = new Set(stored.map((rule) => rule.id));
      rules = [...stored];
      for (const rule of imported.rules) {
        // A collision with a stored id would overwrite that rule on the next
        // read; re-issue a fresh id instead (retrying against every id handed
        // out so far, the same guard core's importer uses).
        let id = rule.id;
        while (takenIds.has(id)) {
          id = crypto.randomUUID();
        }
        takenIds.add(id);
        rules.push({ ...rule, id, name: uniqueStoredName(rule.name, takenNames) });
      }
    }

    // The cap applies to the FINAL set. Anything past it is reported as
    // skipped rather than silently dropped, so the UI can tell the user
    // exactly which entries did not make it.
    if (rules.length > engine.MAX_REGEX_RULES) {
      for (const rule of rules.slice(engine.MAX_REGEX_RULES)) {
        skipped.push({ name: rule.name, reason: `rule limit reached (${engine.MAX_REGEX_RULES})` });
      }
      rules = rules.slice(0, engine.MAX_REGEX_RULES);
    }

    repos.settings.set(engine.REGEX_RULES_KEY, rules);
    return c.json({ rules, skipped });
  });

  return app;
}
