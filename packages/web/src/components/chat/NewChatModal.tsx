/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { CharacterListItem } from "../../lib/api-characters";
import type { Persona } from "../../lib/api-personas";
import { listPersonas } from "../../lib/api-personas";
import { characterPickerPageSize, useCharacterPager } from "../../lib/character-paging";
import { getCharacterSort, rememberCharacterSort } from "../../lib/character-sort-preference";
import { INSTANT, useAppMotion } from "../../lib/motion";
import { getLastPersonaId } from "../../lib/persona-preference";
import { useIsMobile } from "../../lib/use-viewport";
import { chatActions } from "../../stores/chat";
import CharacterPageNav from "../characters/CharacterPageNav";
import CharacterSortSelect from "../characters/CharacterSortSelect";
import { AppLink } from "../ui/AppLink";
import { Drama, Search } from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";
import { Presence } from "../ui/presence";
import type { CharacterLayout } from "./CharacterTiles";
import CharacterTiles, { CharacterTilesSkeleton, CharacterViewToggle } from "./CharacterTiles";
// Self-contained so the modal works wherever it is mounted (the Chats
// sidebar today). Both sheets are already bundled app-wide via the
// statically imported views; these imports just make the dependency
// explicit. Vite dedupes them.
import "../../styles/chat.css";
import "../../styles/views.css";

export interface NewChatModalProps {
  onClose: () => void;
}

/**
 * New-chat picker body: a debounced server-side search plus a paged grid of
 * character tiles; clicking a character starts a chat with the selected
 * persona (pre-set to the last-used persona from the browser-local
 * preference).
 *
 * Rendered as a child of the shared <Modal>, so a successful pick can call
 * `useModalClose()` and let the modal's exit animation play before the parent
 * unmounts it (the hook must not be called in the component that renders
 * <Modal> — see ui/Modal).
 */
function NewChatBody() {
  const closeModal = useModalClose();
  // React port of the paged picker state machine — plain values plus stable
  // actions, and it owns the debounce/stale-response guards internally. The
  // order is seeded from the remembered preference so a New Chat pick lands in
  // the same order the Characters grid last used. This picker pages discretely
  // (not infinite scroll), with a phone-sized page so a page fits the sheet.
  const isMobile = useIsMobile();
  const pager = useCharacterPager({
    initialSort: getCharacterSort(),
    mode: "pages",
    pageSize: characterPickerPageSize(isMobile),
  });
  const app = useAppMotion();
  const [personas, setPersonas] = useState<Persona[]>([]);
  // Compact rows are the default: the picker is a quick scan-and-pick, and the
  // taller tile grid is an opt-in the user can toggle to.
  const [layout, setLayout] = useState<CharacterLayout>("rows");
  // Lazily seeded from the remembered persona so the first render already
  // shows the last-used pick; an absent preference leaves "None" selected.
  const [personaId, setPersonaId] = useState(() => getLastPersonaId() ?? "");

  // Mount-time load (the Solid `onMount`).
  useEffect(() => {
    // Persona choice is non-blocking: a failed load just leaves "None".
    listPersonas()
      .then((items) => setPersonas(items))
      .catch(() => setPersonas([]));
  }, []);

  /** Starts the chat (the store owns the open + error surface) and closes
   *  the modal on success — through the modal's animated close, so the exit
   *  plays. A failed create keeps the modal open (the store's error banner
   *  carries the message). */
  const pick = (character: CharacterListItem): void => {
    chatActions.newChat(character.id, personaId === "" ? undefined : personaId).then((id) => {
      if (id) {
        closeModal();
      }
    });
  };

  let body: ReactNode;
  if (pager.loading) {
    body = <CharacterTilesSkeleton layout={layout} />;
  } else if (pager.error !== null) {
    body = (
      <p className="error-banner" role="alert">
        {pager.error}
      </p>
    );
  } else if (pager.total > 0 || pager.search.trim() !== "" || pager.committed !== "") {
    // Keep the search box mounted whenever a query is (or was) in effect,
    // even if it matched nothing — otherwise the input would unmount itself
    // the moment a search returned zero rows. Both the live and committed
    // values are checked so clearing the box, which lags by the debounce,
    // cannot unmount it either.
    body = (
      <>
        <div className="row new-chat-controls">
          <div className="search-field">
            <span className="search-icon" aria-hidden="true">
              <Search size={16} />
            </span>
            <input
              className="input"
              type="search"
              placeholder="Search characters…"
              aria-label="Search characters"
              value={pager.search}
              onChange={(event) => pager.onSearch(event.currentTarget.value)}
            />
          </div>
          {personas.length > 0 ? (
            <label className="field new-chat-persona">
              <span className="field-label">Persona (optional)</span>
              <select
                className="select"
                aria-label="Persona"
                value={personaId}
                onChange={(event) => setPersonaId(event.currentTarget.value)}
              >
                <option value="">None</option>
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <CharacterSortSelect
            className="new-chat-sort"
            value={pager.sort}
            onChange={(next) => {
              pager.setSort(next);
              rememberCharacterSort(next);
            }}
          />
          <CharacterViewToggle value={layout} onChange={setLayout} />
        </div>
        {pager.items.length > 0 ? (
          <>
            <CharacterTiles characters={pager.items} onPick={pick} layout={layout} />
            <CharacterPageNav
              page={pager.page}
              pageSize={pager.pageSize}
              loaded={pager.items.length}
              total={pager.total}
              busy={pager.loadingMore}
              onPrev={pager.prevPage}
              onNext={pager.nextPage}
            />
          </>
        ) : (
          <p className="picker-status">No characters match your search.</p>
        )}
      </>
    );
  } else {
    body = (
      <div className="empty-state">
        <span className="empty-state-icon" aria-hidden="true">
          <Drama size={28} strokeWidth={1.5} />
        </span>
        <span className="empty-state-title">No characters yet</span>
        <span className="empty-state-hint">
          <AppLink to="/characters">Create a character</AppLink> first to start chatting.
        </span>
      </div>
    );
  }

  // Only the skeleton↔content and error↔content swaps animate; a debounced
  // search refetch keeps the same key, so the search input is never remounted
  // (and never loses focus) while the query settles.
  const bodyKey = pager.loading ? "loading" : pager.error !== null ? "error" : "content";

  return (
    <Presence mode="wait">
      <motion.div
        key={bodyKey}
        className="stack"
        initial={app.reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={app.reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
        transition={app.reduce ? INSTANT : app.transition}
      >
        {body}
      </motion.div>
    </Presence>
  );
}

/**
 * New-chat picker mounted by the Chats sidebar. A thin wrapper around the
 * shared <Modal>: the body lives in {@link NewChatBody} so it can use
 * `useModalClose()` for its animated close.
 */
export default function NewChatModal(props: NewChatModalProps) {
  return (
    <Modal title="New chat" onClose={props.onClose}>
      <NewChatBody />
    </Modal>
  );
}
