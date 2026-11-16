/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

/** Display preferences for the top-of-chat summarization indicator. */
export interface SummarizationIndicatorSettings {
  /** Master switch — show the indicator while a summary generation runs. */
  show: boolean;
  /** Pill text; empty means no label. */
  label: string;
  /** Render the pulsing dot. */
  dot: boolean;
}

export const DEFAULT_SUMMARIZATION_INDICATOR: SummarizationIndicatorSettings = {
  show: true,
  label: "Summarizing…",
  dot: true,
};

/** Longest stored label (keeps a stray paste from breaking the header row). */
export const MAX_SUMMARIZATION_INDICATOR_LABEL = 40;

export const summarizationIndicatorAtom = atom<SummarizationIndicatorSettings>(
  DEFAULT_SUMMARIZATION_INDICATOR,
);

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
export function clampSummarizationIndicatorLabel(value: string): string {
  return value.slice(0, MAX_SUMMARIZATION_INDICATOR_LABEL);
}

/** Merge an unknown stored value onto the defaults, tolerating null/bad shapes. */
export function storedSummarizationIndicator(value: unknown): SummarizationIndicatorSettings {
  // Always a fresh object: callers may mutate the result without corrupting defaults.
  const next: SummarizationIndicatorSettings = { ...DEFAULT_SUMMARIZATION_INDICATOR };
  if (typeof value === "object" && value !== null) {
    const stored = value as Record<string, unknown>;
    if (typeof stored.show === "boolean") {
      next.show = stored.show;
    }
    if (typeof stored.label === "string") {
      next.label = clampSummarizationIndicatorLabel(stored.label);
    }
    if (typeof stored.dot === "boolean") {
      next.dot = stored.dot;
    }
  }
  return next;
}

/** Immutable field merge; the atom always holds a fresh object. */
function updateSummarizationIndicator(patch: Partial<SummarizationIndicatorSettings>): void {
  appStore.set(summarizationIndicatorAtom, {
    ...appStore.get(summarizationIndicatorAtom),
    ...patch,
  });
}

/** Persist the whole summarization_indicator object; failures are ignored. */
function persistSummarizationIndicator(): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      summarization_indicator: { ...appStore.get(summarizationIndicatorAtom) },
    }),
  }).catch(() => {});
}

/**
 * Runs the one-time hydration of the stored display preferences from
 * GET /api/settings without blocking render. Split out of
 * useSummarizationIndicator() so non-React callers (app boot in index.tsx)
 * can trigger it without a hook — the pill only calls the hook while a
 * summary generation runs, so relying on it would defer the stored settings.
 * The `initialized` guard makes repeat calls cheap. If the user interacts
 * before hydration finishes, the stored value is skipped so it cannot clobber
 * their edits.
 */
export function hydrateSummarizationIndicator(): void {
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
        summarizationIndicatorAtom,
        storedSummarizationIndicator(readSetting(settings, "summarization_indicator")),
      );
    })
    .catch(() => {});
}

/**
 * Summarization indicator store. Hydration runs through
 * {@link hydrateSummarizationIndicator} (also called at app boot); mutations
 * persist the whole summarization_indicator object (fire-and-forget). If the
 * user interacts before hydration finishes, the stored value is skipped so it
 * cannot clobber their edits.
 */
export function useSummarizationIndicator(): {
  summarizationIndicator: SummarizationIndicatorSettings;
  setShow(value: boolean): void;
  setLabel(value: string): void;
  setDot(value: boolean): void;
} {
  const summarizationIndicator = useAtomValue(summarizationIndicatorAtom);

  hydrateSummarizationIndicator();

  return {
    summarizationIndicator,
    setShow(value: boolean) {
      touched = true;
      updateSummarizationIndicator({ show: value });
      persistSummarizationIndicator();
    },
    setLabel(value: string) {
      touched = true;
      updateSummarizationIndicator({ label: clampSummarizationIndicatorLabel(value) });
      persistSummarizationIndicator();
    },
    setDot(value: boolean) {
      touched = true;
      updateSummarizationIndicator({ dot: value });
      persistSummarizationIndicator();
    },
  };
}
