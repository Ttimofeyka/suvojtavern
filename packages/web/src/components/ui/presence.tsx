/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Presence — the one AnimatePresence wrapper.
 *
 * Mount/unmount choreography must be explicit in Motion: an exiting child
 * stays mounted (with its `exit` variant running) only while it is wrapped in
 * an <AnimatePresence>. Scattering raw <AnimatePresence> tags across the app
 * makes it easy to get the defaults subtly wrong, so this wrapper fixes the
 * house defaults and forwards everything else:
 *
 *   - `initial={false}` by default: content that is already on screen at mount
 *     should not replay its entrance. Call sites that *do* want a mount
 *     animation (the Modal) pass `initial` explicitly.
 *   - `mode="sync"`: entering and exiting children coexist, which is what a
 *     crossfading disclosure/section swap wants. Use `mode="wait"` when the
 *     incoming child must not overlap the outgoing one.
 *
 * The children are passed straight through — this is intentionally not a
 * component that clones or keys children; the caller owns the conditional
 * rendering and the `key` on each child.
 */

import type { AnimatePresenceProps } from "motion/react";
import { AnimatePresence } from "motion/react";
import type { ReactNode } from "react";

export interface PresenceProps {
  children?: ReactNode;
  /** How entering/exiting children coordinate. Defaults to "sync". */
  mode?: AnimatePresenceProps["mode"];
  /** Replay entrance animations on first mount. Defaults to false. */
  initial?: boolean;
  /** Fires once every exiting child has finished its `exit` transition. */
  onExitComplete?: () => void;
}

export function Presence({
  children,
  mode = "sync",
  initial = false,
  onExitComplete,
}: PresenceProps) {
  return (
    <AnimatePresence mode={mode} initial={initial} onExitComplete={onExitComplete}>
      {children}
    </AnimatePresence>
  );
}
