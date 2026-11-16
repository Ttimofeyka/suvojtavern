/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useRef, useState } from "react";
import type { CharacterListItem } from "../lib/api-characters";
import { characterPickerPageSize, useCharacterPager } from "../lib/character-paging";
import { riseVariants, useAppMotion } from "../lib/motion";
import { getLastPersonaId } from "../lib/persona-preference";
import { useIsMobile } from "../lib/use-viewport";
import { chatActions } from "../stores/chat";
import CharacterPageNav from "./characters/CharacterPageNav";
import CharacterTiles, {
  type CharacterLayout,
  CharacterTilesSkeleton,
  CharacterViewToggle,
} from "./chat/CharacterTiles";
import { AppLink } from "./ui/AppLink";
import { Drama, Search } from "./ui/icons";
import Modal from "./ui/Modal";
import { Presence } from "./ui/presence";
import { Stagger, StaggerItem } from "./ui/stagger";
// Self-contained like NewChatModal: the wizard mounts from the Chats view,
// and these sheets are bundled app-wide via the statically imported views.
import "../styles/chat.css";
import "../styles/views.css";

/** localStorage flag that keeps the wizard from auto-showing after a
 *  dismissal. Cleared by the empty-state "Run the setup wizard" link. */
export const WIZARD_DISMISSED_KEY = "suvoj.wizard.dismissed";

const STEP_TITLES = ["Welcome to SuvojTavern", "Start chatting"];

/** Modal header per step (index access guarded for noUncheckedIndexedAccess). */
const stepTitle = (step: number): string => STEP_TITLES[step - 1] ?? "Welcome to SuvojTavern";

export interface WelcomeWizardProps {
  /** Called whenever the wizard closes, however it was closed. */
  onClose: () => void;
}

/**
 * First-run setup wizard: welcome → pick a character. Mounted by the Chats
 * view when there are no chats yet (and not previously dismissed). Every exit
 * path is escapable — X, Escape, and the skip buttons all dismiss permanently.
 */
export default function WelcomeWizard(props: WelcomeWizardProps) {
  const app = useAppMotion();
  const [step, setStep] = useState(1);
  // The character step's server-side search + discrete paging; prefetched on
  // mount so the grid is ready by the time the user reaches step 2. The wizard
  // keeps the default name order (no sort UI here) and pages by viewport.
  const isMobile = useIsMobile();
  const pager = useCharacterPager({
    mode: "pages",
    pageSize: characterPickerPageSize(isMobile),
  });
  // Picker layout for step 2; compact rows by default, matching the picker's
  // shared default. The toggle in the controls row flips it.
  const [layout, setLayout] = useState<CharacterLayout>("rows");
  // Last-used persona from the browser-local preference, kept in a ref
  // (nothing renders on it). A plain body variable would be re-created on
  // every render and lose the captured value; the ref keeps the first read.
  const personaId = useRef(getLastPersonaId() ?? "");

  /** Marks the wizard as seen so it never auto-shows again. */
  const dismiss = (): void => {
    localStorage.setItem(WIZARD_DISMISSED_KEY, "1");
  };

  /** X / Escape / backdrop / skip: dismiss, then close. */
  const dismissAndClose = (): void => {
    dismiss();
    props.onClose();
  };

  /** Starts the chat (the store owns the open + error surface) and finishes
   *  the wizard — the new chat flips the Chats empty state on its own. A
   *  failed create keeps the wizard open so the failure surfaces where the
   *  user is; the store's error banner carries the message. */
  const start = (character: CharacterListItem): void => {
    chatActions
      .newChat(character.id, personaId.current === "" ? undefined : personaId.current)
      .then((id) => {
        if (id) {
          dismissAndClose();
        }
      });
  };

  // Nothing to show yet: the empty state only renders when the unfiltered list
  // is empty AND no search is committed or typed. Matches the Solid `<Show>`
  // fallback's negated condition.
  const showEmptyState = pager.total === 0 && pager.search.trim() === "" && pager.committed === "";

  return (
    <Modal title={stepTitle(step)} onClose={dismissAndClose}>
      <div className="stack">
        {/* Step bodies crossfade through Presence: the outgoing step finishes
            its exit before the incoming one enters (mode="wait"), so Next reads
            as one deliberate swap. The first mount does not play (Presence
            defaults initial=false) — the Modal owns the opening animation. */}
        <Presence mode="wait">
          <motion.div
            key={step}
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {step === 1 && (
              <div className="wizard-hero">
                {/* The hero's two lines cascade in, one beat apart. */}
                <Stagger>
                  <StaggerItem>
                    <span className="brand-mark wizard-hero-mark" aria-hidden="true">
                      <img src="/logo.png" alt="" className="brand-logo" />
                    </span>
                  </StaggerItem>
                  <StaggerItem>
                    <p className="wizard-hero-intro">
                      Roleplay chat with your characters — with long-term memory, lorebooks, and
                      generation presets shaping every reply.
                    </p>
                  </StaggerItem>
                </Stagger>
              </div>
            )}

            {step === 2 && (
              <div>
                {pager.loading ? (
                  <CharacterTilesSkeleton layout={layout} />
                ) : pager.error !== null ? (
                  <p className="error-banner" role="alert">
                    {pager.error}
                  </p>
                ) : showEmptyState ? (
                  <div className="empty-state">
                    <span className="empty-state-icon" aria-hidden="true">
                      <Drama size={28} strokeWidth={1.5} />
                    </span>
                    <span className="empty-state-title">No characters yet</span>
                    <span className="empty-state-hint">
                      <AppLink to="/characters">Create your first character</AppLink> to start
                      chatting.
                    </span>
                  </div>
                ) : (
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
                      <CharacterViewToggle value={layout} onChange={setLayout} />
                    </div>
                    {pager.items.length > 0 ? (
                      <>
                        <CharacterTiles characters={pager.items} onPick={start} layout={layout} />
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
                )}
              </div>
            )}
          </motion.div>
        </Presence>

        <div className="wizard-footer">
          <span className="caption muted">Step {step} of 2</span>
          <div className="row">
            {step > 1 && (
              <button type="button" className="btn" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={dismissAndClose}>
              {step < 2 ? "Skip setup" : "Skip for now"}
            </button>
            {step < 2 && (
              <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
