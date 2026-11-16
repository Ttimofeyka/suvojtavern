/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { blobUrl } from "../../lib/api";
import type { CharacterLorebook, Lorebook } from "../../lib/api-lorebooks";
import {
  listCharacterLorebooks,
  listLorebooks,
  setCharacterLorebookEnabled,
} from "../../lib/api-lorebooks";
import type { Persona } from "../../lib/api-personas";
import { listPersonas } from "../../lib/api-personas";
import { riseVariants, scaleVariants, useAppMotion } from "../../lib/motion";
import { useIsMobile } from "../../lib/use-viewport";
import {
  budgetAtom,
  chatActions,
  chatErrorAtom,
  chatIdAtom,
  chatsAtom,
  personaAvatarPathAtom,
  personaNameAtom,
} from "../../stores/chat";
import { useLayout } from "../../stores/layout";
import { useMobileChats } from "../../stores/mobile-chats";
import GalleryManager from "../characters/GalleryManager";
import MobileNavButton from "../MobileNavButton";
import { AppLink } from "../ui/AppLink";
import {
  BookOpen,
  ChevronDown,
  Database,
  Image,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  TriangleAlert,
  User,
} from "../ui/icons";
import { Presence } from "../ui/presence";
import ChatDrawer from "./ChatDrawer";
import PromptPreview from "./PromptPreview";
import StreamingStatusPill from "./StreamingStatusPill";
import SummarizingStatusPill from "./SummarizingStatusPill";
import TrackerStatusPill from "./TrackerStatusPill";
// Self-contained so the picker's chrome ships wherever the header mounts.
import "../../styles/chrome.css";

/** Top bar of the open chat: live status, persona, budget, and the
 *  drawer (tracker/summaries/plugin tabs) + chats-pane toggles. */
export default function ChatHeader() {
  // Granular chat reads: the header is on the streaming path, so it must not
  // subscribe to the per-token stream slices through `useChatStore()` — it
  // reads only the slices it renders (status, budget, persona, error) and
  // fires actions through the non-subscribing `chatActions` surface.
  const chatId = useAtomValue(chatIdAtom);
  const chats = useAtomValue(chatsAtom);
  const budget = useAtomValue(budgetAtom);
  const chatError = useAtomValue(chatErrorAtom);
  const personaName = useAtomValue(personaNameAtom);
  const personaAvatarPath = useAtomValue(personaAvatarPathAtom);
  const app = useAppMotion();
  // Reactive phone-breakpoint flag: the cross-breakpoint branches below must
  // re-render when a rotation/resize crosses 760px, so they read this instead
  // of reading the breakpoint helper directly at render time.
  const isMobile = useIsMobile();
  // One guarded press scale shared by every icon control in the header.
  const tap = app.reduce ? undefined : { scale: 0.92 };

  const { layout, toggleChatsPane } = useLayout();
  // Compact status group applies at phone widths only: on desktop the row has
  // room for the text pills, so the setting is deliberately inert there.
  const compactStatus = isMobile && layout.compactStatus;
  const { chatsOpen, toggleChats } = useMobileChats();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerClosing, setDrawerClosing] = useState(false);
  // Mirrors drawerClosing for the timeout fallback below. React captures
  // state per render, so the timer would otherwise call a finishDrawerClose
  // closed over the pre-close `false` and bail out; Solid's signal read was
  // always current. The ref keeps the fallback reading the live flag.
  const drawerClosingRef = useRef(false);
  // The prompt inspector (the budget pill's dialog). Keyed on the chat id so
  // switching chats mid-inspection remounts it against the new prompt rather
  // than leaving the previous chat's assembly on screen.
  const [previewOpen, setPreviewOpen] = useState(false);
  // The character's gallery modal, opened from the header shortcut (stays
  // closed unless the open chat has a character to scope it to).
  const [galleryOpen, setGalleryOpen] = useState(false);

  /** Ends the exit — unmounts the drawer. Idempotent. */
  const finishDrawerClose = (): void => {
    if (!drawerClosingRef.current) {
      return;
    }
    drawerClosingRef.current = false;
    setDrawerOpen(false);
    setDrawerClosing(false);
  };

  /** Starts the drawer's exit; the drawer unmounts when it finishes. */
  const requestDrawerClose = (): void => {
    if (!drawerOpen || drawerClosingRef.current) {
      return;
    }
    drawerClosingRef.current = true;
    setDrawerClosing(true);
    // Fallback when the exit's completion never fires (reduced-motion kill,
    // background tabs): the drawer's panel-duration exit plus a little slack.
    // The normal path is `onExitComplete`, which is idempotent.
    window.setTimeout(finishDrawerClose, Math.round((app.duration.panel + 0.25) * 1000));
  };

  const toggleDrawer = (): void => {
    if (drawerOpen) {
      requestDrawerClose();
    } else {
      setDrawerOpen(true);
    }
  };
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRoot = useRef<HTMLDivElement | null>(null);
  // The persona listbox moves DOM focus to the menu on open (the ARIA listbox
  // pattern), tracks the highlighted option via aria-activedescendant, and
  // returns focus to the trigger on close.
  const personaMenuRef = useRef<HTMLDivElement | null>(null);
  const personaTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [personaActive, setPersonaActive] = useState(0);
  // --- lorebook picker (persona picker's pattern) ---
  const [loreOpen, setLoreOpen] = useState(false);
  const loreRoot = useRef<HTMLDivElement | null>(null);
  /** The character's attached books (with link state); null until loaded. */
  const [charBooks, setCharBooks] = useState<CharacterLorebook[] | null>(null);
  /** Every globally-enabled book (list endpoint's `global` flag). */
  const [globalBooks, setGlobalBooks] = useState<Lorebook[]>([]);
  const [loreError, setLoreError] = useState<string | null>(null);

  // The open chat's row; the contract exposes no chat object, so look it up
  // in the chat list the store keeps.
  const chat = chats.find((row) => row.id === chatId) ?? null;
  const characterName = chat?.character_name ?? "Chat";
  const budgetText = (() => {
    if (budget === null) {
      return null;
    }
    return `${budget.used.toLocaleString()} / ${budget.context.toLocaleString()} tokens`;
  })();

  // Persona picker list (NewChatModal's pattern — loaded on mount, a failed
  // load just reads as "no personas yet"). The picker itself reflects the
  // open chat's persona_id from the chat row, not this list.
  const personaId = chat?.persona_id ?? null;
  const currentPersona = personas?.find((row) => row.id === personaId) ?? null;
  /** Listbox option ids in DOM order: the "" (None) entry, then each persona. */
  const personaIds = ["", ...(personas ?? []).map((row) => row.id)];
  /** The option the menu highlights first (the chat's current persona). */
  const selectedPersonaIndex = Math.max(
    0,
    personaIds.findIndex((id) => id === (personaId ?? "")),
  );

  /** The trigger's label: the bound persona's name; a persona-less chat has
   *  no resolved persona (the store reads only the chat row), so it shows the
   *  generic "None". The "Persona" branch covers the anomalous case of a
   *  persona_id set on the row but absent from the loaded list. */
  const personaLabel =
    currentPersona?.name ?? personaName ?? (personaId === null ? "None" : "Persona");

  /** The trigger's avatar: the bound persona's image when the list has it;
   *  otherwise whatever the store resolved (null for a persona-less chat, so
   *  the trigger falls back to its initial). */
  const personaAvatar = currentPersona?.avatar_path ?? personaAvatarPath;

  /** Applies the picked persona ("" = none) and closes the menu; the store
   *  persists the change and re-resolves the persona info. Focus returns to the
   *  trigger so the keyboard path survives the menu unmounting. */
  const choosePersona = (id: string): void => {
    setPickerOpen(false);
    personaTriggerRef.current?.focus();
    void chatActions.setChatPersona(id === "" ? null : id);
  };

  // Move focus into the listbox when it opens, parked on the current persona —
  // arrow keys then drive aria-activedescendant without further tab stops.
  useEffect(() => {
    if (pickerOpen) {
      setPersonaActive(selectedPersonaIndex);
      personaMenuRef.current?.focus();
    }
  }, [pickerOpen, selectedPersonaIndex]);

  /** Listbox keyboard model: Up/Down (and Home/End) move the active option,
   *  Enter/Space picks it, Escape closes and restores focus to the trigger. */
  const onPersonaKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setPickerOpen(false);
      personaTriggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPersonaActive((index) => (index + 1) % personaIds.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setPersonaActive((index) => (index - 1 + personaIds.length) % personaIds.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setPersonaActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setPersonaActive(personaIds.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const id = personaIds[personaActive];
      if (id !== undefined) {
        choosePersona(id);
      }
    }
  };

  // Persona list load (the Solid `onMount`).
  useEffect(() => {
    listPersonas()
      .then((items) => setPersonas(items))
      .catch(() => setPersonas([]));
  }, []);

  // Click-away closes the open menu: one document-level pointerdown listener
  // that only ever acts while a menu is open, and the trigger's own clicks
  // stay inside the picker root. Re-registered with the open flags so the
  // handler never reads a stale state — the listener's lifetime is otherwise
  // the header's.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (pickerOpen && pickerRoot.current && !pickerRoot.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
      if (loreOpen && loreRoot.current && !loreRoot.current.contains(event.target as Node)) {
        setLoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen, loreOpen]);

  // --- lorebook picker -----------------------------------------------------------------

  /** Globals not already attached to this character — the attached list
   *  shows those once, with their link toggle. */
  const globalOnly: Lorebook[] = (() => {
    const attached = new Set((charBooks ?? []).map((book) => book.id));
    return globalBooks.filter((book) => !attached.has(book.id));
  })();

  const isGlobal = (id: string): boolean => globalBooks.some((book) => book.id === id);

  /** Loads the character's links and the global books — run on every open so
   *  attachments made elsewhere (character editor) show up immediately. */
  const refreshLorebooks = (): void => {
    const characterId = chat?.character_id;
    if (!characterId) {
      return;
    }
    Promise.all([listCharacterLorebooks(characterId), listLorebooks()])
      .then(([attached, all]) => {
        setCharBooks(attached);
        setGlobalBooks(all.filter((book) => book.global));
        setLoreError(null);
      })
      .catch(() => setLoreError("Failed to load lorebooks"));
  };

  const toggleLoreOpen = (): void => {
    const next = !loreOpen;
    setLoreOpen(next);
    if (next) {
      refreshLorebooks();
    }
  };

  /** Optimistically flips the link; reverts with a message on failure. */
  const toggleBook = (book: CharacterLorebook, enabled: boolean): void => {
    const characterId = chat?.character_id;
    if (!characterId) {
      return;
    }
    const flip = (value: boolean): void => {
      setCharBooks(
        (current) =>
          current?.map((row) => (row.id === book.id ? { ...row, enabled: value } : row)) ?? null,
      );
    };
    flip(enabled);
    setCharacterLorebookEnabled(characterId, book.id, enabled).catch(() => {
      flip(!enabled);
      setLoreError(`Failed to ${enabled ? "enable" : "disable"} "${book.name}"`);
    });
  };

  /** The toggle's pressed state per the cross-breakpoint contract: the mobile
   *  slide-over's visibility at phone widths, the persisted desktop column
   *  collapse otherwise. */
  const chatsTogglePressed = (): boolean => (isMobile ? chatsOpen : layout.chatsPaneHidden);

  /** Whether the history list is currently hidden/collapsed — drives the
   *  toggle's label and icon; the mobile slide-over's closed state at phone
   *  widths, the persisted desktop column collapse otherwise. */
  const chatsCollapsed = (): boolean => (isMobile ? !chatsOpen : layout.chatsPaneHidden);

  // Chats.tsx mounts this header only while a chat is open (it swaps in the
  // no-chat empty state otherwise), so there is no "no chat selected" surface
  // to render here — this is purely a type guard that keeps chatId narrowed to
  // string for the drawer and prompt-preview props below.
  if (chatId === null) {
    return null;
  }

  const personaAvatarUrl = blobUrl(personaAvatar);

  return (
    <header className="chat-header">
      <div className="chat-header-row">
        <MobileNavButton />
        {/* Persona picker: the chat's own persona (none when unset) with a
            dropdown to change or clear it. Nothing while the list loads;
            with none defined, a hint links to the Personas view instead. */}
        {personas !== null ? (
          personas.length > 0 ? (
            <div className="persona-picker" ref={pickerRoot}>
              <motion.button
                type="button"
                className="persona-trigger"
                ref={personaTriggerRef}
                data-tip="Chat persona"
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-label={`Chat persona: ${personaLabel}`}
                whileTap={tap}
                onClick={() => {
                  const next = !pickerOpen;
                  setPickerOpen(next);
                  if (next) {
                    setPersonaActive(selectedPersonaIndex);
                  }
                }}
              >
                <span className="persona-avatar" aria-hidden="true">
                  {personaAvatarUrl ? (
                    <img className="avatar-image" src={personaAvatarUrl} alt="" />
                  ) : (
                    personaLabel.charAt(0).toUpperCase()
                  )}
                </span>
                <span className="persona-trigger-name">{personaLabel}</span>
                <ChevronDown size={12} />
              </motion.button>
              <Presence>
                {pickerOpen ? (
                  <motion.div
                    key="persona-menu"
                    className="persona-menu"
                    role="listbox"
                    aria-label="Chat persona"
                    ref={personaMenuRef}
                    tabIndex={-1}
                    aria-activedescendant={`persona-option-${personaActive}`}
                    onKeyDown={onPersonaKeyDown}
                    variants={scaleVariants(app)}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <button
                      type="button"
                      className={
                        personaActive === 0 ? "persona-option is-active" : "persona-option"
                      }
                      id="persona-option-0"
                      role="option"
                      tabIndex={-1}
                      aria-selected={personaId === null}
                      onClick={() => choosePersona("")}
                    >
                      <span className="persona-avatar" aria-hidden="true">
                        <User size={12} />
                      </span>
                      None
                    </button>
                    {personas.map((persona, index) => {
                      const url = blobUrl(persona.avatar_path);
                      return (
                        <button
                          key={persona.id}
                          type="button"
                          className={
                            personaActive === index + 1
                              ? "persona-option is-active"
                              : "persona-option"
                          }
                          id={`persona-option-${index + 1}`}
                          role="option"
                          tabIndex={-1}
                          aria-selected={persona.id === personaId}
                          onClick={() => choosePersona(persona.id)}
                        >
                          <span className="persona-avatar" aria-hidden="true">
                            {url ? (
                              <img className="avatar-image" src={url} alt="" />
                            ) : (
                              persona.name.charAt(0).toUpperCase()
                            )}
                          </span>
                          <span className="persona-option-name">{persona.name}</span>
                        </button>
                      );
                    })}
                  </motion.div>
                ) : null}
              </Presence>
            </div>
          ) : (
            <span className="persona-hint caption">
              No personas yet — <AppLink to="/personas">create one</AppLink> to speak as yourself.
            </span>
          )
        ) : null}
        {/* Header icon stack: the optional lorebook picker and gallery
            trigger. Either one may be hidden by its layout setting. On
            desktop `display: contents` makes the wrapper vanish, so the
            visible controls stay inline exactly as before; on phones it is
            a horizontal group, never a column — a vertical stack is taller
            than the other header controls and grows the header. */}
        <div className="header-icon-stack">
          {/* Lorebook picker: the character's attached books with per-link
            toggles, plus the global books (managed in Settings). Same
            click-away pattern and visual language as the persona picker. */}
          {layout.elements.lorebooks ? (
            <div className="lorebook-picker" ref={loreRoot}>
              <motion.button
                type="button"
                className="persona-trigger lorebook-trigger"
                data-tip="Chat lorebooks"
                aria-haspopup="true"
                aria-expanded={loreOpen}
                aria-label="Chat lorebooks"
                whileTap={tap}
                onClick={toggleLoreOpen}
              >
                <BookOpen size={14} />
              </motion.button>
              <Presence>
                {loreOpen ? (
                  <motion.div
                    key="lorebook-menu"
                    className="lorebook-menu"
                    variants={scaleVariants(app)}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    {loreError !== null ? (
                      <p className="lorebook-menu-error" role="alert">
                        {loreError}
                      </p>
                    ) : null}
                    {charBooks !== null ? (
                      <>
                        <p className="lorebook-menu-heading">Character lorebooks</p>
                        {charBooks.length > 0 ? (
                          charBooks.map((book) => (
                            <label
                              key={book.id}
                              className="lorebook-row"
                              htmlFor={`chat-lore-${book.id}`}
                            >
                              <span className="lorebook-row-main">
                                <span className="lorebook-row-name">{book.name}</span>
                                {isGlobal(book.id) ? <span className="pill">Global</span> : null}
                              </span>
                              <span className="switch">
                                <input
                                  id={`chat-lore-${book.id}`}
                                  type="checkbox"
                                  className="switch-input"
                                  checked={book.enabled}
                                  onChange={(event) =>
                                    toggleBook(book, event.currentTarget.checked)
                                  }
                                />
                                <span className="switch-track">
                                  <span className="switch-thumb" />
                                </span>
                              </span>
                            </label>
                          ))
                        ) : (
                          <p className="lorebook-menu-empty">
                            None attached — link some in the{" "}
                            <AppLink to="/characters">character editor</AppLink> or browse{" "}
                            <AppLink to="/lorebooks">Lorebooks</AppLink>.
                          </p>
                        )}
                        {globalOnly.length > 0 ? (
                          <>
                            <p className="lorebook-menu-heading">Global</p>
                            {globalOnly.map((book) => (
                              <div key={book.id} className="lorebook-row lorebook-row-static">
                                <span className="lorebook-row-main">
                                  <span className="lorebook-row-name">{book.name}</span>
                                  <span className="pill">Global</span>
                                </span>
                                <span className="lorebook-row-state">On</span>
                              </div>
                            ))}
                            <p className="lorebook-menu-hint">
                              Global lorebooks run in every chat — manage them on the{" "}
                              <AppLink to="/lorebooks">Lorebooks</AppLink> page.
                            </p>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <p className="lorebook-menu-empty">Loading…</p>
                    )}
                  </motion.div>
                ) : null}
              </Presence>
            </div>
          ) : null}
          {/* Character gallery shortcut: opens the same modal the Characters
            view uses, scoped to the open chat's character. Shares the
            lorebook trigger's icon-only pill chrome. */}
          {layout.elements.gallery ? (
            <motion.button
              type="button"
              className="persona-trigger lorebook-trigger"
              data-tip="Character gallery"
              aria-haspopup="dialog"
              aria-expanded={galleryOpen}
              aria-label="Character gallery"
              whileTap={tap}
              onClick={() => setGalleryOpen(true)}
            >
              <Image size={14} />
            </motion.button>
          ) : null}
        </div>
        <span className="chat-header-spacer" />
        {/* Generation status group: one pill per stage, all additive (a reply
            can stream while a tracker/summary runs). It lives AFTER the spacer
            so an appearing/disappearing pill consumes the row's free space
            instead of shifting the persona picker, the header icons, or the
            controls on the right. On phones the compact setting swaps the
            text pills for icon-only chips so the row can stay one line. */}
        <div className="chat-header-status">
          <StreamingStatusPill compact={compactStatus} />
          {/* Tracker generation status: additive to the streaming pill and
              driven by the shared store flag, so it covers both the automatic
              SSE tracking stage and the drawer's manual Generate action. */}
          <TrackerStatusPill compact={compactStatus} />
          {/* Summarization status: mirrors the tracker pill, driven by the
              shared store flag so it covers both the automatic SSE summarizing
              stage and the Summaries drawer's manual Summarize now. */}
          <SummarizingStatusPill compact={compactStatus} />
        </div>
        {/* Budget pill: the token counter plus the entry point to the
            prompt inspector. Rendered whenever the counter element is on —
            with no run yet there is no budget to print, so the pill falls
            back to a plain label and the inspector's dry run still works. */}
        {layout.elements.tokenCounter ? (
          <motion.button
            type="button"
            className="pill prompt-pill"
            data-tip="Inspect the assembled prompt"
            aria-haspopup="dialog"
            aria-expanded={previewOpen}
            aria-label={
              budgetText === null
                ? "Inspect the assembled prompt"
                : `Prompt token budget: ${budgetText}; inspect the assembled prompt`
            }
            whileTap={tap}
            onClick={() => setPreviewOpen(true)}
          >
            <Database size={12} />
            {budgetText ?? "Prompt"}
          </motion.button>
        ) : null}
        <motion.button
          type="button"
          className="btn btn-icon header-action"
          data-tip={chatsCollapsed() ? "Show chat list" : "Hide chat list"}
          aria-label={chatsCollapsed() ? "Show chat list" : "Hide chat list"}
          aria-pressed={chatsTogglePressed()}
          whileTap={tap}
          onClick={() => (isMobile ? toggleChats() : toggleChatsPane())}
        >
          {!chatsCollapsed() ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </motion.button>
        <motion.button
          type="button"
          className="btn btn-icon header-action"
          aria-pressed={drawerOpen}
          aria-label={drawerOpen ? "Hide panels" : "Show panels"}
          whileTap={tap}
          onClick={toggleDrawer}
        >
          <Layers size={15} />
        </motion.button>
      </div>
      <Presence>
        {chatError !== null ? (
          <motion.div
            key="chat-error"
            className="chat-error"
            role="alert"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TriangleAlert size={14} />
            <span>{chatError}</span>
          </motion.div>
        ) : null}
      </Presence>
      {/* The drawer stays mounted through the closing phase — the exit
          animation needs the element in the tree until it finishes. */}
      {drawerOpen || drawerClosing ? (
        <ChatDrawer
          key={chatId}
          chatId={chatId}
          closing={drawerClosing}
          onClose={requestDrawerClose}
          onClosed={finishDrawerClose}
        />
      ) : null}
      {/* The prompt inspector: keyed on the chat id so a chat switch while
          it is open remounts it (with a fresh dry run) instead of showing
          the previous chat's prompt. */}
      {previewOpen ? (
        <PromptPreview key={chatId} chatId={chatId} onClose={() => setPreviewOpen(false)} />
      ) : null}
      {/* Gallery modal for the open chat's character. Guarded on the chat
          row (not just the id) so it never mounts without a character_id;
          onChanged refreshes the chat list so a new avatar reaches the
          header's avatar and title without a manual reload. */}
      {galleryOpen && chat !== null ? (
        <GalleryManager
          character={{
            id: chat.character_id,
            name: characterName,
            avatar_path: chat.character_avatar_path,
          }}
          onClose={() => setGalleryOpen(false)}
          onChanged={() => void chatActions.refreshChats()}
        />
      ) : null}
    </header>
  );
}
