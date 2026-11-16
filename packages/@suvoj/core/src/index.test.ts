/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { CORE_NAME } from "./index";

describe("@suvoj/core", () => {
  it("exposes a name constant", () => {
    expect(CORE_NAME).toBe("@suvoj/core");
  });
});
