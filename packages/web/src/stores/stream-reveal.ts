/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom } from "jotai";
import {
  advanceReveal,
  type RevealState,
  revealStart,
  writingStyleSpec,
} from "../lib/writing-styles";
import { appStore } from "./store";
import { writingStyleAtom } from "./writing";

/**
 * The revealed prefix of the running reply — what the live surfaces paint.
 * Paced by the active writing style; under the default "instant" style it
 * always equals the raw stream text, so the default costs nothing.
 *
 * The server's raw text still lives in stores/chat.ts's chatStreamTextAtom
 * (the source of truth used for gating); this atom is the *paced* view the
 * live bubbles render. chat.ts drives the reveal (push/set/reset) and awaits
 * {@link revealCompletion} before it swaps the live bubble for the persisted
 * one, so the settled message never pops the un-typed remainder into view.
 */
export const streamRevealAtom = atom("");

// Target text received so far, the reveal cursor, and the rAF bookkeeping.
let target = "";
let state: RevealState = revealStart();
let frame = 0;
let lastTs = 0;
// Instant-style publishers are coalesced to one per frame. The network can
// deliver many SSE deltas in a single task; painting each one reparsed the
// whole reply and forced a scroll measurement every time, which is what made a
// burst feel like a stutter. One frame keeps the same visual result.
let instantFrame = 0;
// Callers of revealCompletion waiting for the reveal to catch up.
let waiters: (() => void)[] = [];

function isInstant(): boolean {
  return writingStyleSpec(appStore.get(writingStyleAtom)).charsPerSecond <= 0;
}

function publish(): void {
  appStore.set(streamRevealAtom, target.slice(0, state.visible));
}

/** Snap the reveal to the whole target (instant styles, resets, rewrites). */
function finish(): void {
  state = { progress: target.length, visible: target.length };
  publish();
}

function cancelInstant(): void {
  if (instantFrame !== 0) {
    cancelAnimationFrame(instantFrame);
    instantFrame = 0;
  }
}

function stop(): void {
  if (frame !== 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  lastTs = 0;
  if (waiters.length > 0) {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) {
      resolve();
    }
  }
}

function tick(ts: number): void {
  const spec = writingStyleSpec(appStore.get(writingStyleAtom));
  // The style may have flipped to "instant" mid-stream; land the rest at once.
  if (spec.charsPerSecond <= 0) {
    finish();
    stop();
    return;
  }
  // First frame has no previous stamp; a backgrounded tab can hand back a huge
  // delta, so cap it to keep one frame from dumping the whole buffer.
  const dt = lastTs === 0 ? 1 / 60 : Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  state = advanceReveal(spec, target, state, dt);
  publish();
  if (state.visible >= target.length) {
    stop();
    return;
  }
  frame = requestAnimationFrame(tick);
}

function ensureRunning(): void {
  if (frame !== 0) {
    return;
  }
  lastTs = 0;
  frame = requestAnimationFrame(tick);
}

/** Land everything received so far in the next frame, then resolve waiters. */
function flushInstant(): void {
  instantFrame = 0;
  finish();
  stop();
}

function scheduleInstant(): void {
  if (instantFrame !== 0) {
    return;
  }
  instantFrame = requestAnimationFrame(flushInstant);
}

/** Appends a streamed delta to the reveal target. */
export function pushStreamText(delta: string): void {
  if (delta === "") {
    return;
  }
  target += delta;
  if (isInstant()) {
    scheduleInstant();
    return;
  }
  ensureRunning();
}

/**
 * Reconciles the reveal target with the settled content (the done event's
 * `content`). A plugin's onResponse may have rewritten the reply after the
 * deltas streamed out; when the new text no longer extends what we revealed,
 * the smoothed prefix is meaningless and the reveal snaps to the new truth.
 */
export function setStreamText(text: string): void {
  if (!text.startsWith(target)) {
    target = text;
    cancelInstant();
    finish();
    stop();
    return;
  }
  target = text;
  if (target.length === 0) {
    cancelInstant();
    finish();
    stop();
    return;
  }
  if (isInstant()) {
    scheduleInstant();
    return;
  }
  ensureRunning();
}

/** Drops the reveal for a new run (or a closed chat). */
export function resetStreamText(): void {
  cancelInstant();
  target = "";
  state = revealStart();
  stop();
  publish();
}

/** Resolves once the reveal has painted every received character. */
export function revealCompletion(): Promise<void> {
  if (instantFrame === 0 && state.visible >= target.length) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}
