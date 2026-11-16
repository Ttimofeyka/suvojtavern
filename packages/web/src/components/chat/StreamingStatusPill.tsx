/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { riseVariants, useAppMotion } from "../../lib/motion";
import { chatStreamingAtom } from "../../stores/chat";
import { useStreamingIndicator } from "../../stores/streaming-indicator";
import { LoaderCircle } from "../ui/icons";
import { Presence } from "../ui/presence";

/**
 * Top-of-chat pill shown while a reply streams. Display preferences (on/off,
 * label, dot) come from the shared streaming indicator store so the Settings
 * card can shape the pill without the header knowing about them.
 *
 * `compact` swaps the full-text pill for an icon-only chip: at phone widths
 * the header renders one compact chip per status in the free space before the
 * budget pill, which keeps the row on one line even when the character
 * identity block is hidden (see ChatHeader).
 */
export default function StreamingStatusPill({ compact = false }: { compact?: boolean }) {
  const streaming = useAtomValue(chatStreamingAtom);
  const { streamingIndicator } = useStreamingIndicator();
  const app = useAppMotion();

  const show =
    streaming &&
    streamingIndicator.show &&
    // A pill with neither a label nor a dot would render as bare padding,
    // so suppress that case while still allowing a dot-only indicator.
    (streamingIndicator.label !== "" || streamingIndicator.dot);

  return (
    // Mounts only while a run is in flight, so the pulse loop below is the
    // "running" signal by construction — no idle state to suppress. The
    // wrapper also lets the exit variant run when the run ends.
    <Presence>
      {show ? (
        compact ? (
          <motion.span
            key="stream-icon"
            className="pill status-icon"
            role="status"
            aria-label={streamingIndicator.label}
            data-tip={streamingIndicator.label}
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {/* The spinner is the running signal here, so it keeps turning
                even under reduced motion (see .status-icon-spin). */}
            <LoaderCircle size={14} className="status-icon-spin" />
          </motion.span>
        ) : (
          <motion.span
            key="stream-pill"
            className="pill"
            role="status"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {streamingIndicator.dot && <span className="live-dot" aria-hidden="true" />}
            {streamingIndicator.label}
          </motion.span>
        )
      ) : null}
    </Presence>
  );
}
