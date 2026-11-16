/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { riseVariants, useAppMotion } from "../../lib/motion";
import { chatSummarizingAtom } from "../../stores/chat";
import { useSummarizationIndicator } from "../../stores/summarization-indicator";
import { Sparkles } from "../ui/icons";
import { Presence } from "../ui/presence";

/**
 * Top-of-chat pill shown while a summary generates — either the automatic
 * SSE "summarizing" stage of a reply or the Summaries drawer's manual
 * "Summarize now", both of which flip the shared chat store's
 * `summarizing` flag.
 *
 * Display preferences (on/off, label, dot) come from the shared
 * summarization indicator store so the Settings controls can shape the pill
 * without the header knowing about them.
 *
 * `compact` swaps the full-text pill for an icon-only chip at phone widths
 * (see StreamingStatusPill for the shared rationale).
 */
export default function SummarizingStatusPill({ compact = false }: { compact?: boolean }) {
  const summarizing = useAtomValue(chatSummarizingAtom);
  const { summarizationIndicator } = useSummarizationIndicator();
  const app = useAppMotion();

  const show =
    summarizing &&
    summarizationIndicator.show &&
    // A pill with neither a label nor a dot would render as bare padding,
    // so suppress that case while still allowing a dot-only indicator.
    (summarizationIndicator.label !== "" || summarizationIndicator.dot);

  return (
    // Mirrors StreamingStatusPill: the wrapper lets the exit variant play when
    // the run ends, so the pill animates out instead of vanishing.
    <Presence>
      {show ? (
        compact ? (
          <motion.span
            key="summarizing-icon"
            className="pill status-icon"
            role="status"
            aria-label={summarizationIndicator.label}
            data-tip={summarizationIndicator.label}
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <Sparkles size={14} />
          </motion.span>
        ) : (
          <motion.span
            key="summarizing-pill"
            className="pill"
            role="status"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {summarizationIndicator.dot && <span className="live-dot" aria-hidden="true" />}
            {summarizationIndicator.label}
          </motion.span>
        )
      ) : null}
    </Presence>
  );
}
