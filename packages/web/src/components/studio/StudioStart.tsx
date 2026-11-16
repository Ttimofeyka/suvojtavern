/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { blobUrl } from "../../lib/api";
import type { CharacterListItem } from "../../lib/api-characters";
import { listCharacters } from "../../lib/api-characters";
import { cx } from "../../lib/cx";
import { riseVariants, staggerContainer, useAppMotion } from "../../lib/motion";
import { Drama, Feather, FileImage, Plus, Search, Users, WandSparkles } from "../ui/icons";
import Modal from "../ui/Modal";
import { Segmented } from "../ui/segmented";
import { Stagger, StaggerItem } from "../ui/stagger";

/** The resume banner's display data, built by the studio view. */
export interface StudioResumeInfo {
  name: string;
  detail: string;
}

interface StudioStartProps {
  resume: StudioResumeInfo | null;
  onResume: () => void;
  onDiscardResume: () => void;
  onBlank: () => void;
  /** Fetches the full card and enters the studio. Throws on failure. */
  onOpenCharacter: (character: CharacterListItem, mode: "edit" | "remix") => Promise<void>;
  /** Opens the editor with a seed concept field and AI marks available. */
  onSeed: () => void;
  /** Hides the AI entry points when generation is off in Settings. */
  aiEnabled: boolean;
}

type OpenMode = "edit" | "remix";

/** A square/circle avatar with the initial as its fallback. */
function StudioAvatar(props: {
  path: string | null;
  name: string;
  className?: string;
}): ReactElement {
  const url = blobUrl(props.path);
  if (url !== null) {
    return <img className={cx("studio-avatar-image", props.className)} src={url} alt="" />;
  }
  return (
    <span className={cx("studio-avatar-fallback", props.className)} aria-hidden="true">
      {props.name.trim().slice(0, 1) || "?"}
    </span>
  );
}

/** Recent-cast shelf plus the picker/seed entry points. */
export default function StudioStart(props: StudioStartProps) {
  const app = useAppMotion();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recent, setRecent] = useState<CharacterListItem[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentBusyId, setRecentBusyId] = useState<string | null>(null);
  const [recentOpenError, setRecentOpenError] = useState<string | null>(null);

  const loadRecent = useCallback((): (() => void) => {
    setRecentError(null);
    setRecent(null);
    let cancelled = false;
    listCharacters({ sort: "recent", limit: 6 })
      .then((page) => {
        if (!cancelled) {
          setRecent(page.items);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRecentError(err instanceof Error ? err.message : "Failed to load characters");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(loadRecent, [loadRecent]);

  const openRecent = (character: CharacterListItem): void => {
    if (recentBusyId !== null) {
      return;
    }
    setRecentBusyId(character.id);
    setRecentOpenError(null);
    props
      .onOpenCharacter(character, "edit")
      .catch((err: unknown) => {
        setRecentOpenError(err instanceof Error ? err.message : "Failed to open character");
      })
      .finally(() => setRecentBusyId(null));
  };

  return (
    <div className="studio-start">
      <motion.div
        className="studio-start-inner"
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: {
            transition: app.reduce
              ? {}
              : { staggerChildren: 0.06, delayChildren: 0.02, when: "beforeChildren" },
          },
        }}
      >
        <motion.header className="studio-hero" variants={riseVariants(app, 14)}>
          <p className="studio-hero-eyebrow">
            <span className="studio-hero-mark" aria-hidden="true">
              <WandSparkles size={15} />
            </span>
            Casting room
          </p>
          <h1 className="studio-hero-title">
            Character<span className="studio-hero-accent">Studio</span>
          </h1>
          <p className="studio-hero-desc">
            {props.aiEnabled
              ? "Build a card from a blank page, continue one you already have, or start from a premise. Every field is live, and you can mark any of them for the AI to write."
              : "Build a card from a blank page or continue one you already have. Every field is live in the card preview."}
          </p>
          <div className="studio-hero-chips">
            <span className="studio-chip">
              <Drama size={14} aria-hidden="true" />
              Full card fields
            </span>
            {props.aiEnabled && (
              <span className="studio-chip">
                <WandSparkles size={14} aria-hidden="true" />
                AI co-writer
              </span>
            )}
            <span className="studio-chip">
              <FileImage size={14} aria-hidden="true" />
              PNG &amp; JSON export
            </span>
          </div>
        </motion.header>

        {props.resume !== null && (
          <motion.div className="studio-resume" variants={riseVariants(app)}>
            <span className="studio-resume-icon" aria-hidden="true">
              <Drama size={18} />
            </span>
            <span className="studio-resume-main">
              <span className="studio-resume-title">Resume your draft</span>
              <span className="studio-resume-desc">
                {props.resume.name}
                <span className="studio-resume-detail"> · {props.resume.detail}</span>
              </span>
            </span>
            <span className="studio-resume-actions">
              <button type="button" className="btn btn-ghost" onClick={props.onDiscardResume}>
                Discard
              </button>
              <button type="button" className="btn btn-primary" onClick={props.onResume}>
                Continue
              </button>
            </span>
          </motion.div>
        )}

        <Stagger className="studio-start-grid">
          <StaggerItem>
            <button type="button" className="studio-start-tile" onClick={props.onBlank}>
              <span className="studio-tile-index tnum" aria-hidden="true">
                01
              </span>
              <span className="studio-tile-icon" aria-hidden="true">
                <Plus size={22} />
              </span>
              <span className="studio-tile-title">Blank canvas</span>
              <span className="studio-tile-desc">
                Start with a name and build the cast member one field at a time.
              </span>
              <span className="studio-tile-arrow" aria-hidden="true">
                Start blank
                <span>→</span>
              </span>
            </button>
          </StaggerItem>
          <StaggerItem>
            <button type="button" className="studio-start-tile" onClick={() => setPickerOpen(true)}>
              <span className="studio-tile-index tnum" aria-hidden="true">
                02
              </span>
              <span className="studio-tile-icon" aria-hidden="true">
                <Users size={22} />
              </span>
              <span className="studio-tile-title">Use a character</span>
              <span className="studio-tile-desc">
                Continue an existing card, or use one as a reference for a brand-new character.
              </span>
              <span className="studio-tile-arrow" aria-hidden="true">
                Open the cast
                <span>→</span>
              </span>
            </button>
          </StaggerItem>
          {props.aiEnabled && (
            <StaggerItem>
              <button type="button" className="studio-start-tile" onClick={props.onSeed}>
                <span className="studio-tile-index tnum" aria-hidden="true">
                  03
                </span>
                <span className="studio-tile-icon" aria-hidden="true">
                  <Feather size={22} />
                </span>
                <span className="studio-tile-title">Seed a concept</span>
                <span className="studio-tile-desc">
                  Start with a premise. Fill what you know, then mark any field for AI to write.
                </span>
                <span className="studio-tile-arrow" aria-hidden="true">
                  Open the seed
                  <span>→</span>
                </span>
              </button>
            </StaggerItem>
          )}
        </Stagger>

        <motion.section className="studio-recent" variants={riseVariants(app)}>
          <div className="studio-recent-head">
            <h2 className="studio-recent-title">Recent cast</h2>
            <span className="studio-recent-sub">Open a card in the studio</span>
          </div>
          {recentError !== null ? (
            <div className="error-banner" role="alert">
              <span>{recentError}</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  loadRecent();
                }}
              >
                Retry
              </button>
            </div>
          ) : recent === null ? (
            <div className="studio-recent-list" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((item) => (
                <span className="studio-recent-skeleton skeleton" key={item} />
              ))}
            </div>
          ) : recent.length > 0 ? (
            <>
              <motion.div
                className="studio-recent-list"
                variants={staggerContainer(app)}
                initial="hidden"
                animate="visible"
              >
                {recent.map((character) => (
                  <motion.button
                    type="button"
                    className="studio-recent-item"
                    key={character.id}
                    variants={riseVariants(app, 6)}
                    disabled={recentBusyId !== null}
                    onClick={() => openRecent(character)}
                  >
                    <span className="studio-recent-avatar">
                      <StudioAvatar path={character.avatar_path} name={character.name} />
                      {recentBusyId === character.id && (
                        <span className="studio-recent-busy" aria-hidden="true">
                          <span className="spinner" />
                        </span>
                      )}
                    </span>
                    <span className="studio-recent-name">{character.name}</span>
                  </motion.button>
                ))}
              </motion.div>
              {recentOpenError !== null && (
                <p className="field-error" role="alert">
                  {recentOpenError}
                </p>
              )}
            </>
          ) : (
            <p className="caption muted studio-recent-empty">
              No characters yet. The blank canvas is waiting.
            </p>
          )}
        </motion.section>
      </motion.div>

      <StudioPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onOpen={props.onOpenCharacter}
      />
    </div>
  );
}

/** Edit-in-place or remix-as-new, with search over the existing cast. */
function StudioPicker(props: {
  open: boolean;
  onClose: () => void;
  onOpen: (character: CharacterListItem, mode: OpenMode) => Promise<void>;
}): ReactElement | null {
  const [mode, setMode] = useState<OpenMode>("edit");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CharacterListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(props.open);

  // Reset the dialog on each open, during render, so a previous search or mode
  // cannot leak into the next launch for a frame.
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) {
      setMode("edit");
      setQuery("");
      setItems(null);
      setError(null);
      setBusyId(null);
    }
  }

  useEffect(() => {
    if (!props.open) {
      return;
    }
    let cancelled = false;
    setError(null);
    const timer = window.setTimeout(() => {
      listCharacters({ search: query.trim() || undefined, sort: "recent", limit: 50 })
        .then((page) => {
          if (!cancelled) {
            setItems(page.items);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to load characters");
          }
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.open, query]);

  if (!props.open) {
    return null;
  }

  const pick = (character: CharacterListItem): void => {
    if (busyId !== null) {
      return;
    }
    setBusyId(character.id);
    setError(null);
    props
      .onOpen(character, mode)
      .then(() => props.onClose())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to open character");
      })
      .finally(() => setBusyId(null));
  };

  return (
    <Modal title="Open a character" onClose={props.onClose}>
      <Segmented
        className="studio-picker-mode"
        options={[
          { value: "edit", label: "Edit this card" },
          { value: "remix", label: "Remix as new" },
        ]}
        value={mode}
        onChange={setMode}
        ariaLabel="How to use the selected character"
      />
      <p className="caption muted studio-picker-hint">
        {mode === "edit"
          ? "Saves straight back to the selected card."
          : "Seeds a new card with the selected card's fields. The original is untouched."}
      </p>

      <div className="search-field studio-picker-search">
        <span className="search-icon" aria-hidden="true">
          <Search size={16} />
        </span>
        <input
          className="input"
          type="search"
          placeholder="Search the cast…"
          aria-label="Search characters"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {error !== null && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {items === null ? (
        <div className="studio-picker-list" aria-hidden="true">
          {[0, 1, 2, 3].map((item) => (
            <div className="studio-picker-skeleton" key={item}>
              <span className="skeleton studio-picker-skeleton-avatar" />
              <span className="skeleton skeleton-line studio-picker-skeleton-line" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state studio-picker-empty">
          <span className="empty-state-icon" aria-hidden="true">
            <Drama size={30} />
          </span>
          <span className="empty-state-title">
            {query.trim() === "" ? "No characters yet" : `No results for “${query.trim()}”`}
          </span>
          <span className="empty-state-hint">
            {query.trim() === ""
              ? "Start from a blank canvas instead."
              : "Try a different name or clear the search."}
          </span>
        </div>
      ) : (
        <ul className="studio-picker-list">
          {items.map((character) => (
            <li key={character.id}>
              <button
                type="button"
                className="studio-picker-row"
                disabled={busyId !== null}
                onClick={() => pick(character)}
              >
                <span className="studio-picker-avatar">
                  <StudioAvatar path={character.avatar_path} name={character.name} />
                </span>
                <span className="studio-picker-main">
                  <span className="studio-picker-name">{character.name}</span>
                  <span className="studio-picker-meta tnum">
                    {character.tags.length > 0 ? character.tags.slice(0, 3).join(" · ") : "No tags"}
                    <span> · {character.chat_count} chats</span>
                  </span>
                </span>
                {busyId === character.id ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <span className="studio-picker-go" aria-hidden="true">
                    →
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
