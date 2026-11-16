/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

/** Render-windowing settings for the chat history list. */
export interface ChatHistorySettings {
  maxMessages: number;
}

export const DEFAULT_CHAT_HISTORY: ChatHistorySettings = { maxMessages: 50 };

export const MIN_MAX_MESSAGES = 10;
export const MAX_MAX_MESSAGES = 500;

export const chatHistoryAtom = atom<ChatHistorySettings>(DEFAULT_CHAT_HISTORY);

let initialized = false;
let touched = false;

function readSetting(settings: unknown, key: string): unknown {
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  return (settings as Record<string, unknown>)[key] ?? null;
}

/** Clamp to the supported range and truncate to a whole message count. */
export function clampMaxMessages(value: number): number {
  return Math.min(MAX_MAX_MESSAGES, Math.max(MIN_MAX_MESSAGES, Math.trunc(value)));
}

/** Merge an unknown stored value onto the defaults, tolerating null/bad shapes. */
export function storedChatHistory(value: unknown): ChatHistorySettings {
  const next: ChatHistorySettings = { ...DEFAULT_CHAT_HISTORY };
  if (typeof value === "object" && value !== null) {
    const stored = value as Record<string, unknown>;
    if (typeof stored.maxMessages === "number" && Number.isFinite(stored.maxMessages)) {
      next.maxMessages = clampMaxMessages(stored.maxMessages);
    }
  }
  return next;
}

/** Persist the whole chat_history object; failures are ignored. */
function persistChatHistory(): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_history: { ...appStore.get(chatHistoryAtom) } }),
  }).catch(() => {});
}

/**
 * Runs the one-time hydration of the stored render-windowing settings from
 * GET /api/settings without blocking render. Split out of useChatHistory() so
 * non-React callers (app boot in index.tsx) can trigger it without a hook —
 * MessageList reads chatHistoryAtom directly, so relying on a component
 * happening to call the hook would defer the stored maxMessages until
 * Settings → Chat Display opens. The `initialized` guard makes repeat calls
 * cheap. If the user interacts before hydration finishes, the stored value is
 * skipped so it cannot clobber their edits.
 */
export function hydrateChatHistory(): void {
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
      appStore.set(chatHistoryAtom, storedChatHistory(readSetting(settings, "chat_history")));
    })
    .catch(() => {});
}

/**
 * Chat history store. Hydration runs through {@link hydrateChatHistory} (also
 * called at app boot); mutations persist the whole chat_history object
 * (fire-and-forget). If the user interacts before hydration finishes, the
 * stored value is skipped so it cannot clobber their edits.
 */
export function useChatHistory(): {
  chatHistory: ChatHistorySettings;
  setMaxMessages(value: number): void;
} {
  const chatHistory = useAtomValue(chatHistoryAtom);

  hydrateChatHistory();

  return {
    chatHistory,
    setMaxMessages(value: number) {
      touched = true;
      appStore.set(chatHistoryAtom, { maxMessages: clampMaxMessages(value) });
      persistChatHistory();
    },
  };
}
