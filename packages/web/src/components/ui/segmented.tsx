/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Segmented — an accessible segmented control with a shared-layout indicator.
 *
 * The app's existing controls (styles/views.css `.segmented`) are a hidden
 * radio group with `:checked + label` styling: the selected pill simply swaps
 * its background, which reads as a hard cut. This component keeps the exact
 * same radio semantics and the same global class vocabulary (so it sits in the
 * same visual system) but renders a Motion `layoutId` pill behind the active
 * option, so the selection *slides* between items instead of teleporting.
 *
 * Accessibility is inherited from the platform, not re-implemented: the real
 * <input type="radio"> elements share a generated `name`, which gives arrow-key
 * roving focus, Space/Enter selection, and correct group announcements for
 * free. The indicator is aria-hidden decoration.
 *
 * All layout lives in styles/motion-primitives.css; this file owns behaviour.
 */

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useId } from "react";
import { cx } from "../../lib/cx";
import { INSTANT, useAppMotion } from "../../lib/motion";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group; pass either this or `ariaLabelledBy`. */
  ariaLabel?: string;
  /** Id of a visible label element naming the group. */
  ariaLabelledBy?: string;
  /** Radio group name; generated when omitted (each control is its own group). */
  name?: string;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  name,
  className,
}: SegmentedProps<T>): ReactElement {
  const app = useAppMotion();
  // Stable per-instance ids: the radio `name` groups this control's inputs, and
  // the layoutId must be unique across the page or two segmented controls would
  // try to share one indicator and fly the pill between groups.
  const reactId = useId();
  const groupName = name ?? `segmented-${reactId}`;
  const indicatorId = `segmented-indicator-${reactId}`;

  return (
    <div
      className={cx("segmented", "segmented-motion", className)}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          // The label wraps the real input so a click anywhere selects it.
          <label
            key={option.value}
            className={cx("segmented-item", option.disabled === true && "is-disabled")}
          >
            <input
              type="radio"
              className="segmented-radio"
              name={groupName}
              value={option.value}
              checked={active}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            {active && (
              <motion.span
                layoutId={indicatorId}
                aria-hidden="true"
                className="segmented-indicator"
                // Reduced motion collapses the shared-layout flight to a snap;
                // the indicator still exists, so the selected state never
                // depends on animation to be visible.
                transition={app.reduce ? INSTANT : app.spring.snappy}
              />
            )}
            <span className="segmented-label">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
