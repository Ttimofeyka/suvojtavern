/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from "react";
import { useAppMotion } from "../../lib/motion";
import {
  advanceReveal,
  type RevealState,
  revealStart,
  type WritingStyle,
  writingStyleSpec,
} from "../../lib/writing-styles";

/**
 * The sample every preview types out. Kept to a single short line so each
 * style loops quickly and the cadences can be compared side by side.
 */
const SAMPLE = '"You came back," she says, and the firelight catches her smile.';

/** Pause at the end of a loop before it restarts, in ms. */
const LOOP_PAUSE_MS = 1200;

/**
 * Live preview of one writing style: the sample types itself out with the
 * style's pacing and caret, then pauses and loops. It runs its own rAF loop
 * (the Settings panel mounts only while open) and reuses the exact pacing math
 * the live stream does, so what you see is what a reply will do. Instant styles
 * have nothing to pace, and reduced motion must not loop, so both show the
 * finished line and leave the caret to its own animation.
 */
export default function WritingPreview({ style }: { style: WritingStyle }) {
  const app = useAppMotion();
  const spec = writingStyleSpec(style);
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    if (app.reduce || spec.charsPerSecond <= 0) {
      setVisible(SAMPLE.length);
      return;
    }
    let state: RevealState = revealStart();
    let frame = 0;
    let last = 0;
    let pauseUntil = 0;
    const tick = (ts: number) => {
      if (ts < pauseUntil) {
        frame = requestAnimationFrame(tick);
        return;
      }
      if (pauseUntil !== 0) {
        // Loop: clear the sample and start over from zero.
        pauseUntil = 0;
        last = 0;
        state = revealStart();
        setVisible(0);
      }
      const dt = last === 0 ? 1 / 60 : Math.min(0.1, (ts - last) / 1000);
      last = ts;
      state = advanceReveal(spec, SAMPLE, state, dt);
      setVisible(state.visible);
      if (state.visible >= SAMPLE.length) {
        pauseUntil = ts + LOOP_PAUSE_MS;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [spec, app.reduce]);

  return (
    <span className="writing-preview" aria-hidden="true">
      <span className="writing-preview-text">{SAMPLE.slice(0, visible)}</span>
      <span className="live-cursor" data-writing={style} />
    </span>
  );
}
