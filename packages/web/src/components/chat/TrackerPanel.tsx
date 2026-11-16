/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useMemo } from "react";
import { riseVariants, useAppMotion } from "../../lib/motion";
import { capitalizeSnapshot } from "../../lib/tracker-display";
import {
  chatTrackerAtom,
  chatTrackerErrorAtom,
  chatTrackerGeneratingAtom,
  chatTrackerNoticeAtom,
  clearAllTrackers,
  clearTrackerNotice,
  deleteMessageTracker,
  generateTracker,
  setChatTrackerEnabled,
} from "../../stores/chat";
import { TemplateFrame } from "../shared/TemplateFrame";
import { AppLink } from "../ui/AppLink";
import {
  Info,
  Layers,
  Radar,
  RotateCcw,
  Settings,
  Trash2,
  TriangleAlert,
  WandSparkles,
  X,
} from "../ui/icons";
import { Presence } from "../ui/presence";

interface TrackerPanelProps {
  /** The chat whose drawer is open (the panel itself reads the shared
   *  chat store's tracker state — the prop pins it to this chat). */
  chatId: string;
}

/**
 * The drawer's tracker tab: the snapshot attached to the selected swipe,
 * rendered through its preset's HTML template, plus the manual generate
 * action, a per-message delete in the head, and a chat-wide Clear all.
 *
 * Two switches gate tracking. The GLOBAL master (`tracker_config.enabled`,
 * Settings → Tracker) is the outer gate: with it off the panel shows a
 * read-only notice linking to Settings. This chat's own switch
 * (`chat_enabled`) is the inner gate the panel itself owns: turning it off
 * stops generation and prompt injection for this chat only, while the panel
 * (and every other chat) stays as it was.
 *
 * Clear all is available whenever the payload has loaded, even when the
 * shown swipe has no snapshot — trackers on other messages/swipes still
 * need clearing. The head trash, by contrast, deletes only the shown
 * message's tracker.
 *
 * All state comes from the chat store — the payload itself, the
 * generating flag (shared with the SSE "tracking" stage of running
 * replies), and the ok:false stream notice, which surfaces here as a
 * subtle dismissible hint rather than a chat-blocking error.
 */
export default function TrackerPanel({ chatId }: TrackerPanelProps) {
  const tracker = useAtomValue(chatTrackerAtom);
  const trackerGenerating = useAtomValue(chatTrackerGeneratingAtom);
  const trackerNotice = useAtomValue(chatTrackerNoticeAtom);
  const trackerError = useAtomValue(chatTrackerErrorAtom);
  const snapshot = tracker?.snapshot ?? null;
  const app = useAppMotion();

  // The card renders the snapshot verbatim, but the model often returns
  // all-lowercase values; normalize for display only (never persisted).
  // Keyed on the snapshot so typing elsewhere never re-walks the payload.
  const renderData = useMemo(() => (snapshot ? capitalizeSnapshot(snapshot.data) : {}), [snapshot]);

  // The global master is the outer gate; this chat's own switch is the inner
  // one. Both must be on for the panel's body to render a live tracker.
  const globallyEnabled = tracker?.enabled ?? false;
  const chatEnabled = tracker?.chat_enabled ?? true;
  const active = globallyEnabled && chatEnabled;

  const generate = (): void => {
    void generateTracker();
  };

  // Per-message: the snapshot belongs to the selected swipe row, so this
  // removes only that row's tracker. A manual/legacy snapshot without a
  // message_id has nothing to target.
  const removeMessage = (): void => {
    if (snapshot?.message_id == null) {
      return;
    }
    if (window.confirm("Delete this message's tracker?")) {
      void deleteMessageTracker(snapshot.message_id);
    }
  };

  const clearAll = (): void => {
    if (window.confirm("Delete every tracker in this chat?")) {
      void clearAllTrackers();
    }
  };

  return (
    <section className="tracker-panel" aria-label="Scene tracker" data-chat={chatId}>
      <header className="drawer-panel-head">
        <span className="drawer-panel-head-icon" aria-hidden="true">
          <Radar size={15} />
        </span>
        <strong>Tracker</strong>
        {/* Per-chat switch: the drawer's own gate, independent of the global
            master (which is shown as a read-only notice when off). It stays
            enabled while the global switch is off so the intent is legible —
            flipping it then only takes effect once the master is back on. */}
        <label
          className="switch tracker-chat-switch"
          data-tip={chatEnabled ? "Tracking on for this chat" : "Tracking off for this chat"}
        >
          <input
            type="checkbox"
            className="switch-input"
            aria-label="Track this chat"
            checked={chatEnabled}
            disabled={tracker === null}
            onChange={(event) => void setChatTrackerEnabled(event.currentTarget.checked)}
          />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
        </label>
        <span className="chat-header-spacer" />
        <motion.button
          type="button"
          className="btn tracker-run"
          disabled={trackerGenerating || !active}
          whileTap={app.reduce ? undefined : { scale: 0.96 }}
          onClick={generate}
        >
          {trackerGenerating ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <WandSparkles size={13} />
          )}
          {trackerGenerating ? "Generating…" : snapshot ? "Regenerate" : "Generate"}
        </motion.button>
        {snapshot ? (
          <motion.button
            type="button"
            className="btn btn-icon"
            aria-label="Delete this tracker"
            title="Delete this tracker"
            whileTap={app.reduce ? undefined : { scale: 0.96 }}
            onClick={removeMessage}
          >
            <Trash2 size={14} />
          </motion.button>
        ) : null}
      </header>
      {/* The notice and the error stack above the body and enter/leave on
          their own, so a tracker hiccup never reflows the rendered frame. */}
      <Presence>
        {trackerNotice ? (
          <motion.div
            key="notice"
            className="tracker-notice"
            role="status"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <Info size={13} />
            <span>{trackerNotice}</span>
            <button
              type="button"
              className="btn btn-icon tracker-notice-dismiss"
              aria-label="Dismiss tracker notice"
              onClick={() => clearTrackerNotice()}
            >
              <X size={12} />
            </button>
          </motion.div>
        ) : null}
      </Presence>
      <Presence>
        {trackerError ? (
          <motion.div
            key="error"
            className="drawer-panel-error"
            role="alert"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TriangleAlert size={14} />
            <span>{trackerError}</span>
            <button type="button" className="btn drawer-panel-retry" onClick={generate}>
              <RotateCcw size={13} />
              Retry
            </button>
          </motion.div>
        ) : null}
      </Presence>
      {/* Exclusive body states crossfade through a wait-mode Presence. */}
      <Presence mode="wait">
        {tracker === null ? (
          <motion.div
            key="loading"
            className="drawer-panel-loading"
            aria-hidden="true"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <span className="spinner" />
          </motion.div>
        ) : !globallyEnabled ? (
          <motion.div
            key="global-off"
            className="tracker-empty"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <span className="tracker-empty-icon" aria-hidden="true">
              <Settings size={22} strokeWidth={1.5} />
            </span>
            <span className="tracker-empty-title">Tracker is off</span>
            <span className="tracker-empty-hint">
              The tracker is disabled globally. Turn it on in Settings → Tracker to track this chat.
            </span>
            <AppLink className="btn" to="/settings">
              <Settings size={13} />
              Open tracker settings
            </AppLink>
          </motion.div>
        ) : !chatEnabled ? (
          <motion.div
            key="chat-off"
            className="tracker-empty"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <span className="tracker-empty-icon" aria-hidden="true">
              <Radar size={22} strokeWidth={1.5} />
            </span>
            <span className="tracker-empty-title">Tracking off for this chat</span>
            <span className="tracker-empty-hint">
              Snapshots are not generated and the last tracker is not injected into this chat's
              prompts. Turn tracking back on to resume.
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void setChatTrackerEnabled(true)}
            >
              <Radar size={13} />
              Enable for this chat
            </button>
          </motion.div>
        ) : snapshot ? (
          <motion.div
            key="frame"
            className="tracker-frame"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TemplateFrame
              html={tracker.render?.html ?? ""}
              css={tracker.render?.css}
              data={renderData}
            />
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            className="tracker-empty"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <span className="tracker-empty-icon" aria-hidden="true">
              <Radar size={22} strokeWidth={1.5} />
            </span>
            <span className="tracker-empty-title">No tracker snapshot yet</span>
            <span className="tracker-empty-hint">
              Generate reads the chat and extracts the current scene state.
            </span>
            <button type="button" className="btn btn-primary" onClick={generate}>
              <WandSparkles size={13} />
              Generate tracker
            </button>
          </motion.div>
        )}
      </Presence>
      {/* Chat-wide clear, kept out of the tight head row. Shown as soon as
          the payload loads — even in the empty state — so trackers on other
          messages/swipes can always be cleared. Per-message removal stays in
          the head next to Generate. Hidden entirely while tracking is off
          for this chat: there is nothing live to clear, and offering it
          beside the "off" explanation would muddy the state. */}
      <Presence>
        {tracker !== null && active ? (
          <motion.button
            key="clear-all"
            type="button"
            className="btn tracker-clear"
            aria-label="Clear all trackers"
            title="Clear all trackers"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
            whileTap={app.reduce ? undefined : { scale: 0.96 }}
            onClick={clearAll}
          >
            <Layers size={13} />
            Clear all trackers
          </motion.button>
        ) : null}
      </Presence>
    </section>
  );
}
