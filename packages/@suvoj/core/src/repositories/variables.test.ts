/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { createTestDb } from "../test-utils";
import { VariablesRepository } from "./kv";

let variables: VariablesRepository;

beforeEach(() => {
  variables = new VariablesRepository(createTestDb());
});

describe("VariablesRepository", () => {
  it("isolates global and chat scopes", () => {
    variables.set("global", null, "mood", "happy");
    variables.set("chat", "chat-1", "mood", "sad");
    variables.set("chat", "chat-2", "mood", "angry");
    expect(variables.get("global", null, "mood")).toBe("happy");
    expect(variables.get("chat", "chat-1", "mood")).toBe("sad");
    expect(variables.get("chat", "chat-2", "mood")).toBe("angry");
    expect(variables.list("global", null)).toEqual({ mood: "happy" });
    expect(variables.list("chat", "chat-1")).toEqual({ mood: "sad" });
  });

  it("upserts, deletes and stores structured JSON", () => {
    variables.set("global", null, "state", { bonds: { LS_US: 5 } });
    expect(variables.get("global", null, "state")).toEqual({ bonds: { LS_US: 5 } });
    variables.set("global", null, "state", "flat");
    expect(variables.get("global", null, "state")).toBe("flat");
    variables.set("global", null, "gone", 1);
    expect(variables.delete("global", null, "gone")).toBe(true);
    expect(variables.get("global", null, "gone")).toBe(null);
    expect(variables.list("global", null)).toEqual({ state: "flat" });
  });

  it("requires a chat id for the chat scope", () => {
    expect(() => variables.set("chat", null, "mood", "x")).toThrow();
    expect(() => variables.get("chat", null, "mood")).toThrow();
  });
});
