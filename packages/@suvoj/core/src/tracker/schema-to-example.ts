/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON Schema → sample data (used to build the tracker generation prompt:
 * the "example of a perfect response" the model imitates). The web client
 * re-implements its own copy for live previews — keep them in sync.
 *
 * Precedence per node: `example` → `const` → first `enum` value → by
 * `type`. Objects recurse over `properties` in declaration order; a
 * missing `type` with `properties` is treated as an object, otherwise
 * null.
 */

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exampleOf(node: unknown): unknown {
  if (!isSchemaRecord(node)) {
    return null;
  }
  if ("example" in node) {
    return node.example;
  }
  if ("const" in node) {
    return node.const;
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum[0] ?? null;
  }
  const type = node.type;
  if (type === "object" || (type === undefined && isSchemaRecord(node.properties))) {
    const properties = isSchemaRecord(node.properties) ? node.properties : {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(properties)) {
      out[key] = exampleOf(properties[key]);
    }
    return out;
  }
  if (type === "array") {
    const items = node.items;
    return items !== undefined ? [exampleOf(items)] : [];
  }
  if (type === "string") {
    return typeof node.description === "string" ? node.description : "string";
  }
  if (type === "number" || type === "integer") {
    return 0;
  }
  if (type === "boolean") {
    return false;
  }
  return null;
}

/** Walks a JSON Schema and produces matching sample data. */
export function schemaToExample(schema: Record<string, unknown>): unknown {
  return exampleOf(schema);
}
