/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Shared Settings stepper — one numeric control for every panel.
 *
 * Memory, Tracker, the Chat history window and the schema editor's
 * "Generation requests" used to each hand-roll the same −/+ control (and the
 * memory/tracker copies were themselves near-identical row+stepper pairs).
 * Centralising it keeps the markup, the "empty text mid-edit keeps the last
 * good value" guard, and the compact `.set-stepper` sizing identical
 * everywhere. The `.stepper`/`.stepper-btn` visuals live in views.css.
 */

/** Clamp a typed/clicked value into [min, max], truncating to an integer. */
function clampInt(value: number, min: number, max: number | undefined): number {
  const truncated = Math.max(min, Math.trunc(value));
  return max === undefined ? truncated : Math.min(max, truncated);
}

export interface NumberStepperProps {
  value: number;
  min: number;
  /** Upper bound; omitted means unbounded (the −/+ disable checks skip it). */
  max?: number;
  /** Accessible name; also drives the "Decrease/Increase <label>" buttons. */
  label: string;
  onChange: (value: number) => void;
  /** Sizing variant (e.g. `.set-stepper`); the control carries `.stepper` too. */
  className?: string;
}

/**
 * A −/+ stepper bound to an integer. Presentational: the caller owns the value
 * and its persistence, so the same control serves a store-backed setting and a
 * local config draft alike.
 */
export function NumberStepper({ value, min, max, label, onChange, className }: NumberStepperProps) {
  const commit = (next: number): void => onChange(clampInt(next, min, max));

  return (
    <div className={className === undefined ? "stepper" : `stepper ${className}`}>
      <button
        type="button"
        className="btn btn-icon stepper-btn"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => commit(value - 1)}
      >
        <span aria-hidden="true">−</span>
      </button>
      <input
        // The number is data: tabular figures stop the field jittering as the
        // value steps.
        className="input tnum"
        type="number"
        min={min}
        max={max}
        step={1}
        aria-label={label}
        value={value}
        onChange={(event) => {
          // Empty text mid-edit: keep the last good value; a controlled input
          // restores it on the next paint (and onBlur re-syncs the string).
          const text = event.currentTarget.value;
          if (text === "") {
            return;
          }
          const parsed = Number(text);
          if (Number.isFinite(parsed)) {
            commit(parsed);
          }
        }}
        onBlur={(event) => {
          event.currentTarget.value = String(value);
        }}
      />
      <button
        type="button"
        className="btn btn-icon stepper-btn"
        aria-label={`Increase ${label}`}
        disabled={max !== undefined && value >= max}
        onClick={() => commit(value + 1)}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}

export interface StepperRowProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
}

/** One `.set-row` pairing a label/hint column with a compact stepper. */
export function StepperRow({ label, hint, value, min, max, onChange }: StepperRowProps) {
  return (
    <div className="set-row">
      <span className="set-row-main">
        <span className="set-row-label">{label}</span>
        <span className="set-row-hint">{hint}</span>
      </span>
      <NumberStepper
        className="set-stepper"
        label={label}
        value={value}
        min={min}
        max={max}
        onChange={onChange}
      />
    </div>
  );
}
