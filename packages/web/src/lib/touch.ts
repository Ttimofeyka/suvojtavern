/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** True when the primary pointer is imprecise — i.e. a phone/tablet touch
 *  screen. Its virtual keyboard has no modifier keys, so Enter must insert a
 *  newline there; only a hardware keyboard's bare Enter submits. Mirrors the
 *  `(pointer: coarse)` guard used for touch-only concerns. */
export function isTouchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}
