/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Same opt-in truthiness rule the server applies to `SUVOJ_LAN`: absent or a
 * documented falsy string keeps the dev server loopback-only; anything else
 * binds all interfaces so the app is reachable from the LAN.
 *
 * NOTE: duplicated (deliberately, no cross-package import) as `flagEnabled` in
 * `packages/server/src/access.ts`. Keep both in sync with the `SUVOJ_LAN`
 * bullet in `AGENTS.md` ("Server env vars").
 */
function lanEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: lanEnabled(process.env.SUVOJ_LAN) ? true : undefined,
    proxy: {
      "/api": "http://localhost:3210",
      "/blobs": "http://localhost:3210",
    },
  },
});
