/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

/** Display preferences for the top-of-chat tracker generation indicator. */
export interface TrackerIndicatorSettings {
  /** Master switch — show the indicator while a tracker generation runs. */
  show: boolean;
  /** Pill text; empty means no label. */
  label: string;
  /** Render the pulsing dot. */
  dot: boolean;
}

export const DEFAULT_TRACKER_INDICATOR: TrackerIndicatorSettings = {
  show: true,
  label: "Tracking…",
  dot: true,
};

/** Longest stored label (keeps a stray paste from breaking the header row). */
export const MAX_TRACKER_INDICATOR_LABEL = 40;

export const trackerIndicatorAtom = atom<TrackerIndicatorSettings>(DEFAULT_TRACKER_INDICATOR);

let initialized = false;
let touched = false;

function readSetting(settings: unknown, key: string): unknown {
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  return (settings as Record<string, unknown>)[key] ?? null;
}

/** Clamp a label to the supported length (no trimming — a trailing space
 *  while typing must survive). */
export function clampTrackerIndicatorLabel(value: string): string {
  return value.slice(0, MAX_TRACKER_INDICATOR_LABEL);
}

/** Merge an unknown stored value onto the defaults, tolerating null/bad shapes. */
export function storedTrackerIndicator(value: unknown): TrackerIndicatorSettings {
  // Always a fresh object: callers may mutate the result without corrupting defaults.
  const next: TrackerIndicatorSettings = { ...DEFAULT_TRACKER_INDICATOR };
  if (typeof value === "object" && value !== null) {
    const stored = value as Record<string, unknown>;
    if (typeof stored.show === "boolean") {
      next.show = stored.show;
    }
    if (typeof stored.label === "string") {
      next.label = clampTrackerIndicatorLabel(stored.label);
    }
    if (typeof stored.dot === "boolean") {
      next.dot = stored.dot;
    }
  }
  return next;
}

/** Immutable field merge; the atom always holds a fresh object. */
function updateTrackerIndicator(patch: Partial<TrackerIndicatorSettings>): void {
  appStore.set(trackerIndicatorAtom, { ...appStore.get(trackerIndicatorAtom), ...patch });
}

/** Persist the whole tracker_indicator object; failures are ignored. */
function persistTrackerIndicator(): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tracker_indicator: { ...appStore.get(trackerIndicatorAtom) } }),
  }).catch(() => {});
}

/**
 * Runs the one-time hydration of the stored display preferences from
 * GET /api/settings without blocking render. Split out of
 * useTrackerIndicator() so non-React callers (app boot in index.tsx) can
 * trigger it without a hook — the pill only calls the hook while a tracker
 * generation runs, so relying on it would defer the stored settings. The
 * `initialized` guard makes repeat calls cheap. If the user interacts before
 * hydration finishes, the stored value is skipped so it cannot clobber their
 * edits.
 */
export function hydrateTrackerIndicator(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  fetch("/api/settings")
    .then((response) => (response.ok ? response.json() : null))
    .then((settings: unknown) => {
      if (touched) {
        return;
      }
      appStore.set(
        trackerIndicatorAtom,
        storedTrackerIndicator(readSetting(settings, "tracker_indicator")),
      );
    })
    .catch(() => {});
}

/**
 * Tracker indicator store. Hydration runs through
 * {@link hydrateTrackerIndicator} (also called at app boot); mutations persist
 * the whole tracker_indicator object (fire-and-forget). If the user interacts
 * before hydration finishes, the stored value is skipped so it cannot clobber
 * their edits.
 */
export function useTrackerIndicator(): {
  trackerIndicator: TrackerIndicatorSettings;
  setShow(value: boolean): void;
  setLabel(value: string): void;
  setDot(value: boolean): void;
} {
  const trackerIndicator = useAtomValue(trackerIndicatorAtom);

  hydrateTrackerIndicator();

  return {
    trackerIndicator,
    setShow(value: boolean) {
      touched = true;
      updateTrackerIndicator({ show: value });
      persistTrackerIndicator();
    },
    setLabel(value: string) {
      touched = true;
      updateTrackerIndicator({ label: clampTrackerIndicatorLabel(value) });
      persistTrackerIndicator();
    },
    setDot(value: boolean) {
      touched = true;
      updateTrackerIndicator({ dot: value });
      persistTrackerIndicator();
    },
  };
}
