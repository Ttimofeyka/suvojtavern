/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference types="vite/client" />
/* @refresh reload */
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/design.css";
import "./styles/shell.css";
import "./styles/motion.css";
import "./styles/motion-primitives.css";
import "@fontsource-variable/inter";
import App from "./App";
import { mountTooltip } from "./lib/tooltip";
import { hydrateChatStore } from "./stores/chat";
import { hydrateChatHistory } from "./stores/chat-history";
import { hydrateFormatting } from "./stores/formatting";
import { hydrateStreamingIndicator } from "./stores/streaming-indicator";
import { hydrateSummarizationIndicator } from "./stores/summarization-indicator";
import { hydrateTrackerIndicator } from "./stores/tracker-indicator";
import { hydrateWriting } from "./stores/writing";

// Default theme before first paint; the settings store overrides this later.
document.documentElement.dataset.theme = "tavern";

// Default design attributes before first paint so the shell renders with the
// intended motion/surfaces/blur/translucency until the design store hydrates
// and overwrites them. The font scales need no boot value: their 1× tokens are
// the defaults, and the store writes the exact multipliers inline.
document.documentElement.dataset.motion = "full";
document.documentElement.dataset.surfaces = "elevated";
document.documentElement.dataset.blur = "medium";
document.documentElement.dataset.translucency = "balanced";

// One fixed-position tooltip element serves every `data-tip` in the app.
mountTooltip();

// Kick off the stored message-formatting/timestamp hydration at boot. The
// markdown renderer reads formattingSnapshot() synchronously, so the settings
// must start loading before the first message renders; components subscribe to
// formattingAtom and repaint when the fetch lands.
void hydrateFormatting();

// Same for the chat store's memory-strategy / summarized-mark settings: the
// transcript's "summarized" chip is derived from them, and hydration is now
// an explicit boot call rather than a side effect of a component calling
// useChatStore() (which nothing did).
void hydrateChatStore();

// The render-windowing (maxMessages) and indicator settings also hydrate at
// boot: MessageList reads chatHistoryAtom directly, and the streaming,
// tracker and summarization pills only call their hooks while a run is in
// flight, so none of those hooks is guaranteed to run — without these calls
// the stored values would not load until Settings → Chat Display opened.
void hydrateChatHistory();
void hydrateStreamingIndicator();
void hydrateTrackerIndicator();
void hydrateSummarizationIndicator();
// The writing style paces the live stream's reveal; hydrate it at boot so a
// stored choice applies to the first reply, not only after Settings opens.
void hydrateWriting();

// This app registers no service worker — one on this origin would be a stale
// leftover from a previous project, and it would intercept (and break) every
// /api fetch. Unregister it so the origin self-heals.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const registration of registrations) {
        void registration.unregister();
      }
    })
    .catch(() => {});
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root element not found in index.html");
}

createRoot(root).render(<App />);
