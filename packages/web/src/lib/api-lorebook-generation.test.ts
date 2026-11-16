/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LOREBOOK_GENERATION_PROMPT,
  normalizeLorebookGenerationConfig,
} from "./api-lorebook-generation";

describe("normalizeLorebookGenerationConfig", () => {
  it("fills every field with its default for an empty object", () => {
    expect(normalizeLorebookGenerationConfig({})).toEqual({
      enabled: true,
      profile_id: "",
      system_prompt: DEFAULT_LOREBOOK_GENERATION_PROMPT,
      max_response_tokens: 2048,
    });
  });

  it("treats a non-object (or missing) value as all defaults", () => {
    expect(normalizeLorebookGenerationConfig(undefined)).toEqual(
      normalizeLorebookGenerationConfig({}),
    );
    expect(normalizeLorebookGenerationConfig(null)).toEqual(normalizeLorebookGenerationConfig({}));
    expect(normalizeLorebookGenerationConfig("nope")).toEqual(
      normalizeLorebookGenerationConfig({}),
    );
    expect(normalizeLorebookGenerationConfig([1, 2])).toEqual(
      normalizeLorebookGenerationConfig({}),
    );
  });

  it("merges a partial object, defaulting the fields it omits", () => {
    expect(
      normalizeLorebookGenerationConfig({ profile_id: "p1", max_response_tokens: 512 }),
    ).toEqual({
      enabled: true,
      profile_id: "p1",
      system_prompt: DEFAULT_LOREBOOK_GENERATION_PROMPT,
      max_response_tokens: 512,
    });
  });

  it("keeps an explicit empty system prompt (a valid, meaningful value)", () => {
    expect(normalizeLorebookGenerationConfig({ system_prompt: "" }).system_prompt).toBe("");
  });

  it("keeps a complete valid config verbatim", () => {
    const config = {
      enabled: false,
      profile_id: "p2",
      system_prompt: "Write it.",
      max_response_tokens: 1,
    };
    expect(normalizeLorebookGenerationConfig(config)).toEqual(config);
  });

  it("preserves enabled: false and falls back to true for an invalid flag", () => {
    expect(normalizeLorebookGenerationConfig({ enabled: false }).enabled).toBe(false);
    expect(normalizeLorebookGenerationConfig({ enabled: "no" }).enabled).toBe(true);
    expect(normalizeLorebookGenerationConfig({ enabled: 0 }).enabled).toBe(true);
  });

  it("falls back per-field for invalid values", () => {
    expect(
      normalizeLorebookGenerationConfig({
        profile_id: 42,
        system_prompt: 99,
        max_response_tokens: "4096",
      }),
    ).toEqual({
      enabled: true,
      profile_id: "",
      system_prompt: DEFAULT_LOREBOOK_GENERATION_PROMPT,
      max_response_tokens: 2048,
    });
  });

  it("replaces (never clamps) a below-minimum max_response_tokens", () => {
    expect(normalizeLorebookGenerationConfig({ max_response_tokens: 0 }).max_response_tokens).toBe(
      2048,
    );
    expect(normalizeLorebookGenerationConfig({ max_response_tokens: -5 }).max_response_tokens).toBe(
      2048,
    );
  });

  it("falls back for a non-integer max_response_tokens", () => {
    expect(
      normalizeLorebookGenerationConfig({ max_response_tokens: 2.5 }).max_response_tokens,
    ).toBe(2048);
  });
});
