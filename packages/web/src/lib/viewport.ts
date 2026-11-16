/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** True at the phone breakpoint used across the mobile UI (≤760px). */
export function isMobileViewport(): boolean {
  return window.matchMedia("(max-width: 760px)").matches;
}
