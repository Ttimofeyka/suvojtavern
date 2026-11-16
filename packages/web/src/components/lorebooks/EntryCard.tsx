/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement } from "react";
import type { LorebookEntry } from "../../lib/api-lorebooks";
import { cx } from "../../lib/cx";
import type { AppMotion } from "../../lib/motion";
import { INSTANT, scaleVariants, useAppMotion } from "../../lib/motion";
import { Check, ChevronDown, ChevronUp, Info, Trash2, X } from "../ui/icons";
import { Presence } from "../ui/presence";

interface EntryCardProps {
  entry: LorebookEntry;
  /** Fired when the card's label/keys area is clicked (opens the entry editor). */
  onOpen: (entry: LorebookEntry) => void;
  /** Quick enable/disable straight from the card. */
  onToggle: (entry: LorebookEntry) => void;
  onDelete: (entry: LorebookEntry) => void;
  onMoveUp: (entry: LorebookEntry) => void;
  onMoveDown: (entry: LorebookEntry) => void;
  /** False at the top of the entry's container — the up button disables. */
  canMoveUp: boolean;
  /** False at the bottom of the entry's container — the down button disables. */
  canMoveDown: boolean;
  /** Position within the rendered page. Kept in the contract (the parent still
   *  passes it); the staggered entrance now runs through Stagger/StaggerItem,
   *  so the card no longer needs it for a CSS delay. */
  index: number;
}

/** Key badges shown on a card before the remainder fold into a "+N" chip.
 *  Capping the row keeps every card the same height (see .entry-card). */
const MAX_KEY_BADGES = 3;

const TOGGLE_TIP =
  "Toggles this entry's own Enabled flag — a disabled entry stays saved but never activates.";
const META_TIP =
  "pos = injection position, depth = messages back for at-depth entries, order = priority, prob = activation chance.";

/** Short label for an entry card: comment, else first key, else content head. */
const entryLabel = (entry: LorebookEntry): string => {
  const comment = (entry.comment ?? "").trim();
  if (comment !== "") {
    return comment;
  }
  return entry.keys[0] ?? entry.content.slice(0, 40);
};

interface StateFlag {
  key: string;
  label: string;
  tone: "on" | "off" | "legacy";
}

/**
 * The entry's generation state as badges. Enabled is always present (an
 * explicit "Disabled" reads better than an absent chip), and the activation
 * flags follow only when set, so a default keyword entry stays quiet.
 */
function stateFlags(entry: LorebookEntry): StateFlag[] {
  const flags: StateFlag[] = [
    entry.enabled
      ? { key: "enabled", label: "Enabled", tone: "on" }
      : { key: "enabled", label: "Disabled", tone: "off" },
  ];
  if (entry.constant) {
    flags.push({ key: "constant", label: "Constant", tone: "on" });
  }
  if (entry.selective) {
    flags.push({ key: "selective", label: "Selective", tone: "on" });
  }
  if (entry.vectorized) {
    flags.push({ key: "vectorized", label: "Vectorized", tone: "legacy" });
  }
  return flags;
}

/** One animated state chip; Presence sequences its add/remove. */
function StateChip(props: { flag: StateFlag; app: AppMotion }): ReactElement {
  return (
    <motion.span
      layout
      className={cx("entry-state", `entry-state-${props.flag.tone}`)}
      variants={scaleVariants(props.app, 0.9)}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={props.app.reduce ? INSTANT : props.app.spring.snappy}
    >
      {props.flag.label}
    </motion.span>
  );
}

/**
 * One lorebook entry card: the label + key badges that open the editor, the
 * enable toggle, reorder buttons and the delete button, plus the state badges
 * and a one-line meta summary. Extracted from the editor so a card can be
 * rendered inside a section block without duplicating the accessibility wiring.
 */
export default function EntryCard(props: EntryCardProps): ReactElement {
  const { entry } = props;
  const app = useAppMotion();
  const flags = stateFlags(entry);
  const keys = entry.keys;

  return (
    <article className={cx("entry-card", !entry.enabled && "entry-card-disabled")}>
      <div className="entry-card-head">
        {/* One accessible name for the whole card button: the label plus EVERY
            key, so the keys hidden behind the "+N" chip (a non-focusable span —
            it cannot be its own button nested inside this one) are still
            announced. */}
        <button
          type="button"
          className="entry-card-open"
          aria-label={
            keys.length === 0
              ? entryLabel(entry)
              : `${entryLabel(entry)} — keys: ${keys.join(", ")}`
          }
          onClick={() => props.onOpen(entry)}
        >
          <span className="entry-label">{entryLabel(entry)}</span>
          {keys.length > 0 && (
            <span className="entry-keys">
              {keys.slice(0, MAX_KEY_BADGES).map((key, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the badge text is the identity; the index only disambiguates a repeated key within this one card's row.
                <span className="badge" key={`${key}-${index}`}>
                  {key}
                </span>
              ))}
              {keys.length > MAX_KEY_BADGES && (
                // Hover lists the hidden keys; the card's aria-label above is
                // the AT-visible twin.
                <span
                  className="badge entry-key-more"
                  data-tip={keys.slice(MAX_KEY_BADGES).join(", ")}
                >
                  +{keys.length - MAX_KEY_BADGES}
                </span>
              )}
            </span>
          )}
        </button>
        <div className="entry-card-tools">
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Move entry up"
            data-tip="Move up"
            disabled={!props.canMoveUp}
            onClick={() => props.onMoveUp(entry)}
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Move entry down"
            data-tip="Move down"
            disabled={!props.canMoveDown}
            onClick={() => props.onMoveDown(entry)}
          >
            <ChevronDown size={16} />
          </button>
          <button type="button" className="info-tip" aria-label={TOGGLE_TIP} data-tip={TOGGLE_TIP}>
            <Info size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="toggle-chip"
            aria-pressed={entry.enabled}
            aria-label={entry.enabled ? "Disable entry" : "Enable entry"}
            data-tip={entry.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
            onClick={() => props.onToggle(entry)}
          >
            {entry.enabled ? <Check size={14} /> : <X size={14} />}
          </button>
          <button
            type="button"
            className="btn btn-icon btn-danger"
            aria-label="Delete entry"
            data-tip="Delete"
            onClick={() => props.onDelete(entry)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="entry-card-state">
        <Presence>
          {flags.map((flag) => (
            <StateChip flag={flag} key={flag.key} app={app} />
          ))}
        </Presence>
      </div>

      {/* Hovering the summary text itself shows the abbreviation key; the Info
          button beside it is the focusable twin that carries the same text to
          keyboard/AT users. */}
      <div className="entry-meta-row">
        <span className="entry-meta tnum" data-tip={META_TIP}>
          <span>pos {entry.position}</span>
          <span>depth {entry.depth}</span>
          <span>order {entry.order}</span>
          <span>prob {entry.probability}%</span>
        </span>
        <button type="button" className="info-tip" aria-label={META_TIP} data-tip={META_TIP}>
          <Info size={13} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
