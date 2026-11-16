/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { PromptMessageInfo } from "./api-generate";
import {
  EMPTY_CONTENT_PLACEHOLDER,
  FALLBACK_TONE,
  formatPromptText,
  pluginNotice,
  promptTotals,
  roleDisplay,
  summarizeBudget,
  summaryNotice,
  toMessageViews,
  usagePercent,
} from "./prompt-preview";

/** A message fixture; tokens default to 0 so each test states only what it reads. */
function message(overrides: Partial<PromptMessageInfo> = {}): PromptMessageInfo {
  return { role: "user", content: "hello", tokens: 5, ...overrides };
}

describe("roleDisplay", () => {
  it("maps the three known roles to labels and tone keys", () => {
    expect(roleDisplay("system")).toEqual({ label: "System", tone: "system" });
    expect(roleDisplay("user")).toEqual({ label: "User", tone: "user" });
    expect(roleDisplay("assistant")).toEqual({ label: "Assistant", tone: "assistant" });
  });

  it("falls back to the shared tone for an unknown role, keeping its name", () => {
    expect(roleDisplay("tool")).toEqual({ label: "tool", tone: FALLBACK_TONE });
  });

  it("labels an empty or whitespace role rather than rendering a blank row", () => {
    expect(roleDisplay("")).toEqual({ label: "Unknown", tone: FALLBACK_TONE });
    expect(roleDisplay("   ")).toEqual({ label: "Unknown", tone: FALLBACK_TONE });
  });
});

describe("usagePercent", () => {
  it("rounds used over context to a whole number", () => {
    expect(usagePercent(25, 100)).toBe(25);
    expect(usagePercent(1, 3)).toBe(33);
  });

  it("reports over 100 rather than capping when the prompt overflows", () => {
    expect(usagePercent(150, 100)).toBe(150);
  });

  it("is 0 for a missing or non-positive context", () => {
    expect(usagePercent(10, 0)).toBe(0);
    expect(usagePercent(10, -5)).toBe(0);
    expect(usagePercent(10, Number.NaN)).toBe(0);
  });

  it("treats a negative or non-finite used count as 0", () => {
    expect(usagePercent(-10, 100)).toBe(0);
    expect(usagePercent(Number.POSITIVE_INFINITY, 100)).toBe(0);
  });
});

describe("summarizeBudget", () => {
  it("formats the header line with grouped numbers and the share", () => {
    expect(summarizeBudget({ context: 8000, used: 2000, remaining: 6000 })).toEqual({
      used: 2000,
      context: 8000,
      remaining: 6000,
      percent: 25,
      line: "2,000 / 8,000 tokens · 25% used · 6,000 remaining",
    });
  });

  it("handles an empty budget without dividing by zero", () => {
    expect(summarizeBudget({ context: 0, used: 0, remaining: 0 })).toMatchObject({
      percent: 0,
      line: "0 / 0 tokens · 0% used · 0 remaining",
    });
  });

  it("keeps a negative remaining (overflow) as a signed count", () => {
    expect(summarizeBudget({ context: 100, used: 120, remaining: -20 }).line).toContain(
      "-20 remaining",
    );
  });
});

describe("promptTotals", () => {
  it("sums tokens and reports the count for a non-empty prompt", () => {
    const totals = promptTotals(
      [
        message({ role: "system", tokens: 10 }),
        message({ role: "user", tokens: 5 }),
        message({ role: "assistant", tokens: 20 }),
      ],
      100,
    );
    expect(totals.total).toBe(35);
    expect(totals.count).toBe(3);
    expect(totals.percent).toBe(35);
  });

  it("returns a zeroed summary for an empty prompt", () => {
    expect(promptTotals([], 100)).toEqual({
      total: 0,
      count: 0,
      byRole: [],
      percent: 0,
    });
  });

  it("breaks tokens down per role in first-seen order", () => {
    const totals = promptTotals(
      [
        message({ role: "user", tokens: 5 }),
        message({ role: "system", tokens: 10 }),
        message({ role: "user", tokens: 7 }),
      ],
      100,
    );
    expect(totals.byRole).toEqual([
      { role: "user", label: "User", tone: "user", tokens: 12 },
      { role: "system", label: "System", tone: "system", tokens: 10 },
    ]);
  });

  it("coerces malformed token counts to 0 instead of poisoning the total", () => {
    const totals = promptTotals(
      [message({ tokens: Number.NaN }), message({ tokens: -3 }), message({ tokens: 2.4 })],
      100,
    );
    expect(totals.total).toBe(2); // NaN→0, -3→0, 2.4→2
  });

  it("groups an unknown role under its own key without dropping its tokens", () => {
    const totals = promptTotals([message({ role: "tool", tokens: 4 })], 100);
    expect(totals.byRole).toEqual([
      { role: "tool", label: "tool", tone: FALLBACK_TONE, tokens: 4 },
    ]);
  });
});

describe("toMessageViews", () => {
  it("numbers messages from 1 and carries the role display through", () => {
    const views = toMessageViews(
      [message({ role: "system", tokens: 10 }), message({ role: "user", tokens: 5 })],
      100,
    );
    expect(views.map((view) => view.index)).toEqual([1, 2]);
    expect(views[0]).toMatchObject({ label: "System", tone: "system", share: 10 });
    expect(views[1]).toMatchObject({ label: "User", tone: "user", share: 5 });
  });

  it("returns an empty list for an empty prompt", () => {
    expect(toMessageViews([], 100)).toEqual([]);
  });

  it("normalizes a missing or blank name to null and trims a real one", () => {
    const views = toMessageViews(
      [message({ name: undefined }), message({ name: "   " }), message({ name: "  Aria  " })],
      100,
    );
    expect(views.map((view) => view.name)).toEqual([null, null, "Aria"]);
  });

  it("flags empty and whitespace-only content", () => {
    const views = toMessageViews(
      [message({ content: "" }), message({ content: "  \n " }), message({ content: "hi" })],
      100,
    );
    expect(views.map((view) => view.empty)).toEqual([true, true, false]);
    // The raw content is preserved for the text renderer.
    expect(views[1]?.content).toBe("  \n ");
  });

  it("shares each message's tokens against the context", () => {
    const views = toMessageViews([message({ tokens: 25 })], 200);
    expect(views[0]?.share).toBe(13); // round(12.5)
  });

  it("degrades a malformed payload's missing content to empty, not a throw", () => {
    // The endpoint is typed, but a bad payload must not crash the renderer.
    const malformed = [{ role: "user", tokens: 1 }] as unknown as PromptMessageInfo[];
    const views = toMessageViews(malformed, 100);
    expect(views[0]?.content).toBe("");
    expect(views[0]?.empty).toBe(true);
  });
});

describe("formatPromptText", () => {
  it("joins messages with a bracketed role header and a blank line between", () => {
    const text = formatPromptText([
      message({ role: "system", content: "You are helpful." }),
      message({ role: "user", content: "Hi" }),
    ]);
    expect(text).toBe("[System]\nYou are helpful.\n\n[User]\nHi");
  });

  it("includes the name in the header when one is present", () => {
    const text = formatPromptText([message({ role: "assistant", name: "Aria", content: "Hello" })]);
    expect(text).toBe("[Assistant: Aria]\nHello");
  });

  it("returns an empty string for an empty prompt", () => {
    expect(formatPromptText([])).toBe("");
  });

  it("keeps an empty message as a header over a blank body", () => {
    expect(formatPromptText([message({ role: "user", content: "" })])).toBe("[User]\n");
  });
});

describe("pluginNotice", () => {
  it("explains the rewrite when a plugin touched the prompt", () => {
    expect(pluginNotice(true)).toBe("A plugin rewrote this prompt before it was sent.");
  });

  it("is silent otherwise", () => {
    expect(pluginNotice(false)).toBeNull();
  });
});

describe("summaryNotice", () => {
  it("names the replaced seq range", () => {
    expect(summaryNotice({ seqFrom: 1, seqTo: 4, text: "…" })).toBe(
      "Messages 1–4 were replaced by the injected summary block.",
    );
  });

  it("is silent when no summary was injected", () => {
    expect(summaryNotice(null)).toBeNull();
    expect(summaryNotice(undefined)).toBeNull();
  });
});

describe("empty-content placeholder", () => {
  it("exposes a visible stand-in for a blank message", () => {
    expect(EMPTY_CONTENT_PLACEHOLDER).toBe("(empty)");
  });
});
