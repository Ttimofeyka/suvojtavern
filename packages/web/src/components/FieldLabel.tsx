/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * FieldLabel — a form label paired with its inline Info affordance.
 *
 * The lorebook entry editor and the preset editor each carried a byte-identical
 * copy of this markup (plus a span variant for controls that are not a single
 * labelled element). Hoisting it here keeps the two editors consistent and, more
 * importantly, keeps the one non-obvious rule in one place:
 *
 * the Info button is a SIBLING of the label, never inside it. A control embedded
 * in a <label> would fold the button's aria-label into the labelled control's
 * accessible name ("Keys … Words or phrases scanned for in recent messages…").
 * As a sibling, the label's accessible name stays exactly the label text, and
 * the button (natively focusable) still reaches the tooltip controller's
 * :focus-visible hook for keyboard users.
 */

import type { ReactElement, ReactNode } from "react";
import { Info } from "./ui/icons";

export interface FieldLabelProps {
  /** The label text. */
  text: string;
  /** Tooltip shown by the Info button; also its accessible name. */
  tip: string;
  /**
   * Id of the control this label names. Omit to render a <span> label — for
   * controls that are not one labelled element (a chip group, a checkbox list),
   * where a for/id pair would have nothing to point at.
   */
  htmlFor?: string;
  /** Optional trailing affordance (e.g. the AI-generate button) after the Info button. */
  action?: ReactNode;
}

/** A field label and its Info tooltip button, on one baseline. */
export function FieldLabel({ text, tip, htmlFor, action }: FieldLabelProps): ReactElement {
  return (
    <div className="field-label-row">
      {htmlFor === undefined ? (
        <span className="field-label">{text}</span>
      ) : (
        <label className="field-label" htmlFor={htmlFor}>
          {text}
        </label>
      )}
      <button type="button" className="info-tip" aria-label={tip} data-tip={tip}>
        <Info size={13} aria-hidden="true" />
      </button>
      {action}
    </div>
  );
}
