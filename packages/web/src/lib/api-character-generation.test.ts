/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_CHARACTER_GENERATION_PROMPT,
  normalizeCharacterGenerationConfig,
} from "./api-character-generation";

describe("normalizeCharacterGenerationConfig", () => {
  it("fills every field with its default for an empty object", () => {
    expect(normalizeCharacterGenerationConfig({})).toEqual({
      enabled: true,
      profile_id: "",
      system_prompt: DEFAULT_CHARACTER_GENERATION_PROMPT,
      max_response_tokens: 2048,
    });
  });

  it("treats a non-object (or missing) value as all defaults", () => {
    expect(normalizeCharacterGenerationConfig(undefined)).toEqual(
      normalizeCharacterGenerationConfig({}),
    );
    expect(normalizeCharacterGenerationConfig(null)).toEqual(
      normalizeCharacterGenerationConfig({}),
    );
    expect(normalizeCharacterGenerationConfig("nope")).toEqual(
      normalizeCharacterGenerationConfig({}),
    );
    expect(normalizeCharacterGenerationConfig([1, 2])).toEqual(
      normalizeCharacterGenerationConfig({}),
    );
  });

  it("merges a partial object, defaulting the fields it omits", () => {
    expect(
      normalizeCharacterGenerationConfig({ profile_id: "p1", max_response_tokens: 512 }),
    ).toEqual({
      enabled: true,
      profile_id: "p1",
      system_prompt: DEFAULT_CHARACTER_GENERATION_PROMPT,
      max_response_tokens: 512,
    });
  });

  it("keeps an explicit empty system prompt (a valid, meaningful value)", () => {
    expect(normalizeCharacterGenerationConfig({ system_prompt: "" }).system_prompt).toBe("");
  });

  it("keeps a complete valid config verbatim", () => {
    const config = {
      enabled: true,
      profile_id: "p2",
      system_prompt: "Write it.",
      max_response_tokens: 1,
    };
    expect(normalizeCharacterGenerationConfig(config)).toEqual(config);
  });

  it("preserves enabled: false and falls back to true for an invalid flag", () => {
    expect(normalizeCharacterGenerationConfig({ enabled: false }).enabled).toBe(false);
    expect(normalizeCharacterGenerationConfig({ enabled: "no" }).enabled).toBe(true);
    expect(normalizeCharacterGenerationConfig({ enabled: 0 }).enabled).toBe(true);
  });

  it("falls back per-field for invalid values", () => {
    expect(
      normalizeCharacterGenerationConfig({
        profile_id: 42,
        system_prompt: 99,
        max_response_tokens: "4096",
      }),
    ).toEqual({
      enabled: true,
      profile_id: "",
      system_prompt: DEFAULT_CHARACTER_GENERATION_PROMPT,
      max_response_tokens: 2048,
    });
  });

  it("replaces (never clamps) a below-minimum max_response_tokens", () => {
    expect(normalizeCharacterGenerationConfig({ max_response_tokens: 0 }).max_response_tokens).toBe(
      2048,
    );
    expect(
      normalizeCharacterGenerationConfig({ max_response_tokens: -5 }).max_response_tokens,
    ).toBe(2048);
  });

  it("falls back for a non-integer max_response_tokens", () => {
    expect(
      normalizeCharacterGenerationConfig({ max_response_tokens: 2.5 }).max_response_tokens,
    ).toBe(2048);
  });
});
