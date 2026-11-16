/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  resolveSwipe,
  SWIPE_OFFSET_PX,
  SWIPE_VELOCITY_PX_S,
  type SwipeDirection,
  swipeFromTouch,
} from "./swipe-gesture";

const BOTH = { canNext: true, canPrevious: true };

describe("resolveSwipe", () => {
  it("returns null for a drag that is both too short and too slow", () => {
    expect(resolveSwipe(SWIPE_OFFSET_PX - 1, SWIPE_VELOCITY_PX_S - 1, BOTH)).toBeNull();
    expect(resolveSwipe(0, 0, BOTH)).toBeNull();
    expect(resolveSwipe(10, -100, BOTH)).toBeNull();
  });

  it("maps a far leftward drag to the next swipe", () => {
    expect(resolveSwipe(-SWIPE_OFFSET_PX, 0, BOTH)).toBe<SwipeDirection>("next");
    expect(resolveSwipe(-120, 0, BOTH)).toBe("next");
  });

  it("maps a far rightward drag to the previous swipe", () => {
    expect(resolveSwipe(SWIPE_OFFSET_PX, 0, BOTH)).toBe("previous");
    expect(resolveSwipe(120, 0, BOTH)).toBe("previous");
  });

  it("returns null for a next swipe when there is no next", () => {
    expect(resolveSwipe(-120, 0, { canNext: false, canPrevious: true })).toBeNull();
    expect(resolveSwipe(0, -600, { canNext: false, canPrevious: true })).toBeNull();
  });

  it("returns null for a previous swipe when there is no previous", () => {
    expect(resolveSwipe(120, 0, { canNext: true, canPrevious: false })).toBeNull();
    expect(resolveSwipe(0, 600, { canNext: true, canPrevious: false })).toBeNull();
  });

  it("decides a small-offset fast flick by the velocity sign", () => {
    // Tiny offset (below the distance threshold), so the velocity decides.
    expect(resolveSwipe(-4, -SWIPE_VELOCITY_PX_S, BOTH)).toBe("next");
    expect(resolveSwipe(4, SWIPE_VELOCITY_PX_S, BOTH)).toBe("previous");
  });

  it("prefers the offset sign over conflicting velocity once the drag is far", () => {
    // A long rightward drag with a misleading leftward velocity stays previous.
    expect(resolveSwipe(SWIPE_OFFSET_PX, -1000, BOTH)).toBe("previous");
    expect(resolveSwipe(-SWIPE_OFFSET_PX, 1000, BOTH)).toBe("next");
  });

  it("counts a drag exactly at the distance threshold", () => {
    expect(resolveSwipe(-SWIPE_OFFSET_PX, 0, BOTH)).toBe("next");
    expect(resolveSwipe(SWIPE_OFFSET_PX, 0, BOTH)).toBe("previous");
  });

  it("counts a flick exactly at the velocity threshold", () => {
    expect(resolveSwipe(0, -SWIPE_VELOCITY_PX_S, BOTH)).toBe("next");
    expect(resolveSwipe(0, SWIPE_VELOCITY_PX_S, BOTH)).toBe("previous");
  });
});

describe("swipeFromTouch", () => {
  const start = { x: 200, y: 100, t: 1000 };

  it("reads a leftward gesture as a negative offset", () => {
    expect(swipeFromTouch(start, { x: 140, y: 104, t: 1200 })).toEqual({
      offsetX: -60,
      velocityX: -300,
    });
  });

  it("reads a rightward gesture as a positive offset", () => {
    expect(swipeFromTouch(start, { x: 260, y: 96, t: 1200 })).toEqual({
      offsetX: 60,
      velocityX: 300,
    });
  });

  it("returns null for a mostly-vertical gesture", () => {
    expect(swipeFromTouch(start, { x: 205, y: 200, t: 1200 })).toBeNull();
    expect(swipeFromTouch(start, { x: 100, y: 300, t: 1200 })).toBeNull();
  });

  it("treats a pure vertical gesture as scrolling", () => {
    expect(swipeFromTouch(start, { x: 200, y: 40, t: 1200 })).toBeNull();
  });

  it("returns null without a positive duration", () => {
    expect(swipeFromTouch(start, { x: 140, y: 100, t: 1000 })).toBeNull();
    expect(swipeFromTouch(start, { x: 140, y: 100, t: 999 })).toBeNull();
  });

  it("keeps the velocity sign tied to the offset", () => {
    expect(swipeFromTouch(start, { x: 100, y: 100, t: 1500 })?.velocityX).toBeLessThan(0);
    expect(swipeFromTouch(start, { x: 300, y: 100, t: 1500 })?.velocityX).toBeGreaterThan(0);
  });

  it("scales the velocity by the elapsed time", () => {
    // 100px over 100ms is 1000px/s; the same distance over 500ms is 200px/s.
    expect(swipeFromTouch(start, { x: 100, y: 100, t: 1100 })?.velocityX).toBe(-1000);
    expect(swipeFromTouch(start, { x: 100, y: 100, t: 1500 })?.velocityX).toBe(-200);
  });
});
