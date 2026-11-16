/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PresetControl, PresetPrompt } from "./api-presets";
import { applyChoices, settingsControls, settingsControlValues } from "./preset-controls";

/**
 * Editor-side governance: what a pipeline row looks like while a UI control
 * owns its `enabled` flag, and what the row's own switch may therefore do.
 *
 * A row named by a control option has no independent on/off state: the server
 * re-normalizes the stored flags on every write and the engine overlays the
 * choice again at generation time, so the stored flag is DERIVED data. The
 * precedence rules themselves (later control wins, the chosen option beats a
 * sibling sharing a row, a missing/garbage choice falls back to the default
 * then the first option) live in `lib/preset-controls.ts`, the mirror of
 * core's `engine/controls.ts`, and are never re-implemented here.
 */

/**
 * The pipeline rows the editor seeds its draft with: `rows` with each
 * control's effective choice overlaid on the `enabled` flags, so a governed
 * row shows the flag generation will use instead of its stale stored value.
 *
 * Rows no control names come back by reference, and a malformed/absent
 * settings blob yields no controls at all — hence a plain copy, which is
 * exactly the ungoverned editor behavior.
 */
export function effectiveRows(rows: readonly PresetPrompt[], settings: unknown): PresetPrompt[] {
  return applyChoices(rows, settingsControls(settings), settingsControlValues(settings));
}

/**
 * One row's switch as the editor must render it. A discriminated union so the
 * `disabled` flag IS the decision and `control` is narrowed with it: a disabled
 * switch always has the control to name in its explanation, and a live one has
 * no control to point at.
 */
export type RowGovernance =
  | { disabled: false; control: undefined }
  | { disabled: true; control: PresetControl };

/**
 * Whether one row's switch is the row's own to flip, and which control took it
 * otherwise. `governed` is `governedPromptIds(controls)` for the SAME draft
 * controls (the editor already memoizes it), so the map and the array can never
 * disagree about who owns a row.
 *
 * The switch is only disabled when a control in the DRAFT can be named. A
 * governed id whose control is not in the array has nothing to point at, and a
 * dead switch with no explanation reads as broken, so that row stays live.
 */
export function governanceOf(
  promptId: string,
  controls: readonly PresetControl[],
  governed: ReadonlyMap<string, string>,
): RowGovernance {
  const controlId = governed.get(promptId);
  const control =
    controlId === undefined ? undefined : controls.find((candidate) => candidate.id === controlId);
  return control === undefined
    ? { disabled: false, control: undefined }
    : { disabled: true, control };
}
