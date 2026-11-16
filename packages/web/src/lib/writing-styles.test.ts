/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  advanceReveal,
  DEFAULT_WRITING_STYLE,
  isWritingStyle,
  revealStart,
  WRITING_STYLES,
  type WritingStyle,
  writingStyleSpec,
} from "./writing-styles";

/** Drive a reveal at a fixed frame step until it finishes (or stalls). */
function revealAll(style: WritingStyle, target: string): ReturnType<typeof revealStart> {
  const spec = writingStyleSpec(style);
  let state = revealStart();
  for (let frame = 0; frame < 100_000 && state.visible < target.length; frame++) {
    state = advanceReveal(spec, target, state, 1 / 60);
  }
  return state;
}

describe("writing styles", () => {
  it("ships at least three styles, with the instant one as the default", () => {
    expect(WRITING_STYLES.length).toBeGreaterThanOrEqual(3);
    expect(WRITING_STYLES.map((spec) => spec.id)).toContain(DEFAULT_WRITING_STYLE);
    expect(writingStyleSpec(DEFAULT_WRITING_STYLE).charsPerSecond).toBe(0);
  });

  it("accepts only known style ids", () => {
    expect(isWritingStyle("instant")).toBe(true);
    expect(isWritingStyle("typewriter")).toBe(true);
    expect(isWritingStyle("nope")).toBe(false);
    expect(isWritingStyle(7)).toBe(false);
    expect(isWritingStyle(null)).toBe(false);
  });

  it("falls back to the default spec for an unknown id", () => {
    expect(writingStyleSpec("bogus" as WritingStyle).id).toBe(DEFAULT_WRITING_STYLE);
  });

  it("lands an instant style in a single step", () => {
    const state = advanceReveal(writingStyleSpec("instant"), "hello world", revealStart(), 1 / 60);
    expect(state).toEqual({ progress: 11, visible: 11 });
  });

  it("reveals smoothly and never overshoots the target", () => {
    const target = "the quick brown fox jumps over the lazy dog";
    const spec = writingStyleSpec("smooth");
    let state = revealStart();
    let previous = 0;
    for (let frame = 0; frame < 6; frame++) {
      state = advanceReveal(spec, target, state, 1 / 60);
      expect(state.visible).toBeGreaterThanOrEqual(previous);
      expect(state.visible).toBeLessThanOrEqual(target.length);
      previous = state.visible;
    }
    // Six frames at 60fps is a tenth of a second — mid-reveal, not done.
    expect(state.visible).toBeGreaterThan(0);
    expect(state.visible).toBeLessThan(target.length);
  });

  it("completes every paced style", () => {
    const target = "Every writing style must finish its reveal at the end.";
    for (const style of ["smooth", "typewriter", "flow"] as const) {
      const state = revealAll(style, target);
      expect(state.visible, style).toBe(target.length);
      expect(state.progress, style).toBe(target.length);
    }
  });

  it("keeps the typewriter granularity on whole words", () => {
    const target = "one two three four five six seven";
    const spec = writingStyleSpec("typewriter");
    let state = revealStart();
    for (let frame = 0; frame < 500 && state.visible < target.length; frame++) {
      const next = advanceReveal(spec, target, state, 1 / 60);
      if (next.visible > 0 && next.visible < target.length) {
        // A painted partial prefix always ends on a word boundary.
        expect(target[next.visible - 1], `visible=${next.visible}`).toBe(" ");
      }
      state = next;
    }
    expect(state.visible).toBe(target.length);
  });

  it("scales the rate up to bound the lag on a large burst", () => {
    const target = "x".repeat(2000);
    const spec = writingStyleSpec("flow");
    const state = advanceReveal(spec, target, revealStart(), 1 / 60);
    // Base rate alone would reveal ~2 chars in one 16ms frame; the catch-up
    // term (backlog / maxLagSeconds) must do far more.
    expect(state.progress).toBeGreaterThan(spec.charsPerSecond / 60 + 50);
    expect(state.progress).toBeLessThanOrEqual(target.length);
  });
});
