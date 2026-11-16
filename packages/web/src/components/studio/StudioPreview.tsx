/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { CSSProperties, PointerEvent } from "react";
import { useEffect, useRef } from "react";
import { cx } from "../../lib/cx";
import { useAppMotion } from "../../lib/motion";
import type { StudioDraft } from "../../lib/studio-draft";
import { auraFrom, draftStats } from "../../lib/studio-draft";
import { Presence } from "../ui/presence";

interface StudioPreviewProps {
  draft: StudioDraft;
  /** Object URL of a pending pick, or the saved avatar's served URL. */
  avatarUrl: string | null;
  /** "Editing Aria", "Remix of Aria", … — null for a blank draft. */
  sourceLabel: string | null;
  /** True when the draft matches the saved row. */
  saved: boolean;
}

/**
 * The live card: a portrait cover (uploaded image or a deterministic
 * theme-derived aura), the name, tags, a blurb, and the readiness stats. On
 * hover-capable pointers the card tilts a few degrees toward the cursor through
 * transform only; reduced motion and touch leave it flat.
 *
 * The aura is not a fixed palette: its angle, highlight position and accent
 * mix come from a hash of the name (then tags), and every colour is mixed from
 * the active theme's `--accent`, `--fg` and surface tokens. The same card
 * always looks the same, and every theme recolours it.
 */
export default function StudioPreview(props: StudioPreviewProps) {
  const app = useAppMotion();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const hoverRef = useRef<boolean | null>(null);

  // The tilt is a pointer affordance: touch scrolling must never rotate the
  // card, so the capability check is cached once instead of trusting every
  // pointermove.
  if (hoverRef.current === null && typeof window !== "undefined") {
    hoverRef.current = window.matchMedia("(hover: hover)").matches;
  }

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (app.reduce || hoverRef.current !== true) {
      return;
    }
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    const rect = card.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      card.dataset.tilting = "true";
      card.style.setProperty("--tilt-x", `${(-py * 5).toFixed(2)}deg`);
      card.style.setProperty("--tilt-y", `${(px * 7).toFixed(2)}deg`);
      card.style.setProperty("--glare-x", `${(px * 100 + 50).toFixed(1)}%`);
      card.style.setProperty("--glare-y", `${(py * 100 + 50).toFixed(1)}%`);
    });
  };

  const resetTilt = (): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    card.dataset.tilting = "false";
    card.style.setProperty("--tilt-x", "0deg");
    card.style.setProperty("--tilt-y", "0deg");
    card.style.setProperty("--glare-x", "50%");
    card.style.setProperty("--glare-y", "50%");
  };

  const aura = auraFrom(props.draft.name, props.draft.tags.join(" "));
  // A blank card should read as unnamed in the portrait and the cover alike;
  // the aura's own fallback word ("untitled") would render a misleading "U".
  const initial = props.draft.name.trim() === "" ? "?" : aura.initial;
  const stats = draftStats(props.draft);
  const visibleTags = props.draft.tags.slice(0, 6);
  const extraTags = props.draft.tags.length - visibleTags.length;
  const blurb = props.draft.scenario.trim() || props.draft.description.trim() || "No world yet.";
  const name = props.draft.name.trim() || "Untitled character";
  const auraStyle = {
    "--aura-angle": `${aura.angle}deg`,
    "--aura-x": `${aura.x}%`,
    "--aura-y": `${aura.y}%`,
    "--aura-mix-a": `${aura.mixA}%`,
    "--aura-mix-b": `${aura.mixB}%`,
  } as CSSProperties;

  return (
    <aside className="studio-preview" aria-label="Live card preview">
      <div className="studio-preview-head">
        <span className="studio-preview-live">
          <span className="studio-live-dot" aria-hidden="true" />
          Live preview
        </span>
        <span className="studio-preview-score tnum">{stats.percent}%</span>
      </div>

      <div className="studio-card-frame" onPointerMove={onPointerMove} onPointerLeave={resetTilt}>
        <div className="studio-card" ref={cardRef} style={auraStyle} data-tilting="false">
          <div className={cx("studio-card-cover", props.avatarUrl !== null && "has-photo")}>
            {props.avatarUrl !== null ? (
              <img className="studio-card-photo" src={props.avatarUrl} alt="" />
            ) : (
              <div className="studio-card-aura" aria-hidden="true">
                <Presence mode="wait">
                  <motion.span
                    key={initial}
                    className="studio-card-initial"
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    variants={{
                      hidden: { opacity: 0, scale: 0.86 },
                      visible: { opacity: 1, scale: 1 },
                      exit: { opacity: 0, scale: 0.94 },
                    }}
                    transition={app.reduce ? { duration: 0 } : app.transition}
                  >
                    {initial}
                  </motion.span>
                </Presence>
              </div>
            )}
            <span className="studio-card-glare" aria-hidden="true" />
            <span className={cx("studio-card-badge", props.saved && "is-saved")}>
              {props.saved ? "Saved" : "Draft"}
            </span>
          </div>

          <div className="studio-card-body">
            <h2 className="studio-card-name">{name}</h2>
            {props.sourceLabel !== null && (
              <p className="studio-card-source">{props.sourceLabel}</p>
            )}

            {visibleTags.length > 0 ? (
              <ul className="studio-card-tags" aria-label="Tags">
                {visibleTags.map((tag) => (
                  <li className="studio-card-tag" key={tag}>
                    {tag}
                  </li>
                ))}
                {extraTags > 0 && <li className="studio-card-tag is-more">+{extraTags}</li>}
              </ul>
            ) : (
              <p className="studio-card-empty">Add tags to set the mood.</p>
            )}

            <p className="studio-card-blurb">{blurb}</p>

            <div className="studio-card-stats">
              <span className="studio-card-stat">
                <strong className="tnum">{stats.words}</strong> words
              </span>
              <span className="studio-card-stat">
                <strong className="tnum">{stats.greetings}</strong> opening
                {stats.greetings === 1 ? "" : "s"}
              </span>
              <span className="studio-card-stat">
                <strong className="tnum">{stats.tags}</strong> tags
              </span>
            </div>

            <div className="studio-card-meter" aria-hidden="true">
              <motion.span
                className="studio-card-meter-fill"
                initial={false}
                animate={{ scaleX: stats.percent / 100 }}
                transition={app.reduce ? { duration: 0 } : app.spring.soft}
              />
            </div>
            <p className="studio-card-meter-label tnum">
              {stats.percent}% card ready
              <span>
                {stats.filledFields}/{stats.totalFields} fields
              </span>
            </p>
          </div>
        </div>
      </div>

      <p className="studio-preview-hint">
        Updates as you write. Save to unlock PNG and JSON export.
      </p>
    </aside>
  );
}
