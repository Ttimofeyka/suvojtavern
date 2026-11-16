/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Themes available in the app; ids match the `data-theme` values from src/styles. */
export const BUILT_IN_THEMES = [
  { id: "tavern", name: "Tavern", kind: "dark" },
  { id: "midnight", name: "Midnight", kind: "dark" },
  { id: "coffee", name: "Coffee", kind: "dark" },
  { id: "aurora", name: "Aurora", kind: "dark" },
  { id: "nebula", name: "Nebula", kind: "dark" },
  { id: "daylight", name: "Daylight", kind: "light" },
  { id: "paper", name: "Paper", kind: "light" },
  { id: "mist", name: "Mist", kind: "light" },
  { id: "lagoon", name: "Lagoon", kind: "light" },
] as const;
