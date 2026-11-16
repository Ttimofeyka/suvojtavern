/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CharacterSort } from "../../lib/api-characters";
import { cx } from "../../lib/cx";

interface SortSelectProps {
  value: CharacterSort;
  onChange: (sort: CharacterSort) => void;
  /** Extra class for the row's layout (e.g. a flex basis); the base `.field`
   *  keeps the label/select stacking identical everywhere. */
  className?: string;
}

/**
 * The ordering picker shared by the New Chat modal and the Characters grid, so
 * the two surfaces can never drift on which orders exist. Only the two
 * user-facing orders are offered: the server's `name` order is the implicit
 * default and is never a selectable choice (see character-sort-preference.ts).
 */
export default function CharacterSortSelect(props: SortSelectProps) {
  return (
    <label className={cx("field", props.className)}>
      <span className="field-label">Order</span>
      <select
        className="select"
        aria-label="Order characters"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value as CharacterSort)}
      >
        <option value="created">Recently added</option>
        <option value="recent">Recently chatted</option>
      </select>
    </label>
  );
}
