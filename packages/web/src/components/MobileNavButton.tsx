/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMobileNav } from "../stores/mobile-nav";
import { Menu } from "./ui/icons";

/**
 * Phone-only hamburger that opens the off-canvas nav drawer. It lives inside
 * each screen's own header instead of a dedicated top bar, so no vertical
 * space is spent on chrome. CSS hides it above the 760px breakpoint and in
 * "top" sidebar mode, where the nav is already an inline icon strip.
 */
export default function MobileNavButton() {
  const { navOpen, toggleNav } = useMobileNav();
  return (
    <button
      type="button"
      className="btn btn-icon mobile-nav-trigger"
      aria-label="Open navigation"
      aria-expanded={navOpen}
      onClick={toggleNav}
    >
      <Menu size={20} />
    </button>
  );
}
