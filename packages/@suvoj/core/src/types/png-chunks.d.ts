/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambient module declarations for the png-chunks family (pure-JS packages
 * without bundled types).
 */

declare module "png-chunks-extract" {
  /** One PNG chunk: 4-byte type name + raw data (CRC stripped). */
  interface PngChunk {
    name: string;
    data: Uint8Array;
  }
  /** Splits a PNG buffer into its chunks (IHDR…IEND, CRCs verified/stripped). */
  function extract(buffer: Uint8Array): PngChunk[];
  export default extract;
}

declare module "png-chunk-text" {
  interface PngTextChunk {
    name: "tEXt";
    data: Uint8Array;
  }
  const PNGtext: {
    /** Builds a tEXt chunk from a keyword + latin1 text payload. */
    encode(keyword: string, text: string): PngTextChunk;
    /** Decodes a tEXt chunk's data back into keyword + text. */
    decode(data: Uint8Array): { keyword: string; text: string };
  };
  export default PNGtext;
}

declare module "png-chunks-encode" {
  /** Re-serializes chunks (CRCs recomputed) into a PNG buffer. */
  function encode(chunks: Array<{ name: string; data: Uint8Array }>): Uint8Array;
  export default encode;
}
