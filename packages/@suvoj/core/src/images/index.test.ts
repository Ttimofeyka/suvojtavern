/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import sharp from "sharp";
import { BLOB_DIR, readBlob, saveBlob, toWebp } from "./index";

afterAll(() => {
  rmSync(`${BLOB_DIR}/test`, { recursive: true, force: true });
});

/** A small distinctively-colored PNG. */
async function testPng(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#c0ffee" } })
    .png()
    .toBuffer();
}

describe("images", () => {
  it("converts any raster input to lossless WebP", async () => {
    const webp = await toWebp(await testPng(200, 120));
    // RIFF container with the WEBP codec tag.
    expect(webp.subarray(0, 4)).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46])); // "RIFF"
    expect(webp.subarray(8, 12)).toEqual(new Uint8Array([0x57, 0x45, 0x42, 0x50])); // "WEBP"
    const metadata = await sharp(webp).metadata();
    expect(metadata.format).toBe("webp");
  });

  it("shrinks oversized inputs without enlarging small ones", async () => {
    const downscaled = await toWebp(await testPng(2000, 1000), { maxWidth: 1024 });
    const small = await toWebp(await testPng(64, 64), { maxWidth: 1024 });
    expect((await sharp(downscaled).metadata()).width).toBe(1024);
    expect((await sharp(small).metadata()).width).toBe(64);
  });

  it("saves and reads blobs under the blob directory", async () => {
    const webp = await toWebp(await testPng(32, 32));
    const dir = `${BLOB_DIR}/test`;
    const path = saveBlob(webp, "webp", { dir });
    expect(path.startsWith(`${dir}/`)).toBe(true);
    expect(path.endsWith(".webp")).toBe(true);
    expect(readBlob(path)).toEqual(webp);
  });
});
