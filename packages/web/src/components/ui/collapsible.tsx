/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Collapsible — animated height/opacity disclosure for grouping dense fields.
 *
 * Why height and not just transform: a disclosure has to reflow the content
 * below it as it opens, so the layout change is the point — a scaleY/translate
 * trick would either distort the content or overlap its neighbours. This is a
 * deliberate, scoped exception to the "transform/opacity only" house rule, and
 * it stays cheap because it only ever runs on small, local disclosures (never
 * on a whole view). Under reduced motion the open/close snaps in one frame.
 *
 * `initial={false}` matters here: a disclosure that starts open must not play
 * an entrance on first paint.
 *
 * By default children stay mounted while closed, only marked `inert`, so the
 * hidden content leaves the tab order and the a11y tree without the host having
 * to rebuild its fields on every toggle. `lazy` opts into the opposite for
 * large disclosures: children mount once opened, stay mounted through the close
 * animation, then unmount when it finishes — keeping a collapsed heavy body
 * (a lorebook section's card grid, say) off the initial render while still
 * letting the `height:"auto"` target measure the real content on open.
 */

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { INSTANT, useAppMotion } from "../../lib/motion";

export interface CollapsibleProps {
  open: boolean;
  children?: ReactNode;
  className?: string;
  /** Optional DOM id, e.g. for `aria-controls` on the trigger. */
  id?: string;
  /**
   * Unmount children while closed. Defaults to false (children always render).
   * When true, children mount on open and stay mounted through the close
   * animation, unmounting only once it completes.
   */
  lazy?: boolean;
}

export function Collapsible({
  open,
  children,
  className,
  id,
  lazy = false,
}: CollapsibleProps): ReactElement {
  const app = useAppMotion();
  // Slightly slower than the base tween: a height reflow reads better with a
  // little more time than an opacity swap. Collapses to zero under reduce.
  const transition = app.reduce ? INSTANT : { ...app.transition, duration: app.duration.med };

  // Lazy bookkeeping. `keepMounted` starts from `open` so a disclosure that
  // mounts open renders on first paint; the layout effect flips it true the
  // moment it opens, before paint, so the close that follows still has children
  // to animate out. `openRef` mirrors the latest `open` for the completion
  // callback: an interrupted close can still deliver an `onAnimationComplete`
  // (the reduced-motion path completes through a queued frame update), and
  // reading `open` from that closure would unmount children that a fast re-open
  // just brought back.
  const [keepMounted, setKeepMounted] = useState(open);
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
    if (open) {
      setKeepMounted(true);
    }
  }, [open]);

  return (
    <div className={cx("collapsible", className)} data-open={open ? "" : undefined}>
      <motion.div
        id={id}
        className="collapsible-inner"
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={transition}
        // `inert` (not aria-hidden) keeps the collapsed content out of the tab
        // order and the a11y tree; a focusable element inside aria-hidden is
        // still reachable, which is exactly the trap to avoid here.
        inert={!open}
        onAnimationComplete={() => {
          // Unmount only after the close animation has landed, and only if we
          // are still closed — a re-open must win any race with a stale
          // completion. When idle a completion with `open` true is a no-op.
          if (!openRef.current) {
            setKeepMounted(false);
          }
        }}
      >
        {!lazy || open || keepMounted ? children : null}
      </motion.div>
    </div>
  );
}
