/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Multi-request tracker generation: splitting one schema preset across N
 * parallel AI requests, one per group of top-level fields.
 *
 * A schema is divided by TOP-LEVEL property only — each request receives a
 * subset schema whose `properties`/`required` cover just its own fields, so
 * the model's attention (and per-request output size) stay focused. The
 * mechanism asks the server to run the parts in parallel, then shallow-merges
 * the responses back into one tracker object.
 *
 * A preset with no (or a single) request stays on the exact single-request
 * path: `buildTrackerParts` returns the ORIGINAL schema by reference, so the
 * generated prompt is byte-identical to a non-split generation.
 */

/** Hard cap on parallel tracker requests (cost/latency guard). */
export const MAX_TRACKER_PARTS = 8;

/** Stored, user-configured split of one schema preset (raw shape). */
export interface TrackerPartsConfig {
  /** Number of parallel generation requests (>= 1). */
  count: number;
  /** Top-level schema property name -> 1-based request index. Missing = 1. */
  fields: Record<string, number>;
}

/** One resolved request of a (possibly split) tracker generation. */
export interface TrackerSchemaPart {
  /** 1-based request index (re-numbered after empty parts are dropped). */
  index: number;
  /** Top-level property names this request generates. */
  fields: string[];
  /** The JSON schema this request must follow. */
  schema: Record<string, unknown>;
}

/** True for plain JSON objects (arrays are NOT schema property maps). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A 1-based integer from a possibly-malformed stored value. Non-numbers,
 * non-integers and out-of-range lows fall back to 1 (parts are 1-based), so
 * corrupt config can never produce a part index below the first request.
 */
function toPositiveInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * The top-level property names of a splittable object schema, in declaration
 * order — or null when the schema cannot be split (wrong/`array` type, no
 * plain `properties` map). Callers distinguish "unsplittable" (keep the
 * schema intact) from "no fields".
 */
function splittableFieldNames(schema: Record<string, unknown>): string[] | null {
  const typeOk = schema.type === undefined || schema.type === "object";
  if (!typeOk || !isPlainObject(schema.properties)) {
    return null;
  }
  return Object.keys(schema.properties);
}

/** A one-request plan over the whole schema; reuses the ORIGINAL reference. */
function wholeSchemaPart(schema: Record<string, unknown>, fields: string[]): TrackerSchemaPart[] {
  return [{ index: 1, fields, schema }];
}

/**
 * The subset schema for one request: only that part's properties (the
 * ORIGINAL node objects, so nested structure is preserved), only the matching
 * `required` entries in their original order, and `title` when present. Other
 * schema-level keys (`$schema`, `additionalProperties`, `definitions`, …) are
 * deliberately NOT carried over — each request gets a self-contained schema.
 */
function subsetSchema(schema: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const originals = schema.properties as Record<string, unknown>;
  const properties: Record<string, unknown> = {};
  for (const name of fields) {
    properties[name] = originals[name];
  }
  const requiredSource = Array.isArray(schema.required) ? schema.required : [];
  const required = requiredSource.filter(
    (entry): entry is string => typeof entry === "string" && fields.includes(entry),
  );
  const subset: Record<string, unknown> = {};
  if (typeof schema.title === "string" && schema.title !== "") {
    subset.title = schema.title;
  }
  subset.type = "object";
  subset.properties = properties;
  subset.required = required;
  return subset;
}

/**
 * Resolves a schema + stored split config into the per-request generation
 * plan. Always returns at least one part; when the resolved plan is a SINGLE
 * request — count <= 1, an unsplittable schema, or a split whose fields all
 * collapse into one group — the one part carries the ORIGINAL schema object
 * BY REFERENCE, so a mechanism reading `part.schema` sees the full schema
 * (description, `$schema`, `additionalProperties`, …) exactly as on the
 * non-split path. Only a genuine multi-group split gets subset schemas.
 */
export function buildTrackerParts(
  schema: Record<string, unknown>,
  config?: TrackerPartsConfig,
): TrackerSchemaPart[] {
  const names = splittableFieldNames(schema);
  if (!names || names.length === 0) {
    // Nothing to split: keep the schema intact so the single-request path is
    // byte-identical to a non-split generation.
    return wholeSchemaPart(schema, []);
  }

  const requested = toPositiveInt(config?.count);
  if (requested <= 1) {
    return wholeSchemaPart(schema, [...names]);
  }

  // Never create more requests than there are fields to distribute, and never
  // exceed the hard parallelism cap (requested is already an integer >= 1).
  const count = Math.min(requested, MAX_TRACKER_PARTS, names.length);
  const assignments = config?.fields ?? {};
  const groups = new Map<number, string[]>();
  for (const name of names) {
    // Out-of-range (or missing) assignments collapse into the nearest legal
    // part; the schema order within each group is preserved.
    const index = Math.min(toPositiveInt(assignments[name]), count);
    const group = groups.get(index);
    if (group) {
      group.push(name);
    } else {
      groups.set(index, [name]);
    }
  }

  // Drop empty groups, then re-number survivors consecutively from 1 so the
  // prompt headers read "PART 1 OF N" with no gaps.
  const nonEmpty = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, groupFields]) => groupFields);

  // A split that collapses into ONE group is really a single request (e.g.
  // every field assigned to request 2). Return the ORIGINAL schema by
  // reference — a subset schema would silently drop schema-level keys and
  // be indistinguishable from a genuine split to a mechanism reading
  // `part.schema`. Multiple groups keep their subset schemas.
  if (nonEmpty.length === 1) {
    return wholeSchemaPart(schema, nonEmpty[0] ?? []);
  }

  return nonEmpty.map((groupFields, position) => ({
    index: position + 1,
    fields: groupFields,
    schema: subsetSchema(schema, groupFields),
  }));
}
