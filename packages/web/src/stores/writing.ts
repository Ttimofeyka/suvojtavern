/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { DEFAULT_WRITING_STYLE, isWritingStyle, type WritingStyle } from "../lib/writing-styles";
import { appStore } from "./store";

/**
 * How the open transcript reveals a streaming reply — see lib/writing-styles.
 * A client-owned display preference stored verbatim by the server, like the
 * indicator settings.
 */
export const writingStyleAtom = atom<WritingStyle>(DEFAULT_WRITING_STYLE);

let initialized = false;
let touched = false;

function readSetting(settings: unknown, key: string): unknown {
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  return (settings as Record<string, unknown>)[key] ?? null;
}

/** Merge an unknown stored value onto the default, tolerating null/bad shapes. */
export function storedWritingStyle(value: unknown): WritingStyle {
  return isWritingStyle(value) ? value : DEFAULT_WRITING_STYLE;
}

/** Persist the whole writing_style string; failures are ignored. */
function persistWritingStyle(): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writing_style: appStore.get(writingStyleAtom) }),
  }).catch(() => {});
}

/**
 * Runs the one-time hydration of the stored writing style from
 * GET /api/settings without blocking render. Split out of useWriting() so app
 * boot can trigger it without a hook — a stream can begin before Settings is
 * ever opened, and the reveal controller reads the atom then. If the user
 * interacts before hydration finishes, the stored value is skipped so it
 * cannot clobber their edits.
 */
export function hydrateWriting(): void {
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
      appStore.set(writingStyleAtom, storedWritingStyle(readSetting(settings, "writing_style")));
    })
    .catch(() => {});
}

/**
 * Writing-style store. Hydration runs through {@link hydrateWriting} (also
 * called at app boot); a mutation persists the whole writing_style string
 * (fire-and-forget). If the user interacts before hydration finishes, the
 * stored value is skipped so it cannot clobber their edit.
 */
export function useWriting(): {
  writingStyle: WritingStyle;
  setWritingStyle(value: WritingStyle): void;
} {
  const writingStyle = useAtomValue(writingStyleAtom);

  hydrateWriting();

  return {
    writingStyle,
    setWritingStyle(value) {
      touched = true;
      appStore.set(writingStyleAtom, value);
      persistWritingStyle();
    },
  };
}
