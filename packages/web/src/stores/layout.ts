/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

/** Transcript layout: unboxed shared column (default), role-aligned bubbles,
 *  or the legacy left-aligned bubble column. */
export type MessageView = "transcript" | "bubbles" | "flat";

export interface LayoutElements {
  avatars: boolean;
  timestamps: boolean;
  tokenCounter: boolean;
  /** Shows the gallery button in the chat header. */
  gallery: boolean;
  /** Shows the lorebook picker button in the chat header. */
  lorebooks: boolean;
}

export interface LayoutState {
  side: "left" | "right" | "top";
  /** Hides the Chats view's history column (only while a chat is open). */
  chatsPaneHidden: boolean;
  /**
   * Phone-width chat top bar only: render the streaming/tracker/summarizing
   * statuses as icon-only chips in the row's free space instead of full-text
   * pills, which is what lets the row stay one line. Inert on desktop, where
   * the text pills always render.
   */
  compactStatus: boolean;
  /**
   * How the transcript lays out: "transcript" puts both speakers on one shared
   * reading edge with unboxed prose (the default); "bubbles" keeps each role on
   * its own side; "flat" is the legacy left-aligned bubble column. A top-level
   * field, not an element — the `elements` map is boolean-only.
   */
  messageView: MessageView;
  /**
   * On touch/phone widths, a message can be swiped sideways to move through
   * its swipes. On by default. A top-level field, not an element — the
   * `elements` map is boolean-visibility-only.
   */
  swipeGestures: boolean;
  elements: LayoutElements;
}

export const DEFAULT_LAYOUT: LayoutState = {
  side: "left",
  chatsPaneHidden: false,
  compactStatus: true,
  messageView: "transcript",
  swipeGestures: true,
  elements: {
    avatars: true,
    timestamps: true,
    tokenCounter: false,
    gallery: true,
    lorebooks: true,
  },
};

export const layoutAtom = atom<LayoutState>(DEFAULT_LAYOUT);

/**
 * Per-field atoms so a hot consumer (a message row reading just `avatars`)
 * re-renders only when its own field changes. The whole-object atom above
 * stays the write surface and the `useLayout()` snapshot.
 */
export const layoutSideAtom = atom((get) => get(layoutAtom).side);
export const layoutChatsPaneHiddenAtom = atom((get) => get(layoutAtom).chatsPaneHidden);
export const layoutMessageViewAtom = atom((get) => get(layoutAtom).messageView);
export const layoutSwipeGesturesAtom = atom((get) => get(layoutAtom).swipeGestures);
export const layoutElementsAtom = atom((get) => get(layoutAtom).elements);
export const layoutAvatarsAtom = atom((get) => get(layoutAtom).elements.avatars);
export const layoutTimestampsAtom = atom((get) => get(layoutAtom).elements.timestamps);
export const layoutTokenCounterAtom = atom((get) => get(layoutAtom).elements.tokenCounter);
export const layoutGalleryAtom = atom((get) => get(layoutAtom).elements.gallery);
export const layoutLorebooksAtom = atom((get) => get(layoutAtom).elements.lorebooks);

let initialized = false;
let touched = false;

type Side = LayoutState["side"];

function isSide(value: unknown): value is Side {
  return value === "left" || value === "right" || value === "top";
}

function isMessageView(value: unknown): value is MessageView {
  return value === "transcript" || value === "bubbles" || value === "flat";
}

function readSetting(settings: unknown, key: string): unknown {
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  return (settings as Record<string, unknown>)[key] ?? null;
}

/** Merge an unknown stored value onto the defaults, tolerating null/bad shapes.
 *  Unknown/legacy keys (e.g. the removed `collapsed`) are ignored, not merged. */
export function storedLayout(value: unknown): LayoutState {
  const next: LayoutState = {
    side: DEFAULT_LAYOUT.side,
    chatsPaneHidden: DEFAULT_LAYOUT.chatsPaneHidden,
    compactStatus: DEFAULT_LAYOUT.compactStatus,
    messageView: DEFAULT_LAYOUT.messageView,
    swipeGestures: DEFAULT_LAYOUT.swipeGestures,
    elements: { ...DEFAULT_LAYOUT.elements },
  };
  if (typeof value === "object" && value !== null) {
    const stored = value as Record<string, unknown>;
    if (isSide(stored.side)) {
      next.side = stored.side;
    }
    if (typeof stored.chatsPaneHidden === "boolean") {
      next.chatsPaneHidden = stored.chatsPaneHidden;
    }
    if (typeof stored.compactStatus === "boolean") {
      next.compactStatus = stored.compactStatus;
    }
    if (isMessageView(stored.messageView)) {
      next.messageView = stored.messageView;
    }
    if (typeof stored.swipeGestures === "boolean") {
      next.swipeGestures = stored.swipeGestures;
    }
    if (typeof stored.elements === "object" && stored.elements !== null) {
      const elements = stored.elements as Record<string, unknown>;
      for (const key of [
        "avatars",
        "timestamps",
        "tokenCounter",
        "gallery",
        "lorebooks",
      ] as const) {
        if (typeof elements[key] === "boolean") {
          next.elements[key] = elements[key] as boolean;
        }
      }
    }
  }
  return next;
}

/** Immutable merge; the layout atom always holds a fresh object. */
function updateLayout(patch: Partial<LayoutState>): void {
  appStore.set(layoutAtom, { ...appStore.get(layoutAtom), ...patch });
}

function persistLayout(): void {
  const layout = appStore.get(layoutAtom);
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      layout: {
        side: layout.side,
        chatsPaneHidden: layout.chatsPaneHidden,
        compactStatus: layout.compactStatus,
        messageView: layout.messageView,
        swipeGestures: layout.swipeGestures,
        elements: { ...layout.elements },
      },
    }),
  }).catch(() => {});
}

/**
 * Layout store. The first call hydrates the stored layout from
 * GET /api/settings without blocking render; mutations persist the whole
 * layout object (fire-and-forget). If the user interacts before hydration
 * finishes, the stored value is skipped so it cannot clobber their edits.
 */
export function useLayout(): {
  layout: LayoutState;
  setSide(side: Side): void;
  toggleChatsPane(): void;
  setCompactStatus(value: boolean): void;
  setMessageView(view: MessageView): void;
  setSwipeGestures(value: boolean): void;
  toggleElement(key: keyof LayoutElements): void;
} {
  const layout = useAtomValue(layoutAtom);

  if (!initialized) {
    initialized = true;
    fetch("/api/settings")
      .then((response) => (response.ok ? response.json() : null))
      .then((settings: unknown) => {
        if (touched) {
          return;
        }
        appStore.set(layoutAtom, storedLayout(readSetting(settings, "layout")));
      })
      .catch(() => {});
  }

  return {
    layout,
    setSide(side: Side) {
      touched = true;
      updateLayout({ side });
      persistLayout();
    },
    toggleChatsPane() {
      touched = true;
      updateLayout({ chatsPaneHidden: !appStore.get(layoutAtom).chatsPaneHidden });
      persistLayout();
    },
    setCompactStatus(value: boolean) {
      touched = true;
      updateLayout({ compactStatus: value });
      persistLayout();
    },
    setMessageView(view: MessageView) {
      touched = true;
      updateLayout({ messageView: view });
      persistLayout();
    },
    setSwipeGestures(value: boolean) {
      touched = true;
      updateLayout({ swipeGestures: value });
      persistLayout();
    },
    toggleElement(key: keyof LayoutElements) {
      touched = true;
      const elements = appStore.get(layoutAtom).elements;
      updateLayout({ elements: { ...elements, [key]: !elements[key] } });
      persistLayout();
    },
  };
}
