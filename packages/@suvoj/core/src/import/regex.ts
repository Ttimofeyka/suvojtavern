/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compileRegexRule } from "../engine/regex";
import type { RegexPlacement, RegexRule } from "../schema/regex";
import { regexPlacementSchema } from "../schema/regex";
import { newId } from "../util";

/**
 * Regex rule import: lenient parsing of a native (or hand-written) document
 * — see ../export/regex for the emitted shape.
 *
 * Unlike the preset importer this never throws: a settings-UI import must
 * survive arbitrary JSON, so unusable entries are collected into `skipped`
 * with a human-readable reason while every valid sibling still imports.
 * v1 is native-only (ST regex scripts are a different surface, not
 * converted here), but the `format`/`version` fields are tolerated rather
 * than enforced so a hand-written file with a bare array — or even a single
 * rule — still imports.
 *
 * Ids are always fresh for missing/duplicate entries: imports must never
 * collide with existing stored rows. Collisions with ALREADY-STORED rule
 * names are the route layer's concern (Phase B) — this module only
 * deduplicates names within the imported set itself.
 */

/** One entry that could not be imported, with the reason why. */
export interface RegexImportSkipped {
  name: string;
  reason: string;
}

export interface ParsedRegexFile {
  rules: RegexRule[];
  skipped: RegexImportSkipped[];
}

/** True when `raw` is a plain (non-array, non-null) object. */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** The placements this rule targets: unknown values dropped, never empty. */
function sanitizePlacement(raw: unknown): RegexPlacement[] {
  if (!Array.isArray(raw)) {
    return ["ai", "user"];
  }
  const allowed = new Set<string>(regexPlacementSchema.options);
  const seen = new Set<string>();
  const placement: RegexPlacement[] = [];
  for (const value of raw) {
    if (typeof value === "string" && allowed.has(value) && !seen.has(value)) {
      seen.add(value);
      placement.push(value as RegexPlacement);
    }
  }
  return placement.length > 0 ? placement : ["ai", "user"];
}

/** "Name (2)", "Name (3)", … — the first suffix whose lowercase form is free. */
function uniqueRuleName(name: string, takenLower: Set<string>): string {
  let candidate = name;
  for (let suffix = 2; takenLower.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${name} (${suffix})`;
  }
  takenLower.add(candidate.toLowerCase());
  return candidate;
}

/** Non-empty string id, or undefined. */
function usableId(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The array of candidate entries a document carries (see module note). */
function entriesOf(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!isRecord(raw)) {
    return null;
  }
  if (Array.isArray(raw.rules)) {
    return raw.rules;
  }
  // A single bare rule object is accepted as a one-rule document.
  return [raw];
}

/**
 * Lenient parse of a native (or hand-written) regex document. Never throws:
 * malformed input yields `{ rules: [], skipped: [{ reason: "not an object" }] }`.
 */
export function parseRegexFile(input: unknown): ParsedRegexFile {
  const entries = entriesOf(input);
  if (entries === null) {
    return { rules: [], skipped: [{ name: "Untitled rule", reason: "not an object" }] };
  }

  const skipped: RegexImportSkipped[] = [];
  const takenIds = new Set<string>();
  const takenNames = new Set<string>();
  const rules: RegexRule[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped.push({ name: "Untitled rule", reason: "not an object" });
      continue;
    }
    const rawName =
      typeof entry.name === "string" && entry.name !== "" ? entry.name : "Untitled rule";
    const find = typeof entry.find === "string" ? entry.find : "";
    if (find === "") {
      skipped.push({ name: rawName, reason: "missing find pattern" });
      continue;
    }

    // The candidate must compile through the SAME path the engine uses
    // (engine/regex), so what imports is exactly what runs at generation.
    const candidate: RegexRule = {
      id: usableId(entry.id) ?? "",
      name: rawName,
      find,
      replace: typeof entry.replace === "string" ? entry.replace : "",
      placement: sanitizePlacement(entry.placement),
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
    };
    if (compileRegexRule(candidate) === null) {
      skipped.push({ name: rawName, reason: "invalid regex pattern or flags" });
      continue;
    }

    // Missing or in-set-duplicate id → a fresh uuid (retry on the astronomically
    // unlikely collision with an id already handed out in this same import).
    let id = usableId(entry.id);
    if (id === undefined || takenIds.has(id)) {
      do {
        id = newId();
      } while (takenIds.has(id));
    }
    takenIds.add(id);
    candidate.id = id;
    candidate.name = uniqueRuleName(rawName, takenNames);
    rules.push(candidate);
  }

  return { rules, skipped };
}
