/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { createRepositories } from "../repositories";
import { at, createTestDb } from "../test-utils";
import type { MacroContext } from "./macros";
import { evaluateMacros, extractDefinedTags, presetDefinedTags } from "./macros";

function buildContext(overrides: Partial<MacroContext> = {}): MacroContext {
  const db = createTestDb();
  const repos = createRepositories(db);
  return {
    char: "Seraphina",
    user: "Alex",
    persona: "A curious traveler.",
    chatId: "chat-1",
    vars: repos.variables,
    ...overrides,
  };
}

describe("macros", () => {
  let ctx: MacroContext;
  beforeEach(() => {
    ctx = buildContext();
  });

  it("substitutes char, user and persona (case-insensitive names)", () => {
    expect(evaluateMacros("{{char}} meets {{user}}", ctx)).toBe("Seraphina meets Alex");
    expect(evaluateMacros("{{Char}} and {{USER}}", ctx)).toBe("Seraphina and Alex");
    expect(evaluateMacros("[{{persona}}]", ctx)).toBe("[A curious traveler.]");
  });

  it("formats time, date and weekday from a fixed clock", () => {
    const now = new Date("2026-09-04T15:45:00");
    expect(evaluateMacros("{{weekday}}", { ...ctx, now })).toBe("Friday");
    expect(evaluateMacros("{{date}}", { ...ctx, now })).toBe("September 4, 2026");
    expect(evaluateMacros("{{isotime}}", { ...ctx, now })).toBe("15:45");
    expect(evaluateMacros("{{time}}", { ...ctx, now })).toBe("3:45 PM");
  });

  it("humanizes idle duration with moment-like thresholds", () => {
    const now = new Date("2026-09-04T12:00:00");
    const idle = (minutes: number, seconds = 0) =>
      evaluateMacros("{{idle_duration}}", {
        ...ctx,
        now,
        lastMessageAt: new Date(now.getTime() - (minutes * 60 + seconds) * 1000),
      });
    expect(idle(0, 10)).toBe("a few seconds");
    expect(idle(1)).toBe("a minute");
    expect(idle(3)).toBe("3 minutes");
    expect(idle(90)).toBe("an hour");
    expect(evaluateMacros("{{idle_duration}}", { ...ctx, now, lastMessageAt: null })).toBe(
      "just now",
    );
  });

  it("exposes the last message content", () => {
    expect(evaluateMacros("Last: {{lastMessage}}", { ...ctx, lastMessage: "goodbye" })).toBe(
      "Last: goodbye",
    );
  });

  it("removes comments and noop, expands newline", () => {
    expect(evaluateMacros("a{{// a hidden comment}}b", ctx)).toBe("ab");
    expect(evaluateMacros("x{{noop}}y", ctx)).toBe("xy");
    expect(evaluateMacros("line1{{newline}}line2", ctx)).toBe("line1\nline2");
  });

  it("collapses the newlines hugging {{trim}}", () => {
    expect(evaluateMacros("A\n\n{{trim}}\n\nB", ctx)).toBe("AB");
    expect(evaluateMacros("A\n{{trim}} B", ctx)).toBe("A B");
  });

  it("keeps unknown macros verbatim", () => {
    expect(evaluateMacros("{{original}} stays {{char}}", ctx)).toBe("{{original}} stays Seraphina");
  });

  describe("{{#has:<tag>}} presence conditionals", () => {
    /** A context whose resolved preset tag set is `tags`. */
    const withTags = (tags: string[]) => ({ ...ctx, definedTags: new Set(tags) });

    it("drops a block, contents and all, when the tag is not defined", () => {
      const text = "A {{#has:npc_voice}}quote the voice block{{/has}}B";
      expect(evaluateMacros(text, withTags([]))).toBe("A B");
    });

    it("keeps the contents when the tag is defined, still evaluating macros", () => {
      const text = "A {{#has:npc_voice}}ask {{char}}{{/has}} B";
      expect(evaluateMacros(text, withTags(["npc_voice"]))).toBe("A ask Seraphina B");
    });

    it("renders {{^has:<tag>}} only when the tag is absent", () => {
      const text = "{{#has:x}}on{{/has}}{{^has:x}}off{{/has}}";
      expect(evaluateMacros(text, withTags(["x"]))).toBe("on");
      expect(evaluateMacros(text, withTags([]))).toBe("off");
    });

    it("stays verbatim when the context carries no resolved tag set", () => {
      const text = "{{#has:x}}keep{{/has}}";
      expect(evaluateMacros(text, ctx)).toBe(text);
      expect(evaluateMacros("{{^has:x}}keep{{/has}}", ctx)).toBe("{{^has:x}}keep{{/has}}");
    });

    it("honors nesting", () => {
      const text = "{{#has:a}}1{{#has:b}}2{{/has}}3{{/has}}";
      expect(evaluateMacros(text, withTags(["a", "b"]))).toBe("123");
      expect(evaluateMacros(text, withTags(["a"]))).toBe("13");
      expect(evaluateMacros(text, withTags(["b"]))).toBe("");
    });

    it("leaves an unbalanced block verbatim instead of eating the prompt", () => {
      const text = "A {{#has:x}}dangling";
      expect(evaluateMacros(text, withTags([]))).toBe(text);
    });

    it("drops a stray closing token once the tag set is resolved", () => {
      expect(evaluateMacros("A{{/has}}B", withTags([]))).toBe("AB");
    });

    it("does not evaluate macros inside a dropped block (no side effects)", () => {
      // A variable set inside a block the model never receives must not be
      // written: the prompt the model sees and the prompt's side effects agree.
      const scoped = withTags([]);
      evaluateMacros("{{#has:x}}{{setvar::leak::1}}{{/has}}", scoped);
      expect(scoped.vars.get("global", null, "leak")).toBeNull();
    });

    it("is case-insensitive in the tag name", () => {
      expect(evaluateMacros("{{#HAS:NPC_Voice}}ok{{/has}}", withTags(["npc_voice"]))).toBe("ok");
    });
  });

  describe("extractDefinedTags", () => {
    it("counts only paired tags", () => {
      expect([...extractDefinedTags("<npc_voice>text</npc_voice>")]).toEqual(["npc_voice"]);
      // A bare mention is a reference, never a definition — this is what keeps
      // one block's citation of another from making it look enabled.
      expect([...extractDefinedTags("use <npc_voice> here")]).toEqual([]);
      expect([...extractDefinedTags("<open>only")]).toEqual([]);
    });

    it("ignores tags inside author comments", () => {
      expect([...extractDefinedTags("{{// <gone>x</gone>}}<kept>y</kept>")]).toEqual(["kept"]);
    });

    it("ignores self-closing tags", () => {
      expect([...extractDefinedTags("<br /> <p>x</p>")]).toEqual(["p"]);
    });

    it("lowercases names so tags match regardless of author casing", () => {
      expect([...extractDefinedTags("<Anti_Omniscient_NPCs>a</Anti_Omniscient_NPCs>")]).toEqual([
        "anti_omniscient_npcs",
      ]);
    });
  });

  describe("presetDefinedTags", () => {
    it("collects tags from enabled rows only", () => {
      const { definedTags } = presetDefinedTags([
        { enabled: true, content: "<on>a</on>" },
        { enabled: false, content: "<off>b</off>" },
        { enabled: true, content: "<also>c</also>" },
      ]);
      expect([...definedTags].sort()).toEqual(["also", "on"]);
    });

    it("returns an empty (resolved) set for a preset with no optional blocks", () => {
      // Not `undefined`: a resolved empty set is what collapses conditionals.
      expect(presetDefinedTags([]).definedTags.size).toBe(0);
    });
  });

  it("expands preset UI control values", () => {
    const uiCtx = { ...ctx, ui: { pov: "third person", empty: "" } };
    expect(evaluateMacros("Written in {{ui:pov}}.", uiCtx)).toBe("Written in third person.");
    // Case-insensitive name, like every other macro; the key is trimmed.
    expect(evaluateMacros("{{UI:pov}} / {{ui: pov }}", uiCtx)).toBe("third person / third person");
    // A key the preset does not define stays verbatim, like an unknown macro.
    expect(evaluateMacros("{{ui:missing}}", uiCtx)).toBe("{{ui:missing}}");
    // No control context at all → verbatim.
    expect(evaluateMacros("{{ui:pov}}", ctx)).toBe("{{ui:pov}}");
    // A blank key is not a lookup.
    expect(evaluateMacros("{{ui:}}", uiCtx)).toBe("{{ui:}}");
    // A resolved empty string IS a value — it must not fall back to verbatim.
    expect(evaluateMacros("[{{ui:empty}}]", uiCtx)).toBe("[]");
  });

  it("keeps inherited Object.prototype members out of {{ui:…}}", () => {
    // `ctx.ui` is a plain object literal, so a bare property read used to find
    // `Object.prototype` members and inject their source into the prompt. Only
    // an OWN key resolves; an inherited one stays verbatim like any unknown.
    const uiCtx = { ...ctx, ui: { pov: "third person" } };
    expect(evaluateMacros("{{ui:constructor}}", uiCtx)).toBe("{{ui:constructor}}");
    expect(evaluateMacros("{{ui:toString}}", uiCtx)).toBe("{{ui:toString}}");
    expect(evaluateMacros("{{ui:__proto__}}", uiCtx)).toBe("{{ui:__proto__}}");
    expect(evaluateMacros("{{ui:hasOwnProperty}}", uiCtx)).toBe("{{ui:hasOwnProperty}}");
  });

  it("resolves a control legitimately id'd like an Object member", () => {
    // `Object.hasOwn` (not a name ban) is what guards the lookup: an own key
    // named `constructor`/`toString` must still resolve when the preset
    // actually declares it.
    const uiCtx = {
      ...ctx,
      ui: { constructor: "own ctor", toString: "own ts", ["__proto__"]: "own proto" },
    };
    expect(evaluateMacros("{{ui:constructor}}", uiCtx)).toBe("own ctor");
    expect(evaluateMacros("{{ui:toString}}", uiCtx)).toBe("own ts");
    // A computed `__proto__` key is an OWN property (unlike literal syntax,
    // which would set the prototype instead of declaring the key).
    expect(evaluateMacros("{{ui:__proto__}}", uiCtx)).toBe("own proto");
  });

  it("picks a random item (rng-driven) and keeps picks stable", () => {
    const random = evaluateMacros("{{random:a,b,c}}", { ...ctx, rng: () => 0 });
    expect(random).toBe("a");
    const pickA = evaluateMacros("{{pick:alpha,beta}}", ctx);
    const pickB = evaluateMacros("{{pick:alpha,beta}}", ctx);
    expect(pickA).toBe(pickB);
    expect(["alpha", "beta"]).toContain(pickA);
    expect(evaluateMacros("{{pick::x::y}}", ctx)).toMatch(/^(x|y)$/);
  });

  it("splits random lists on commas with escaped commas", () => {
    expect(evaluateMacros("{{random:a\\,b,c}}", { ...ctx, rng: () => 0 })).toBe("a,b");
    expect(evaluateMacros("{{random:a\\,b,c}}", { ...ctx, rng: () => 0.99 })).toBe("c");
  });

  it("rolls dice in all supported shapes", () => {
    expect(evaluateMacros("{{roll:1d1}}", ctx)).toBe("1");
    expect(evaluateMacros("{{roll:3-3}}", ctx)).toBe("3");
    expect(evaluateMacros("{{roll:5}}", ctx)).toMatch(/^[1-5]$/);
    expect(evaluateMacros("{{roll:bogus}}", ctx)).toBe("");
    expect(evaluateMacros("{{roll}}", ctx)).toMatch(/^(?:[1-9]|1[0-9]|20)$/);
  });

  it("keeps a seeded {{roll}} stable for one target and varies across targets", () => {
    const first = evaluateMacros("{{roll:1d100}}", { ...ctx, rollSeed: 7 });
    expect(evaluateMacros("{{roll:1d100}}", { ...ctx, rollSeed: 7 })).toBe(first);
    // Different target positions must not collapse onto one value (sampling a
    // few seeds keeps the 1/100 collision chance negligible).
    const values = new Set(
      [1, 2, 3, 4, 5].map((seed) => evaluateMacros("{{roll:1d100}}", { ...ctx, rollSeed: seed })),
    );
    expect(values.size).toBeGreaterThan(1);
    // Without a seed, the legacy random path still applies.
    expect(evaluateMacros("{{roll:1d100}}", ctx)).toMatch(/^\d+$/);
  });

  it("writes and reads variables through the chat scope", () => {
    evaluateMacros("{{setvar::mood::happy}}", ctx);
    expect(ctx.vars.get("chat", "chat-1", "mood")).toBe("happy");
    expect(evaluateMacros("{{getvar::mood}} is {{getvar::mood}}", ctx)).toBe("happy is happy");
  });

  it("reads chat scope first, then falls back to global", () => {
    ctx.vars.set("global", null, "name", "global-name");
    expect(evaluateMacros("{{getvar::name}}", ctx)).toBe("global-name");
    ctx.vars.set("chat", "chat-1", "name", "chat-name");
    expect(evaluateMacros("{{getvar::name}}", ctx)).toBe("chat-name");
  });

  it("uses the global scope when no chatId is given", () => {
    const globalCtx = { ...ctx, chatId: undefined };
    evaluateMacros("{{setvar::who::someone}}", globalCtx);
    expect(globalCtx.vars.get("global", null, "who")).toBe("someone");
    expect(evaluateMacros("{{getvar::who}}", globalCtx)).toBe("someone");
  });

  it("returns empty string for unknown variables, or the provided default", () => {
    expect(evaluateMacros("[{{getvar::missing}}]", ctx)).toBe("[]");
    expect(evaluateMacros("{{getvar::missing::fallback}}", ctx)).toBe("fallback");
  });

  it("adds numerically or concatenates, and inc/dec return the new value", () => {
    evaluateMacros("{{setvar::count::5}}{{addvar::count::3}}", ctx);
    expect(evaluateMacros("{{getvar::count}}", ctx)).toBe("8");
    evaluateMacros("{{setvar::label::a}}{{addvar::label::b}}", ctx);
    expect(evaluateMacros("{{getvar::label}}", ctx)).toBe("ab");
    expect(evaluateMacros("{{incvar::count}}", ctx)).toBe("9");
    expect(evaluateMacros("{{decvar::count}}", ctx)).toBe("8");
    evaluateMacros("{{setvar::fresh::1}}{{incvar::fresh}}", ctx);
    expect(evaluateMacros("{{getvar::fresh}}", ctx)).toBe("2");
  });

  it("applies side effects sequentially within one string", () => {
    const out = evaluateMacros("{{setvar::x::1}}{{getvar::x}}-{{incvar::x}}-{{getvar::x}}", ctx);
    expect(out).toBe("1-2-2");
  });

  it("leaves plain text untouched (fast path)", () => {
    expect(evaluateMacros("no macros here", ctx)).toBe("no macros here");
    const nested = at(["{{char}}"], 0);
    expect(evaluateMacros(nested, ctx)).toBe("Seraphina");
  });
});
