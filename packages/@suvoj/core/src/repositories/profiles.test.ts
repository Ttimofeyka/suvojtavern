/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { createTestDb } from "../test-utils";
import { ProfilesRepository } from "./profiles";

let profiles: ProfilesRepository;

beforeEach(() => {
  profiles = new ProfilesRepository(createTestDb());
});

describe("ProfilesRepository", () => {
  it("round-trips profiles", () => {
    const profile = profiles.create({
      name: "Main",
      model: "test-model",
      sampling: { temperature: 0.7, context_size: 32000 },
    });
    expect(profile).toMatchObject({
      name: "Main",
      model: "test-model",
      sampling: { temperature: 0.7, context_size: 32000 },
      is_default: false,
    });
    expect(profiles.get(profile.id)).toEqual(profile);
  });

  it("defaults model, sampling and is_default", () => {
    const profile = profiles.create({ name: "Main" });
    expect(profile).toMatchObject({
      model: "",
      sampling: {},
      is_default: false,
      base_url: "",
      has_api_key: false,
    });
  });

  it("round-trips base_url and api_key, exposing only has_api_key", () => {
    const profile = profiles.create({
      name: "Custom",
      base_url: "https://api.example.com/v1",
      api_key: "sk-secret",
    });
    expect(profile).toMatchObject({
      base_url: "https://api.example.com/v1",
      has_api_key: true,
    });
    // The plaintext key must never cross the read boundary.
    expect("api_key" in profile).toBe(false);
    expect(profiles.get(profile.id)).toEqual(profile);
    expect(profiles.list()[0]).toEqual(profile);
  });

  it("validates reasoning effort and round-trips it", () => {
    const profile = profiles.create({
      name: "Thinker",
      sampling: { reasoning_effort: "medium" },
    });
    expect(profiles.get(profile.id)?.sampling.reasoning_effort).toBe("medium");
    expect(
      profiles.update(profile.id, { sampling: { reasoning_effort: "off" } })?.sampling,
    ).toEqual({ reasoning_effort: "off" });
    expect(() =>
      profiles.create({ name: "Bad", sampling: { reasoning_effort: "max" as "off" } }),
    ).toThrow();
  });

  it("rejects a non-http(s) base_url", () => {
    expect(() => profiles.create({ name: "Bad", base_url: "ftp://example.com" })).toThrow();
    expect(() => profiles.create({ name: "Bad", base_url: "not a url" })).toThrow();
  });

  it("getSecret returns the endpoint credentials, null for unknown ids", () => {
    const profile = profiles.create({
      name: "Custom",
      base_url: "https://api.example.com",
      api_key: "sk-secret",
    });
    expect(profiles.getSecret(profile.id)).toEqual({
      base_url: "https://api.example.com",
      api_key: "sk-secret",
    });
    expect(profiles.getSecret("missing")).toBe(null);
    // Clearing the key via a patch is reflected in the secret read.
    profiles.update(profile.id, { api_key: null });
    expect(profiles.getSecret(profile.id)?.api_key).toBe("");
  });

  it("lists the default profile first, then by creation time", () => {
    const first = profiles.create({ name: "First" });
    const def = profiles.create({ name: "Default" }, { is_default: true });
    const second = profiles.create({ name: "Second" });
    expect(profiles.list().map((profile) => profile.id)).toEqual([def.id, first.id, second.id]);
  });

  it("updates name/model/sampling partially", () => {
    const profile = profiles.create({ name: "Main", model: "m1", sampling: { temperature: 1 } });
    const updated = profiles.update(profile.id, { model: "m2" });
    expect(updated).toMatchObject({ name: "Main", model: "m2", sampling: { temperature: 1 } });
    const swapped = profiles.update(profile.id, {
      name: "Renamed",
      sampling: { top_p: 0.9 },
    });
    expect(swapped).toMatchObject({ name: "Renamed", model: "m2", sampling: { top_p: 0.9 } });
  });

  it("patches base_url and keeps/clears/sets api_key", () => {
    const profile = profiles.create({
      name: "Main",
      base_url: "https://a.example.com",
      api_key: "sk-old",
    });
    expect(profile).toMatchObject({ base_url: "https://a.example.com", has_api_key: true });

    // Omitting api_key keeps the stored one; only base_url changes.
    const rebased = profiles.update(profile.id, { base_url: "https://b.example.com" });
    expect(rebased).toMatchObject({ base_url: "https://b.example.com", has_api_key: true });

    // `null` clears the key.
    const cleared = profiles.update(profile.id, { api_key: null });
    expect(cleared).toMatchObject({ has_api_key: false });
    expect(cleared).not.toHaveProperty("api_key");

    // A string replaces (or, after a clear, sets) the key.
    const setKey = profiles.update(profile.id, { api_key: "sk-new" });
    expect(setKey).toMatchObject({ has_api_key: true });

    // An empty base_url clears the endpoint (the profile has none).
    const reset = profiles.update(profile.id, { base_url: "" });
    expect(reset).toMatchObject({ base_url: "" });
  });

  it("returns null for unknown ids on get and update, and no-op patches keep the row", () => {
    const profile = profiles.create({ name: "Main" });
    expect(profiles.get("missing")).toBe(null);
    expect(profiles.update("missing", { name: "X" })).toBe(null);
    expect(profiles.update(profile.id, {})).toEqual(profile);
  });

  it("deletes profiles", () => {
    const profile = profiles.create({ name: "Main" });
    expect(profiles.delete(profile.id)).toBe(true);
    expect(profiles.delete(profile.id)).toBe(false);
    expect(profiles.get(profile.id)).toBe(null);
  });
});
