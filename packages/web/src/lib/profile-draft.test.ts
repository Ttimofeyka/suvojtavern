/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { Profile } from "./api-profiles";
import {
  createInput,
  type Draft,
  draftFrom,
  endpointError,
  endpointHost,
  updatePatch,
} from "./profile-draft";

/** A saved profile fixture (the read shape; no `api_key` field ever). */
function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    name: "Main",
    model: "gpt-4o-mini",
    base_url: "",
    sampling: { temperature: 0.7, stream: true },
    is_default: false,
    has_api_key: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    name: "Main",
    model: "gpt-4o-mini",
    base_url: "",
    api_key: "",
    clearApiKey: false,
    samplers: {
      temperature: "0.7",
      top_p: "",
      repetition_penalty: "",
      max_tokens: "",
      context_size: "",
    },
    reasoningEffort: "low",
    ...overrides,
  };
}

describe("draftFrom", () => {
  it("starts blank for a new profile with the default name", () => {
    expect(draftFrom(null)).toEqual({
      name: "New profile",
      model: "",
      base_url: "",
      api_key: "",
      clearApiKey: false,
      samplers: {
        temperature: "",
        top_p: "",
        repetition_penalty: "",
        max_tokens: "",
        context_size: "",
      },
      reasoningEffort: "low",
    });
  });

  it("copies a stored reasoning effort, falling back to the default", () => {
    expect(draftFrom(profile({ sampling: { reasoning_effort: "high" } })).reasoningEffort).toBe(
      "high",
    );
    expect(draftFrom(profile({ sampling: { reasoning_effort: "off" } })).reasoningEffort).toBe(
      "off",
    );
    expect(draftFrom(profile({ sampling: { reasoning_effort: "max" } })).reasoningEffort).toBe(
      "low",
    );
  });

  it("copies base_url and stringifies numeric samplers, never the secret", () => {
    const result = draftFrom(
      profile({ base_url: "https://llm.example/v1", sampling: { temperature: 0.7 } }),
    );
    expect(result.base_url).toBe("https://llm.example/v1");
    expect(result.api_key).toBe("");
    expect(result.clearApiKey).toBe(false);
    expect(result.samplers.temperature).toBe("0.7");
    expect(result.samplers.top_p).toBe("");
  });

  it("ignores non-numeric sampler values (e.g. the stream boolean)", () => {
    const result = draftFrom(profile({ sampling: { temperature: 0.7, stream: true } }));
    expect(result.samplers.temperature).toBe("0.7");
  });
});

describe("endpointError", () => {
  it("accepts empty (no endpoint) and http(s) URLs", () => {
    expect(endpointError("")).toBeNull();
    expect(endpointError("   ")).toBeNull();
    expect(endpointError("http://127.0.0.1:11434")).toBeNull();
    expect(endpointError("https://llm.example.com/v1")).toBeNull();
  });

  it("rejects non-URL text and non-http(s) protocols", () => {
    expect(endpointError("not-a-url")).not.toBeNull();
    expect(endpointError("ftp://nope")).not.toBeNull();
    expect(endpointError("llm.example.com")).not.toBeNull();
  });
});

describe("endpointHost", () => {
  it("returns the host of a valid URL and the raw value otherwise", () => {
    expect(endpointHost("https://llm.example.com/v1")).toBe("llm.example.com");
    expect(endpointHost("http://127.0.0.1:11434")).toBe("127.0.0.1:11434");
    expect(endpointHost("legacy")).toBe("legacy");
  });
});

describe("createInput", () => {
  it("trims every field and always sends api_key (empty means no key)", () => {
    const input = createInput(
      draft({ name: "  Main ", model: " m ", base_url: " https://x.example/v1 ", api_key: " " }),
      { temperature: 0.7 },
    );
    expect(input).toEqual({
      name: "Main",
      model: "m",
      base_url: "https://x.example/v1",
      api_key: "",
      sampling: { temperature: 0.7, reasoning_effort: "low" },
    });
  });

  it("sends the draft's reasoning effort", () => {
    const input = createInput(draft({ reasoningEffort: "medium" }), {});
    expect(input.sampling).toEqual({ reasoning_effort: "medium" });
  });
});

describe("updatePatch api_key semantics", () => {
  it("omits api_key when the user typed nothing and did not clear", () => {
    const patch = updatePatch(draft(), { temperature: 0.7 });
    expect("api_key" in patch).toBe(false);
    expect(patch).toEqual({
      name: "Main",
      model: "gpt-4o-mini",
      base_url: "",
      sampling: { temperature: 0.7, reasoning_effort: "low" },
    });
  });

  it("sends the draft's reasoning effort", () => {
    const patch = updatePatch(draft({ reasoningEffort: "off" }), {});
    expect(patch.sampling).toEqual({ reasoning_effort: "off" });
  });

  it("sends the trimmed typed key when the user entered one", () => {
    const patch = updatePatch(draft({ api_key: "  sk-new  " }), {});
    expect(patch.api_key).toBe("sk-new");
  });

  it("sends null when the user cleared a stored key", () => {
    const patch = updatePatch(draft({ clearApiKey: true }), {});
    expect(patch.api_key).toBeNull();
  });

  it("lets a typed value supersede a pending clear", () => {
    const patch = updatePatch(draft({ api_key: "sk-new", clearApiKey: true }), {});
    expect(patch.api_key).toBe("sk-new");
  });

  it("never sends the literal empty string as a replacement key", () => {
    const cleared = updatePatch(draft({ api_key: "   ", clearApiKey: true }), {});
    expect(cleared.api_key).toBeNull();
    const kept = updatePatch(draft({ api_key: "   " }), {});
    expect("api_key" in kept).toBe(false);
  });
});
