/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChangeEvent } from "react";
import type { ImportConflict } from "../../lib/api-transfer";

const OPTIONS: readonly { value: ImportConflict; label: string }[] = [
  { value: "error", label: "Stop and show an error" },
  { value: "rename", label: "Keep both (add a suffix)" },
  { value: "replace", label: "Replace the existing one" },
];

/**
 * Duplicate-name handling for every character card import. It is one shared
 * choice rendered by both card tabs, so switching from a file to a link keeps
 * the answer the user already gave.
 */
export default function ConflictPicker(props: {
  value: ImportConflict;
  disabled: boolean;
  onChange: (value: ImportConflict) => void;
}) {
  return (
    <label className="char-transfer-field">
      <span className="char-transfer-field-label">If the name is taken</span>
      <select
        className="select"
        value={props.value}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
          props.onChange(event.currentTarget.value as ImportConflict)
        }
      >
        {OPTIONS.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="field-hint">Applies to character cards imported from a file or a link.</span>
    </label>
  );
}
