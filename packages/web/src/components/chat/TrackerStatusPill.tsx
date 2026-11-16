/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { riseVariants, useAppMotion } from "../../lib/motion";
import { chatTrackerGeneratingAtom } from "../../stores/chat";
import { useTrackerIndicator } from "../../stores/tracker-indicator";
import { Radar } from "../ui/icons";
import { Presence } from "../ui/presence";

/**
 * Top-of-chat pill shown while a tracker generation runs — either the
 * automatic SSE "tracking" stage of a reply or the drawer's manual
 * Generate action, both of which flip the shared chat store's
 * `trackerGenerating` flag.
 *
 * Display preferences (on/off, label, dot) come from the shared tracker
 * indicator store so the Settings controls can shape the pill without the
 * header knowing about them.
 *
 * `compact` swaps the full-text pill for an icon-only chip at phone widths
 * (see StreamingStatusPill for the shared rationale).
 */
export default function TrackerStatusPill({ compact = false }: { compact?: boolean }) {
  const trackerGenerating = useAtomValue(chatTrackerGeneratingAtom);
  const { trackerIndicator } = useTrackerIndicator();
  const app = useAppMotion();

  const show =
    trackerGenerating &&
    trackerIndicator.show &&
    // A pill with neither a label nor a dot would render as bare padding,
    // so suppress that case while still allowing a dot-only indicator.
    (trackerIndicator.label !== "" || trackerIndicator.dot);

  return (
    // Mirrors StreamingStatusPill: the wrapper lets the exit variant play when
    // the run ends, so the pill animates out instead of vanishing.
    <Presence>
      {show ? (
        compact ? (
          <motion.span
            key="tracker-icon"
            className="pill status-icon"
            role="status"
            aria-label={trackerIndicator.label}
            data-tip={trackerIndicator.label}
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <Radar size={14} />
          </motion.span>
        ) : (
          <motion.span
            key="tracker-pill"
            className="pill"
            role="status"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {trackerIndicator.dot && <span className="live-dot" aria-hidden="true" />}
            {trackerIndicator.label}
          </motion.span>
        )
      ) : null}
    </Presence>
  );
}
