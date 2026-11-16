/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from "react";
import { isMobileViewport } from "./viewport";

/**
 * Reactive phone-breakpoint flag. Mirrors {@link isMobileViewport}, but keeps
 * the value in component state and re-reads it when the media query flips, so
 * a resize across the 760px boundary re-renders the consumers that branch on it.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => isMobileViewport());

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const onChange = (): void => setIsMobile(query.matches);
    // Re-sync once on mount: the lazy initial value was read before the
    // subscription existed, so a flip in between must not be missed.
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
