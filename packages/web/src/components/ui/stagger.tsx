/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Stagger / StaggerItem — a staggered list-reveal container.
 *
 * Motion's `staggerChildren` only sequences direct children that are motion
 * components sharing the parent's variant labels, so the "list reveal" has to
 * be a matched pair: <Stagger> provides the container variant, and each
 * <StaggerItem> provides the per-item `riseVariants`. Wrapping every list item
 * in a StaggerItem is the price of not hand-rolling `--stagger-i` indices (the
 * CSS approach in motion.css) at every call site.
 *
 * Under reduced motion the container's stagger delay and every item transition
 * collapse, so the whole list simply appears — no cascade.
 */

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { riseVariants, staggerContainer, useAppMotion } from "../../lib/motion";

export interface StaggerProps {
  children?: ReactNode;
  className?: string;
  /** Seconds between child entrances. Defaults to 0.05. */
  step?: number;
}

export function Stagger({ children, className, step }: StaggerProps): ReactElement {
  const app = useAppMotion();
  return (
    <motion.div
      className={cx("stagger", className)}
      variants={staggerContainer(app, step)}
      initial="hidden"
      animate="visible"
    >
      {children}
    </motion.div>
  );
}

export interface StaggerItemProps {
  children?: ReactNode;
  className?: string;
  /** Entrance travel in px. Defaults to 8 (matches `.anim-rise`). */
  distance?: number;
}

export function StaggerItem({ children, className, distance }: StaggerItemProps): ReactElement {
  const app = useAppMotion();
  return (
    <motion.div className={cx("stagger-item", className)} variants={riseVariants(app, distance)}>
      {children}
    </motion.div>
  );
}
