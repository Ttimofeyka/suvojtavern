/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema form builder mapping (Settings → Tracker's preset editor).
 *
 * The form edits a STRICT subset of JSON schema — anything outside it
 * ($defs, enum, integer type, deep nesting, array-of-scalars other than
 * strings, extra keywords like format/min/max, …) makes `schemaToForm`
 * return null, and the UI falls back to a read-only form plus the
 * "advanced features — switch to Raw JSON" notice. The subset is exactly
 * what `formToSchema` can rebuild, so `formToSchema(schemaToForm(schema))`
 * reproduces the schema exactly (property order, `required` order, and
 * descriptions; the one canonicalization: an empty-string `description`
 * is treated as absent — the form's text input cannot tell them apart).
 *
 * Supported subset:
 * - Root: { title?, description?, type: "object", properties, required? }.
 * - A property: { type: "string" | "number" | "boolean" | "object" |
 *     "array", description?, … } with:
 *   - object → properties of leaf-typed sub-fields (+ required?),
 *   - array → items { type: "string" } (string list) or items
 *     { type: "object", properties, required? } (list of objects, whose
 *     sub-fields are leaf-typed).
 * - One nesting level only: sub-fields are string/number/boolean.
 * - required lists are duplicate-free and name every existing property.
 */

/** Sub-field (one nesting level only): a scalar property of a group. */
export interface FormSubField {
  /**
   * Stable per-row UI identity (assigned by `ensureRowIds` in schema-rows.ts).
   * Never part of the schema — `formToSchema` reads only the fields above — it
   * exists so React keys, Motion `Reorder` values and `AnimatePresence` can
   * track a row across edits/removals (names are blank/duplicate while typing,
   * so they cannot key a row). Optional so the pure form model stays
   * constructible without it (the test fixtures and `schemaToForm`).
   */
  id?: string;
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

/**
 * A top-level property. `type` "object" edits `children` as its
 * sub-fields; "array" edits them as the fields of each item object;
 * "string-array" is a plain list of strings (no sub-fields). For group
 * types, `requiredOrder` remembers the sub-field names' order in the
 * schema's `required` array so the round-trip can reproduce it exactly.
 */
export interface FormField {
  /** Stable per-row UI identity; see FormSubField.id. */
  id?: string;
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "string-array";
  description: string;
  required: boolean;
  children: FormSubField[];
  requiredOrder: string[];
}

/** The form model for one schema preset (root metadata + field rows). */
export interface SchemaForm {
  title: string;
  description: string;
  fields: FormField[];
  /** Required field names in the schema's original `required` order. */
  requiredOrder: string[];
}

const LEAF_TYPES = new Set(["string", "number", "boolean"]);

/** True for plain JSON objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the object has no keys outside `allowed`. */
function onlyKeys(record: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/**
 * Parses a `required` array: must be duplicate-free strings that all name
 * existing properties. Absent → []; anything else → null (beyond subset).
 */
function parseRequired(value: unknown, names: Set<string>): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !names.has(item) || out.includes(item)) {
      return null;
    }
    out.push(item);
  }
  return out;
}

/** Parses a leaf property entry ({ type, description? }) or null. */
function parseLeaf(record: Record<string, unknown>): { type: string; description: string } | null {
  if (!onlyKeys(record, ["type", "description"])) {
    return null;
  }
  const type = record.type;
  if (typeof type !== "string" || !LEAF_TYPES.has(type)) {
    return null;
  }
  const description = record.description;
  if (description !== undefined && typeof description !== "string") {
    return null;
  }
  return { type, description: typeof description === "string" ? description : "" };
}

/**
 * Parses the leaf-only sub-field entries of a group (object properties or
 * array-of-object item properties). Order follows insertion (JSON) order.
 */
function parseSubFields(
  properties: Record<string, unknown>,
): Array<{ name: string; entry: { type: string; description: string } }> | null {
  const out: Array<{ name: string; entry: { type: string; description: string } }> = [];
  for (const [name, value] of Object.entries(properties)) {
    if (!isRecord(value)) {
      return null;
    }
    const leaf = parseLeaf(value);
    if (leaf === null) {
      return null;
    }
    out.push({ name, entry: leaf });
  }
  return out;
}

/** Parses sub-field rows (name/type/description/required) for a group. */
function parseChildren(
  properties: Record<string, unknown>,
  required: string[],
): FormSubField[] | null {
  const parsed = parseSubFields(properties);
  if (parsed === null) {
    return null;
  }
  return parsed.map(({ name, entry }) => ({
    name,
    type: entry.type as FormSubField["type"],
    description: entry.description,
    required: required.includes(name),
  }));
}

/** Parses an object-typed property (one nesting level, leaf children). */
function parseObjectEntry(
  record: Record<string, unknown>,
): { children: FormSubField[]; requiredOrder: string[] } | null {
  if (!onlyKeys(record, ["type", "description", "properties", "required"])) {
    return null;
  }
  const properties = record.properties;
  if (!isRecord(properties)) {
    return null;
  }
  const required = parseRequired(record.required, new Set(Object.keys(properties)));
  if (required === null) {
    return null;
  }
  const children = parseChildren(properties, required);
  if (children === null) {
    return null;
  }
  return { children, requiredOrder: required };
}

/** Parses an array-typed property (string list or list of objects). */
function parseArrayEntry(
  record: Record<string, unknown>,
):
  | { item: "string-array" }
  | { item: "array"; children: FormSubField[]; requiredOrder: string[] }
  | null {
  if (!onlyKeys(record, ["type", "description", "items"])) {
    return null;
  }
  const items = record.items;
  if (!isRecord(items)) {
    return null;
  }
  if (onlyKeys(items, ["type"]) && items.type === "string") {
    return { item: "string-array" };
  }
  // List of objects: the item's own description has no form surface, so
  // only type/properties/required are accepted on it.
  if (onlyKeys(items, ["type", "properties", "required"]) && items.type === "object") {
    const properties = items.properties;
    if (!isRecord(properties)) {
      return null;
    }
    const required = parseRequired(items.required, new Set(Object.keys(properties)));
    if (required === null) {
      return null;
    }
    const children = parseChildren(properties, required);
    if (children === null) {
      return null;
    }
    return { item: "array", children, requiredOrder: required };
  }
  return null;
}

/**
 * Maps a JSON schema onto the form model, or returns null when it uses
 * anything outside the supported subset (the UI then shows the
 * "advanced features" notice and stays read-only).
 */
export function schemaToForm(schema: Record<string, unknown>): SchemaForm | null {
  if (!onlyKeys(schema, ["title", "description", "type", "properties", "required"])) {
    return null;
  }
  const title = schema.title;
  const description = schema.description;
  if (
    (title !== undefined && typeof title !== "string") ||
    (description !== undefined && typeof description !== "string")
  ) {
    return null;
  }
  if (schema.type !== "object") {
    return null;
  }
  const properties = schema.properties;
  if (!isRecord(properties)) {
    return null;
  }
  const required = parseRequired(schema.required, new Set(Object.keys(properties)));
  if (required === null) {
    return null;
  }

  const fields: FormField[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (!isRecord(value) || typeof value.type !== "string") {
      return null;
    }
    if (value.description !== undefined && typeof value.description !== "string") {
      return null;
    }
    const fieldDescription = typeof value.description === "string" ? value.description : "";
    const fieldRequired = required.includes(name);
    if (LEAF_TYPES.has(value.type)) {
      const leaf = parseLeaf(value);
      if (leaf === null) {
        return null;
      }
      fields.push({
        name,
        type: leaf.type as FormField["type"],
        description: leaf.description,
        required: fieldRequired,
        children: [],
        requiredOrder: [],
      });
      continue;
    }
    if (value.type === "object") {
      const parsed = parseObjectEntry(value);
      if (parsed === null) {
        return null;
      }
      fields.push({
        name,
        type: "object",
        description: fieldDescription,
        required: fieldRequired,
        children: parsed.children,
        requiredOrder: parsed.requiredOrder,
      });
      continue;
    }
    if (value.type === "array") {
      const parsed = parseArrayEntry(value);
      if (parsed === null) {
        return null;
      }
      fields.push(
        parsed.item === "string-array"
          ? {
              name,
              type: "string-array",
              description: fieldDescription,
              required: fieldRequired,
              children: [],
              requiredOrder: [],
            }
          : {
              name,
              type: "array",
              description: fieldDescription,
              required: fieldRequired,
              children: parsed.children,
              requiredOrder: parsed.requiredOrder,
            },
      );
      continue;
    }
    return null;
  }
  return {
    title: typeof title === "string" ? title : "",
    description: typeof description === "string" ? description : "",
    fields,
    requiredOrder: required,
  };
}

/** The JSON-schema `type` a form field type maps onto. */
function schemaTypeOf(type: FormField["type"]): string {
  return type === "array" || type === "string-array" ? "array" : type;
}

/**
 * Rebuilds a `required` array preserving the schema's original order:
 * remembered names that are still required come first (in their original
 * order), then any newly-required names in field order. Stale entries
 * (renamed/removed/toggled-off fields) drop out.
 */
function requiredInOrder(
  order: string[],
  names: string[],
  isRequired: (name: string) => boolean,
): string[] {
  const nameSet = new Set(names);
  const out = order.filter((name) => nameSet.has(name) && isRequired(name));
  for (const name of names) {
    if (isRequired(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

/** Builds the property node for one form field. */
function fieldToProperty(field: FormField): Record<string, unknown> {
  const property: Record<string, unknown> = { type: schemaTypeOf(field.type) };
  if (field.description !== "") {
    property.description = field.description;
  }
  const childrenProperties: Record<string, unknown> = {};
  const childNames: string[] = [];
  for (const child of field.children) {
    if (child.name === "") {
      continue;
    }
    const node: Record<string, unknown> = { type: child.type };
    if (child.description !== "") {
      node.description = child.description;
    }
    childrenProperties[child.name] = node;
    childNames.push(child.name);
  }
  switch (field.type) {
    case "object": {
      property.properties = childrenProperties;
      const childrenRequired = requiredInOrder(
        field.requiredOrder,
        childNames,
        (name) => field.children.find((child) => child.name === name)?.required === true,
      );
      if (childrenRequired.length > 0) {
        property.required = childrenRequired;
      }
      break;
    }
    case "array": {
      const items: Record<string, unknown> = { type: "object", properties: childrenProperties };
      const childrenRequired = requiredInOrder(
        field.requiredOrder,
        childNames,
        (name) => field.children.find((child) => child.name === name)?.required === true,
      );
      if (childrenRequired.length > 0) {
        items.required = childrenRequired;
      }
      property.items = items;
      break;
    }
    case "string-array":
      property.items = { type: "string" };
      break;
  }
  return property;
}

/**
 * Rebuilds the JSON schema from the form model. Rows with an empty name
 * are skipped (formIssues flags them); a duplicate name keeps the last
 * occurrence (also flagged — saving is blocked before this matters).
 */
export function formToSchema(form: SchemaForm): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const names: string[] = [];
  for (const field of form.fields) {
    if (field.name === "") {
      continue;
    }
    properties[field.name] = fieldToProperty(field);
    names.push(field.name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (form.title !== "") {
    schema.title = form.title;
  }
  if (form.description !== "") {
    schema.description = form.description;
  }
  const required = requiredInOrder(
    form.requiredOrder,
    names,
    (name) => form.fields.find((field) => field.name === name)?.required === true,
  );
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

/** Human-readable issues that block saving (empty/duplicate names). */
export function formIssues(form: SchemaForm): string[] {
  const issues: string[] = [];
  const checkGroup = (names: string[], what: string): void => {
    if (names.includes("")) {
      issues.push(`${what}: every field needs a name.`);
    }
    const seen = new Set<string>();
    for (const name of names) {
      if (name === "") {
        continue;
      }
      if (seen.has(name)) {
        issues.push(`${what}: duplicate field name "${name}".`);
      }
      seen.add(name);
    }
  };
  checkGroup(
    form.fields.map((field) => field.name),
    "Schema fields",
  );
  for (const field of form.fields) {
    if (field.type === "object" || field.type === "array") {
      checkGroup(
        field.children.map((child) => child.name),
        `"${field.name === "" ? "unnamed field" : field.name}" sub-fields`,
      );
    }
  }
  return issues;
}

// --- Immutable edit operations (edits patch the form directly and commit
// --- through formToSchema — the sync effect never reseeds on them). ---

/**
 * Structural schema equality for the reseed guard: object key order is
 * irrelevant (JSON object order carries no meaning), array order is
 * significant (`required` ordering). Used only to decide whether a form
 * is already in sync with a schema that changed identity (own commits,
 * saves that normalize the config, cosmetic raw-mode edits).
 */
export function schemasEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => schemasEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && schemasEqual(a[key], b[key]))
    );
  }
  return false;
}

const EMPTY_SUB_FIELD: FormSubField = {
  name: "",
  type: "string",
  description: "",
  required: false,
};

/** Appends a fresh (blank) top-level field row. */
export function addField(form: SchemaForm): SchemaForm {
  const field: FormField = {
    name: "",
    type: "string",
    description: "",
    required: false,
    children: [],
    requiredOrder: [],
  };
  return { ...form, fields: [...form.fields, field] };
}

/** Patches a top-level field (name/type/description/required). */
export function updateField(
  form: SchemaForm,
  index: number,
  patch: Partial<Omit<FormField, "children">>,
): SchemaForm {
  const fields = form.fields.map((field, at) => (at === index ? { ...field, ...patch } : field));
  return { ...form, fields };
}

/** Removes a top-level field row. */
export function removeField(form: SchemaForm, index: number): SchemaForm {
  return { ...form, fields: form.fields.filter((_, at) => at !== index) };
}

/** Appends a fresh (blank) sub-field row to a group field. */
export function addChild(form: SchemaForm, fieldIndex: number): SchemaForm {
  return {
    ...form,
    fields: form.fields.map((field, at) =>
      at === fieldIndex
        ? { ...field, children: [...field.children, { ...EMPTY_SUB_FIELD }] }
        : field,
    ),
  };
}

/** Patches a sub-field row of a group field. */
export function updateChild(
  form: SchemaForm,
  fieldIndex: number,
  childIndex: number,
  patch: Partial<FormSubField>,
): SchemaForm {
  return {
    ...form,
    fields: form.fields.map((field, at) =>
      at === fieldIndex
        ? {
            ...field,
            children: field.children.map((child, childAt) =>
              childAt === childIndex ? { ...child, ...patch } : child,
            ),
          }
        : field,
    ),
  };
}

/** Removes a sub-field row from a group field. */
export function removeChild(form: SchemaForm, fieldIndex: number, childIndex: number): SchemaForm {
  return {
    ...form,
    fields: form.fields.map((field, at) =>
      at === fieldIndex
        ? { ...field, children: field.children.filter((_, childAt) => childIndex !== childAt) }
        : field,
    ),
  };
}

// --- Moves (reordering rows — drag & drop and the up/down buttons) ---

/**
 * `items[from]` re-inserted at index `to` — the moved row's final index —
 * or null when either index is out of bounds or the move is a no-op.
 */
function arrayMove<T>(items: readonly T[], from: number, to: number): T[] | null {
  const moved = items[from];
  if (
    moved === undefined ||
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return null;
  }
  const rest = items.filter((_, at) => at !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}

/**
 * Rebuilds a `requiredOrder` list after an explicit user move: remembered
 * entries that still name a row plus newly-required rows, all in the new
 * visual order. The rebuilt schema's `required` then follows the field
 * order instead of the pre-move order (blank/duplicate names stay out —
 * blank rows never enter the schema, duplicates are flagged elsewhere).
 */
function requiredInVisualOrder<T extends { name: string; required: boolean }>(
  rows: readonly T[],
  remembered: readonly string[],
): string[] {
  const kept = new Set(remembered);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const { name } = row;
    if (name === "" || seen.has(name)) {
      continue;
    }
    if (row.required || kept.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Moves a top-level field row from index `from` to `to` (no-op when out
 * of bounds). The row keeps its required flag; the rebuilt schema lists
 * properties in the new order, with `required` matching it.
 */
export function moveField(form: SchemaForm, from: number, to: number): SchemaForm {
  const fields = arrayMove(form.fields, from, to);
  if (fields === null) {
    return form;
  }
  return { ...form, fields, requiredOrder: requiredInVisualOrder(fields, form.requiredOrder) };
}

/**
 * Moves a sub-field row of the group at `fieldIndex` from `from` to `to`
 * (no-op when out of bounds). Same required/order guarantees as moveField,
 * scoped to that group's children and its own `requiredOrder`.
 */
export function moveSubField(
  form: SchemaForm,
  fieldIndex: number,
  from: number,
  to: number,
): SchemaForm {
  const field = form.fields[fieldIndex];
  if (field === undefined) {
    return form;
  }
  const children = arrayMove(field.children, from, to);
  if (children === null) {
    return form;
  }
  return {
    ...form,
    fields: form.fields.map((candidate, at) =>
      at === fieldIndex
        ? {
            ...candidate,
            children,
            requiredOrder: requiredInVisualOrder(children, field.requiredOrder),
          }
        : candidate,
    ),
  };
}
