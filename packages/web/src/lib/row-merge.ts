/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural deep equality for two JSON-ish row values. List reconciliation
 * compares by content: a row whose fields are unchanged (though the server
 * sent a fresh object) is reused from the previous array, so React sees the
 * same object identity and a memoized card child skips re-rendering.
 */
export function rowsEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  // Distinct Dates have no own enumerable keys, so the object branch below
  // would call them equal; compare by reference/value instead.
  if (a instanceof Date || b instanceof Date) {
    return Object.is(a, b);
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => rowsEqual(item, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && rowsEqual(left[key], right[key]))
  );
}

/**
 * React twin of Solid's `reconcile(items, { key: "id" })`: builds the next
 * array in `incoming` order, but reuses the previous object instance for any
 * row that is id-matched AND content-equal. Changed rows get the incoming
 * object; unchanged rows keep their identity, so a card (or its controlled
 * input) is never rebuilt and focus survives. The previous array itself is
 * returned untouched when nothing changed, so the atom value stays
 * referentially stable and its subscribers do not re-render at all.
 */
export function mergeRowsById<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const byId = new Map(previous.map((row) => [row.id, row] as const));
  let changed = incoming.length !== previous.length;
  const next = incoming.map((row, index) => {
    const prior = byId.get(row.id);
    if (prior !== undefined && rowsEqual(prior, row)) {
      if (previous[index] !== prior) {
        changed = true;
      }
      return prior;
    }
    changed = true;
    return row;
  });
  return changed ? next : previous;
}
