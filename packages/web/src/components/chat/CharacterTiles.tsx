/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useId } from "react";
import { blobUrl } from "../../lib/api";
import type { CharacterListItem } from "../../lib/api-characters";
import { INSTANT, useAppMotion } from "../../lib/motion";
import { LayoutGrid, List } from "../ui/icons";
import "../../styles/chat.css";

/** Placeholder tiles for the loading skeleton grid. */
const SKELETONS = Array.from({ length: 8 }, (_, i) => i);

/** Tile thumbnail: the avatar image, or the character's initial. */
export function TileAvatar(props: { path: string | null; name: string }) {
  const url = blobUrl(props.path);
  if (url !== null) {
    return <img className="new-chat-tile-image" src={url} alt="" loading="lazy" />;
  }
  return (
    <span className="new-chat-tile-fallback" aria-hidden="true">
      {props.name.slice(0, 1)}
    </span>
  );
}

/** Picker layout: `grid` keeps the original square tiles; `rows` is the compact
 *  default, sharing the Characters tab's `.char-row-*` geometry. */
export type CharacterLayout = "grid" | "rows";

export interface CharacterTilesProps {
  characters: CharacterListItem[];
  /** Fires when a tile/row is clicked; the caller owns what happens next. */
  onPick: (character: CharacterListItem) => void;
  /** Layout to render; defaults to the compact rows. */
  layout?: CharacterLayout;
}

/**
 * Character picker: a compact row list (`.new-chat-row`) or the original square
 * tile grid (`.new-chat-tile`). Shared by the new-chat modal and the welcome
 * wizard — both feed it a filtered list and decide what a pick does.
 */
export default function CharacterTiles(props: CharacterTilesProps) {
  const app = useAppMotion();
  const layout = props.layout ?? "rows";

  if (layout === "rows") {
    return (
      <div className="new-chat-list">
        {props.characters.map((character, index) => (
          // A keyed row mounts once per character, so a page append only
          // animates the new rows; the stagger is capped at 10 (see chat.css).
          // No hover transform: the compact rows get a CSS tint, not a lift.
          <motion.button
            type="button"
            className="new-chat-row"
            key={character.id}
            initial={app.reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              app.reduce ? INSTANT : { ...app.transition, delay: Math.min(index, 9) * 0.04 }
            }
            whileTap={app.reduce ? undefined : { scale: 0.97 }}
            onClick={() => props.onPick(character)}
          >
            <span className="char-row-avatar">
              <TileAvatar path={character.avatar_path} name={character.name} />
            </span>
            <span className="char-row-main">
              <span className="char-row-name">{character.name}</span>
              <span className="caption char-card-meta tnum">
                {character.chat_count} {character.chat_count === 1 ? "chat" : "chats"}
              </span>
            </span>
          </motion.button>
        ))}
      </div>
    );
  }

  return (
    <div className="new-chat-grid">
      {props.characters.map((character, index) => (
        // A keyed tile mounts once per character, so a page append only
        // animates the new rows; the stagger is capped at 10 (see chat.css).
        <motion.button
          type="button"
          className="new-chat-tile"
          key={character.id}
          initial={app.reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            app.reduce ? INSTANT : { ...app.transition, delay: Math.min(index, 9) * 0.04 }
          }
          // The hover lift lives in Motion (not CSS): once Motion writes an
          // inline transform, a stylesheet :hover transform can no longer win.
          whileHover={app.reduce ? undefined : { y: -1 }}
          whileTap={app.reduce ? undefined : { scale: 0.97 }}
          onClick={() => props.onPick(character)}
        >
          <span className="new-chat-tile-media">
            <TileAvatar path={character.avatar_path} name={character.name} />
          </span>
          <span className="new-chat-tile-body">
            <span className="new-chat-tile-name">{character.name}</span>
            <span className="caption new-chat-tile-meta tnum">
              {character.chat_count} {character.chat_count === 1 ? "chat" : "chats"}
            </span>
          </span>
        </motion.button>
      ))}
    </div>
  );
}

/** Loading skeleton matching {@link CharacterTiles} for the given layout. */
export function CharacterTilesSkeleton(props: { layout?: CharacterLayout }) {
  const layout = props.layout ?? "rows";

  if (layout === "rows") {
    return (
      <div className="new-chat-list" aria-hidden="true">
        {SKELETONS.map((skeleton) => (
          <div className="new-chat-skeleton-row" key={skeleton}>
            <div className="skeleton new-chat-skeleton-avatar" />
            <span className="skeleton sk-line" style={{ width: "45%" }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="new-chat-grid" aria-hidden="true">
      {SKELETONS.map((skeleton) => (
        <div className="new-chat-skeleton-tile" key={skeleton}>
          <div className="skeleton new-chat-skeleton-media" />
          <span className="skeleton sk-line" style={{ width: "72%" }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Grid/rows view toggle shared by the picker's call sites. Mirrors the
 * Characters tab toggle (views.css), but derives its indicator's `layoutId`
 * from `useId` so two mounted toggles can never share one sliding animation.
 */
export function CharacterViewToggle({
  value,
  onChange,
}: {
  value: CharacterLayout;
  onChange: (layout: CharacterLayout) => void;
}) {
  const app = useAppMotion();
  const layoutId = `char-view-${useId()}`;

  return (
    <fieldset className="view-toggle" aria-label="Characters view">
      <button
        type="button"
        className="btn btn-icon"
        aria-label="Grid view"
        aria-pressed={value === "grid"}
        data-tip="Grid view"
        onClick={() => onChange("grid")}
      >
        {/* The fill is a shared-layout indicator that slides between the two
            buttons; aria-pressed still carries the state, so the indicator is
            decoration (and snaps under reduced motion). */}
        {value === "grid" && (
          <motion.span
            className="view-toggle-indicator"
            layoutId={layoutId}
            aria-hidden="true"
            transition={app.reduce ? INSTANT : app.spring.snappy}
          />
        )}
        <LayoutGrid size={16} />
      </button>
      <button
        type="button"
        className="btn btn-icon"
        aria-label="Compact view"
        aria-pressed={value === "rows"}
        data-tip="Compact view"
        onClick={() => onChange("rows")}
      >
        {value === "rows" && (
          <motion.span
            className="view-toggle-indicator"
            layoutId={layoutId}
            aria-hidden="true"
            transition={app.reduce ? INSTANT : app.spring.snappy}
          />
        )}
        <List size={16} />
      </button>
    </fieldset>
  );
}
