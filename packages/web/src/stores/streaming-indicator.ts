/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

/** Display preferences for the top-of-chat streaming indicator. */
export interface StreamingIndicatorSettings {
  /** Master switch — show the indicator while a reply streams. */
  show: boolean;
  /** Pill text; empty means no label. */
  label: string;
  /** Render the pulsing dot. */
  dot: boolean;
}

export const DEFAULT_STREAMING_INDICATOR: StreamingIndicatorSettings = {
  show: true,
  label: "Streaming…",
  dot: true,
};

/** Longest stored label (keeps a stray paste from breaking the header row). */
export const MAX_STREAMING_INDICATOR_LABEL = 40;

export const streamingIndicatorAtom = atom<StreamingIndicatorSettings>(DEFAULT_STREAMING_INDICATOR);

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
export function clampStreamingIndicatorLabel(value: string): string {
  return value.slice(0, MAX_STREAMING_INDICATOR_LABEL);
}

/** Merge an unknown stored value onto the defaults, tolerating null/bad shapes. */
export function storedStreamingIndicator(value: unknown): StreamingIndicatorSettings {
  // Always a fresh object: callers may mutate the result without corrupting defaults.
  const next: StreamingIndicatorSettings = { ...DEFAULT_STREAMING_INDICATOR };
  if (typeof value === "object" && value !== null) {
    const stored = value as Record<string, unknown>;
    if (typeof stored.show === "boolean") {
      next.show = stored.show;
    }
    if (typeof stored.label === "string") {
      next.label = clampStreamingIndicatorLabel(stored.label);
    }
    if (typeof stored.dot === "boolean") {
      next.dot = stored.dot;
    }
  }
  return next;
}

/** Immutable field merge; the atom always holds a fresh object. */
function updateStreamingIndicator(patch: Partial<StreamingIndicatorSettings>): void {
  appStore.set(streamingIndicatorAtom, { ...appStore.get(streamingIndicatorAtom), ...patch });
}

/** Persist the whole streaming_indicator object; failures are ignored. */
function persistStreamingIndicator(): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streaming_indicator: { ...appStore.get(streamingIndicatorAtom) } }),
  }).catch(() => {});
}

/**
 * Runs the one-time hydration of the stored display preferences from
 * GET /api/settings without blocking render. Split out of
 * useStreamingIndicator() so non-React callers (app boot in index.tsx) can
 * trigger it without a hook — the pill only calls the hook while a reply
 * streams, so relying on it would defer the stored settings. The
 * `initialized` guard makes repeat calls cheap. If the user interacts before
 * hydration finishes, the stored value is skipped so it cannot clobber their
 * edits.
 */
export function hydrateStreamingIndicator(): void {
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
        streamingIndicatorAtom,
        storedStreamingIndicator(readSetting(settings, "streaming_indicator")),
      );
    })
    .catch(() => {});
}

/**
 * Streaming indicator store. Hydration runs through
 * {@link hydrateStreamingIndicator} (also called at app boot); mutations
 * persist the whole streaming_indicator object (fire-and-forget). If the user
 * interacts before hydration finishes, the stored value is skipped so it
 * cannot clobber their edits.
 */
export function useStreamingIndicator(): {
  streamingIndicator: StreamingIndicatorSettings;
  setShow(value: boolean): void;
  setLabel(value: string): void;
  setDot(value: boolean): void;
} {
  const streamingIndicator = useAtomValue(streamingIndicatorAtom);

  hydrateStreamingIndicator();

  return {
    streamingIndicator,
    setShow(value: boolean) {
      touched = true;
      updateStreamingIndicator({ show: value });
      persistStreamingIndicator();
    },
    setLabel(value: string) {
      touched = true;
      updateStreamingIndicator({ label: clampStreamingIndicatorLabel(value) });
      persistStreamingIndicator();
    },
    setDot(value: boolean) {
      touched = true;
      updateStreamingIndicator({ dot: value });
      persistStreamingIndicator();
    },
  };
}
