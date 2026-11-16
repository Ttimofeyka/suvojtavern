/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON-Schema → sample data (draft-07 style, like the tracker presets).
 *
 * Produces a representative instance of a schema for template previews and
 * dry runs: `example` wins, then `const`, then the first `enum` value;
 * otherwise the `type` decides (objects recurse over `properties` in
 * order, arrays yield one sampled item, strings fall back to their
 * `description`, and unknown shapes sample as null).
 */

/** Depth cap for pathological (self-referencing) schemas. */
const MAX_DEPTH = 12;

/** Samples one (sub)schema. Unknown or malformed shapes sample as null. */
function sample(schema: unknown, depth: number): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return null;
  }
  if (depth > MAX_DEPTH) {
    return null;
  }
  const node = schema as Record<string, unknown>;
  if (node.example !== undefined) {
    return node.example;
  }
  if (node.const !== undefined) {
    return node.const;
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum[0];
  }
  switch (node.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      if (typeof node.properties === "object" && node.properties !== null) {
        for (const [key, sub] of Object.entries(node.properties)) {
          out[key] = sample(sub, depth + 1);
        }
      }
      return out;
    }
    case "array": {
      // Tuple form (`items` is an array): sample its first member.
      if (Array.isArray(node.items)) {
        return node.items.length > 0 ? [sample(node.items[0], depth + 1)] : [];
      }
      return typeof node.items === "object" && node.items !== null
        ? [sample(node.items, depth + 1)]
        : [];
    }
    case "string":
      return typeof node.description === "string" && node.description !== ""
        ? node.description
        : "string";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

/** Builds sample data for a JSON-Schema object (the tracker's schema shape). */
export function schemaSample(schema: Record<string, unknown>): unknown {
  return sample(schema, 0);
}
