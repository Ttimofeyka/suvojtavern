/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { MessageTrackerResponse } from "../../lib/api-tracker";
import { getMessageTracker } from "../../lib/api-tracker";
import { riseVariants, useAppMotion } from "../../lib/motion";
import { capitalizeSnapshot } from "../../lib/tracker-display";
import { TemplateFrame } from "../shared/TemplateFrame";
import { TriangleAlert } from "../ui/icons";
import Modal from "../ui/Modal";
import { Presence } from "../ui/presence";

interface MessageTrackerViewerProps {
  /** The swipe row whose tracker is shown (the bubble's chosen variant). */
  messageId: string;
  onClose: () => void;
}

/**
 * Read-only modal for ONE message/swipe row's tracker — the hover action's
 * viewer. It fetches the row directly (`GET /api/messages/:id/tracker`), so it
 * shows the swipe's own snapshot even when the tracker master switch is off,
 * its injection count is 0, or the snapshot has aged out of the drawer's
 * fallback window: the snapshot is persisted data, not a live setting.
 *
 * The body has four exclusive states — loading, fetch error, "no tracker for
 * this message", and the rendered snapshot — crossfaded through a wait-mode
 * Presence like the drawer panel's body. The modal itself always stays
 * closable, so an error never traps the user.
 */
export default function MessageTrackerViewer({ messageId, onClose }: MessageTrackerViewerProps) {
  // Null until the fetch settles; then the payload or the failure message.
  const [payload, setPayload] = useState<MessageTrackerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const app = useAppMotion();

  // Refetch when the row changes and drop a cancelled response (the modal
  // closed, or the bubble slid to another swipe) so a slow fetch never paints
  // into a viewer that is gone or now shows a different swipe.
  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError(null);
    getMessageTracker(messageId)
      .then((response) => {
        if (!cancelled) {
          setPayload(response);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error && err.message !== "" ? err.message : "Request failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const snapshot = payload?.snapshot ?? null;
  // Same display-only normalization the drawer panel applies (the model often
  // returns all-lowercase prose); never persisted. Keyed on the snapshot so an
  // unrelated re-render never re-walks the payload.
  const renderData = useMemo(() => (snapshot ? capitalizeSnapshot(snapshot.data) : {}), [snapshot]);

  return (
    <Modal title="Tracker" onClose={onClose}>
      <Presence mode="wait">
        {error ? (
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
            <span>{error}</span>
          </motion.div>
        ) : payload === null ? (
          <motion.div
            key="loading"
            className="tracker-viewer-loading"
            aria-hidden="true"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <span className="spinner" />
          </motion.div>
        ) : snapshot === null ? (
          <motion.p
            key="missing"
            className="tracker-viewer-missing"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            No tracker for this message.
          </motion.p>
        ) : (
          <motion.div
            key="frame"
            className="tracker-viewer-frame"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TemplateFrame
              html={payload.render?.html ?? ""}
              css={payload.render?.css}
              data={renderData}
            />
          </motion.div>
        )}
      </Presence>
    </Modal>
  );
}
