/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Touch-swipe thresholds and decision logic for changing a message's swipe.
 *
 * `offsetX`/`velocityX` are pixel and pixels-per-second values, with positive
 * pointing rightward — the same shape Motion's PanInfo used to supply. Kept
 * DOM-free so the rules are unit testable without a browser.
 */

/** Minimum drag distance, in px, that counts as a deliberate swipe. */
export const SWIPE_OFFSET_PX = 48;

/** Minimum flick velocity, in px/s, that counts as a swipe even when short. */
export const SWIPE_VELOCITY_PX_S = 400;

export type SwipeDirection = "next" | "previous";

/** One end of a single-finger touch gesture: viewport coordinates in px and a
 *  `Date.now()` timestamp in ms. */
export interface TouchPoint {
  x: number;
  y: number;
  t: number;
}

/**
 * Reduce a single-finger touch gesture to the horizontal offset + velocity a
 * swipe decision needs, or null when it was not a horizontal swipe.
 *
 * This is the passive-listener replacement for Motion's pointer-capturing drag:
 * the endpoints are recorded on touchstart/touchend and the gesture is judged
 * only at the end, so the browser keeps owning scrolling and long-press text
 * selection (SillyTavern's swiped-events.js works the same way).
 *
 * A mostly-vertical gesture returns null so the transcript keeps scrolling
 * vertically, and a non-positive duration (both events landing in the same
 * millisecond, or a wall clock that ran backwards) has no meaningful velocity
 * and also returns null. `dtSeconds` is clamped to at least 1ms to keep the
 * division finite.
 */
export function swipeFromTouch(
  start: TouchPoint,
  end: TouchPoint,
): { offsetX: number; velocityX: number } | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < Math.abs(dy)) {
    return null;
  }
  if (end.t <= start.t) {
    return null;
  }
  const dtSeconds = Math.max(1, end.t - start.t) / 1000;
  return { offsetX: dx, velocityX: dx / dtSeconds };
}

/**
 * Resolve a horizontal drag into a swipe change, or null when the drag was not
 * a swipe (too short and too slow) or the direction is unavailable.
 *
 * Direction convention mirrors SillyTavern: dragging right-to-left (negative
 * `offsetX`) advances to the NEXT swipe — the finger pushes the current reply
 * away to reveal the next — while left-to-right goes back to the PREVIOUS.
 * When the drag cleared the distance threshold the sign is read from
 * `offsetX`; otherwise it is a quick flick whose tiny offset is unreliable, so
 * the sign comes from `velocityX`.
 */
export function resolveSwipe(
  offsetX: number,
  velocityX: number,
  options: { canNext: boolean; canPrevious: boolean },
): SwipeDirection | null {
  const far = Math.abs(offsetX) >= SWIPE_OFFSET_PX;
  const fast = Math.abs(velocityX) >= SWIPE_VELOCITY_PX_S;
  if (!far && !fast) {
    return null;
  }
  const horizontal = far ? offsetX : velocityX;
  const direction: SwipeDirection = horizontal < 0 ? "next" : "previous";
  if (direction === "next" && !options.canNext) {
    return null;
  }
  if (direction === "previous" && !options.canPrevious) {
    return null;
  }
  return direction;
}
