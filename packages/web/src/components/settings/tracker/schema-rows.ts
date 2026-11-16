/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Row-identity plumbing for the visual schema editor.
 *
 * The form model in schema-form.ts is position-owned: rows are typed by the
 * user, so a row's name is routinely blank or duplicated mid-edit and cannot
 * key a React list. Motion's `Reorder` needs a value that survives reorders
 * (it matches items by `value` identity), and `AnimatePresence` needs a key
 * that survives edits to animate the *right* row out — so every row carries a
 * generated `id`. `formToSchema`/`schemasEqual` ignore it entirely; it lives
 * only in the form layer.
 *
 * Ids are assigned lazily by `ensureRowIds` (called on every form mutation) and
 * preserved by the immutable edit ops, whose spreads keep existing fields
 * untouched.
 */

import type { FormField, FormSubField, SchemaForm } from "./schema-form";

/** Monotonic per-session counter; ids only need to be unique, not stable
 *  across reloads (the form is rebuilt from the schema on mount). */
let rowSequence = 0;

/** The column that owns reorderable rows: a field's children or the roots. */
export type RowList = readonly FormField[] | readonly FormSubField[];

/** A fresh row id. Prefixed so it can never be confused with a field name. */
export function nextRowId(): string {
  rowSequence += 1;
  return `row-${rowSequence}`;
}

/**
 * Returns `form` with an id stamped on every row that lacks one. Rows that
 * already carry an id are returned by reference, so Motion's reorder values
 * stay stable across ordinary edits (only a genuinely new row gets a new id).
 */
export function ensureRowIds(form: SchemaForm): SchemaForm {
  let changed = false;
  const fields = form.fields.map((field) => {
    let childrenChanged = false;
    const children = field.children.map((child) => {
      if (child.id !== undefined) {
        return child;
      }
      childrenChanged = true;
      return { ...child, id: nextRowId() };
    });
    if (field.id !== undefined && !childrenChanged) {
      return field;
    }
    changed = true;
    return {
      ...field,
      id: field.id ?? nextRowId(),
      children: childrenChanged ? children : field.children,
    };
  });
  return changed ? { ...form, fields } : form;
}

/** Ids for a list of rows, in order — the `items` a ReorderableList consumes. */
export function rowIds(rows: readonly { id?: string }[]): string[] {
  return rows.map((row) => row.id ?? "");
}

/** Applies `from`→`to` to a copy of `items`, mirroring schema-form's arrayMove. */
function moved(items: readonly string[], from: number, to: number): string[] {
  const next = items.slice();
  const [item] = next.splice(from, 1);
  if (item === undefined) {
    return items.slice();
  }
  next.splice(to, 0, item);
  return next;
}

/**
 * Translates a full reordered permutation (what Motion's `Reorder.Group`
 * emits) back into the single `from`→`to` move the form ops speak in. Motion
 * only ever moves one row per gesture, so a match is always found; `null`
 * means "no change" and the caller skips the commit.
 */
export function singleMove(
  before: readonly string[],
  after: readonly string[],
): { from: number; to: number } | null {
  if (before.length !== after.length) {
    return null;
  }
  for (let from = 0; from < before.length; from += 1) {
    for (let to = 0; to < before.length; to += 1) {
      if (from === to) {
        continue;
      }
      const candidate = moved(before, from, to);
      if (candidate.every((value, index) => value === after[index])) {
        return { from, to };
      }
    }
  }
  return null;
}
