/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Loading / empty / error surfaces shared by the Settings panels.
 *
 * Every panel fetches its own data, so the three states each needs to render
 * were being hand-rolled per file (spinner captions, bare error paragraphs,
 * bespoke empty boxes). Centralising them keeps the states visually identical
 * across panels — the same skeleton rhythm, the same empty composition, the
 * same danger-tinted failure box — while each panel keeps ownership of its
 * own copy and of when a state applies.
 *
 * House rules: no hardcoded colors (the base `.empty-state` / `.error-state`
 * classes already derive everything from theme vars), and the skeleton's
 * shimmer comes from the shared `.skeleton` class.
 */

import type { ReactElement, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Check, TriangleAlert } from "../ui/icons";

export interface SettingsLoadingProps {
  /** Accessible status text, also used as the skeleton's announced label. */
  label: string;
  /** Number of placeholder rows. Defaults to 3. */
  rows?: number;
  className?: string;
}

/**
 * Stable row identities for the skeleton. A fixed list (rather than mapping an
 * array index) keeps the React keys meaningful and bounds the placeholder to
 * six rows — more than any first-load state needs.
 */
const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"] as const;

/**
 * First-load placeholder: hairline cards with shimmering text bars. The rows
 * are `aria-hidden` decoration; a visually-hidden live region announces the
 * label so a screen reader hears "Loading …" instead of nothing.
 */
export function SettingsLoading({
  label,
  rows = 3,
  className,
}: SettingsLoadingProps): ReactElement {
  return (
    <div className={cx("set-loading", className)}>
      {/* Announce the pending state without duplicating it visually. The text
          is clipped, not display:none, so AT still reads it. */}
      <span role="status" className="set-loading-status">
        {label}
      </span>
      {SKELETON_ROWS.slice(0, Math.max(0, rows)).map((id) => (
        <div className="set-skeleton-row" aria-hidden="true" key={id}>
          <span className="skeleton set-skeleton-dot" />
          <span className="set-skeleton-lines">
            <span className="skeleton set-skeleton-line" style={{ width: "42%" }} />
            <span className="skeleton set-skeleton-line" style={{ width: "68%" }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export interface SettingsEmptyProps {
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  /** Optional call to action (e.g. an "Add" button). */
  action?: ReactNode;
  className?: string;
}

/** Empty state: icon disc, title, hint, optional action — inside a hairline card. */
export function SettingsEmpty({
  icon,
  title,
  hint,
  action,
  className,
}: SettingsEmptyProps): ReactElement {
  return (
    <div className={cx("empty-card", className)}>
      <div className="empty-state">
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="empty-state-title">{title}</span>
        {hint !== undefined && <span className="empty-state-hint">{hint}</span>}
        {action}
      </div>
    </div>
  );
}

export interface SettingsErrorProps {
  /** Short headline naming what failed. */
  title: string;
  /** The server's message, when one exists. */
  details?: string | null;
  /** Retry affordance; omitted when the panel has no re-fetch path. */
  onRetry?: () => void;
  className?: string;
}

/** Failure state, visually distinct from empty: danger-tinted box + retry. */
export function SettingsError({
  title,
  details,
  onRetry,
  className,
}: SettingsErrorProps): ReactElement {
  return (
    <div className={cx("error-state", className)} role="alert">
      <span className="empty-state-icon" aria-hidden="true">
        <TriangleAlert size={18} />
      </span>
      <span className="error-state-title">{title}</span>
      {details != null && details !== "" && <span className="error-state-hint">{details}</span>}
      {onRetry !== undefined && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export interface SettingsSavedProps {
  /** The confirmation text ("Saved"), or null when nothing has been saved. */
  note: string | null;
}

/**
 * The one "saved" confirmation every panel shows beside its Save button. A
 * live region (`role="status"`) so a screen reader announces the result, which
 * the per-panel `badge badge-success` spans mostly omitted.
 */
export function SettingsSaved({ note }: SettingsSavedProps): ReactElement | null {
  if (note === null) {
    return null;
  }
  return (
    <span className="badge badge-success" role="status">
      <Check size={12} />
      {note}
    </span>
  );
}
