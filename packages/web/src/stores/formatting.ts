/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

/** Toggles that control how chat message bodies are rendered. */
export interface MessageFormatting {
  quotes: boolean;
  italics: boolean;
  bold: boolean;
  underline: boolean;
  renderHtml: boolean;
  /** Accent color for quoted text; null leaves the theme default in place. */
  quoteColor: string | null;
  /** Accent color for italic text; null leaves the theme default in place. */
  italicColor: string | null;
  /** Accent color for underlined text; null leaves the theme default in place. */
  underlineColor: string | null;
}

export type TimestampMode = "always" | "hover" | "off";

export type TimestampFormat = "full" | "short" | "time" | "date" | "relative";

/** Controls when chat message timestamps appear and how they are written. */
export interface TimestampsState {
  mode: TimestampMode;
  format: TimestampFormat;
}

const DEFAULT_FORMATTING: MessageFormatting = {
  quotes: true,
  italics: true,
  bold: true,
  underline: true,
  renderHtml: true,
  quoteColor: null,
  italicColor: null,
  underlineColor: null,
};

const DEFAULT_TIMESTAMPS: TimestampsState = {
  mode: "always",
  format: "full",
};

export const formattingAtom = atom<MessageFormatting>(DEFAULT_FORMATTING);
export const timestampsAtom = atom<TimestampsState>(DEFAULT_TIMESTAMPS);

let initialized = false;
let touched = false;

function isTimestampMode(value: unknown): value is TimestampMode {
  return value === "always" || value === "hover" || value === "off";
}

function isTimestampFormat(value: unknown): value is TimestampFormat {
  return (
    value === "full" ||
    value === "short" ||
    value === "time" ||
    value === "date" ||
    value === "relative"
  );
}

function readSetting(settings: unknown, key: string): unknown {
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  return (settings as Record<string, unknown>)[key] ?? null;
}

/** Merge an unknown stored value onto the defaults, tolerating null/bad shapes. */
function storedFormatting(value: unknown): MessageFormatting {
  const next: MessageFormatting = { ...DEFAULT_FORMATTING };
  if (typeof value === "object" && value !== null) {
    const stored = value as Record<string, unknown>;
    for (const key of ["quotes", "italics", "bold", "underline", "renderHtml"] as const) {
      if (typeof stored[key] === "boolean") {
        next[key] = stored[key] as boolean;
      }
    }
    for (const key of ["quoteColor", "italicColor", "underlineColor"] as const) {
      const color = stored[key];
      if (typeof color === "string" || color === null) {
        next[key] = color;
      }
    }
  }
  return next;
}

/** Merge an unknown stored value onto the defaults, tolerating null/bad shapes. */
function storedTimestamps(value: unknown): TimestampsState {
  const next: TimestampsState = { ...DEFAULT_TIMESTAMPS };
  if (typeof value === "object" && value !== null) {
    const stored = value as Record<string, unknown>;
    if (isTimestampMode(stored.mode)) {
      next.mode = stored.mode;
    }
    if (isTimestampFormat(stored.format)) {
      next.format = stored.format;
    }
  }
  return next;
}

/** Set (or clear) one CSS custom property on the document root; no-op without a DOM. */
function applyColor(property: string, value: string | null): void {
  if (typeof document === "undefined") {
    return;
  }
  if (value === null) {
    document.documentElement.style.removeProperty(property);
  } else {
    document.documentElement.style.setProperty(property, value);
  }
}

/**
 * Mirror the current accent colors into their CSS custom properties:
 * quoteColor -> --msg-quote, italicColor -> --msg-em, underlineColor ->
 * --msg-underline. A null color removes the property so the theme default
 * applies again. Re-applying unchanged colors is harmless, so this is safe
 * to call after every formatting mutation as well as once after hydration.
 */
function applyColors(): void {
  const formatting = appStore.get(formattingAtom);
  applyColor("--msg-quote", formatting.quoteColor);
  applyColor("--msg-em", formatting.italicColor);
  applyColor("--msg-underline", formatting.underlineColor);
}

/** Immutable field merge; the formatting atom always holds a fresh object. */
function updateFormatting<K extends keyof MessageFormatting>(
  key: K,
  value: MessageFormatting[K],
): void {
  appStore.set(formattingAtom, {
    ...appStore.get(formattingAtom),
    [key]: value,
  } as MessageFormatting);
}

/** Immutable field merge; the timestamps atom always holds a fresh object. */
function updateTimestamps<K extends keyof TimestampsState>(
  key: K,
  value: TimestampsState[K],
): void {
  appStore.set(timestampsAtom, {
    ...appStore.get(timestampsAtom),
    [key]: value,
  } as TimestampsState);
}

/** Persist the whole message_formatting object; failures are ignored. */
function persistFormatting(): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_formatting: { ...appStore.get(formattingAtom) } }),
  }).catch(() => {});
}

/** Persist the whole timestamps object; failures are ignored. */
function persistTimestamps(): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timestamps: { ...appStore.get(timestampsAtom) } }),
  }).catch(() => {});
}

/** Intl.DateTimeFormat is expensive to construct, so cache one per option set. */
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatDateTime(date: Date, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let formatter = dateTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    dateTimeFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

/** Coarse relative labels; past a week we fall back to the medium date. */
function formatRelative(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return formatDateTime(date, { dateStyle: "medium" });
}

/**
 * Format an ISO timestamp for display. Reads the live timestamps atom, so a
 * caller that subscribes to `timestampsAtom` (or uses `useFormatting()`)
 * re-renders when the format setting changes. Dates that fail to parse return
 * an empty string so callers can render as-is.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  switch (appStore.get(timestampsAtom).format) {
    case "short":
      return formatDateTime(date, { dateStyle: "medium", timeStyle: "short" });
    case "time":
      return formatDateTime(date, { timeStyle: "short" });
    case "date":
      return formatDateTime(date, { dateStyle: "medium" });
    case "relative":
      return formatRelative(date);
    default:
      return formatDateTime(date, { dateStyle: "long", timeStyle: "short" });
  }
}

/**
 * Non-hook snapshot of the live message formatting. Callers outside React —
 * the markdown renderer reads this on every render — must not invoke a hook
 * just to read the store, so this hands back the store-backed value directly.
 * It is evaluated at call time, so a caller that re-renders (because it
 * subscribes to formattingAtom) sees the user's current toggles.
 */
export function formattingSnapshot(): MessageFormatting {
  return appStore.get(formattingAtom);
}

/**
 * Runs the one-time hydration of stored formatting and timestamp settings
 * from GET /api/settings without blocking render. Split out of
 * useFormatting() so non-React callers (app boot in index.tsx) can trigger it
 * without a hook; the `initialized` guard makes repeat calls cheap. If the
 * user interacts before hydration finishes, the stored value is skipped so it
 * cannot clobber their edits.
 */
export function hydrateFormatting(): void {
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
      appStore.set(formattingAtom, storedFormatting(readSetting(settings, "message_formatting")));
      applyColors();
      appStore.set(timestampsAtom, storedTimestamps(readSetting(settings, "timestamps")));
    })
    .catch(() => {});
}

/**
 * Formatting store. The first call hydrates the stored message formatting and
 * timestamp settings (see {@link hydrateFormatting}) without blocking render;
 * mutations persist the whole object for the affected settings key
 * (fire-and-forget). If the user interacts before hydration finishes, the
 * stored value is skipped so it cannot clobber their edits.
 */
export function useFormatting(): {
  formatting: MessageFormatting;
  setFormatting<K extends keyof MessageFormatting>(key: K, value: MessageFormatting[K]): void;
  timestamps: TimestampsState;
  setTimestamps<K extends keyof TimestampsState>(key: K, value: TimestampsState[K]): void;
} {
  const formatting = useAtomValue(formattingAtom);
  const timestamps = useAtomValue(timestampsAtom);

  hydrateFormatting();

  return {
    formatting,
    setFormatting(key, value) {
      touched = true;
      updateFormatting(key, value);
      applyColors();
      persistFormatting();
    },
    timestamps,
    setTimestamps(key, value) {
      touched = true;
      updateTimestamps(key, value);
      persistTimestamps();
    },
  };
}
