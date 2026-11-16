/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import ChatHeader from "../components/chat/ChatHeader";
import ChatList from "../components/chat/ChatList";
import MessageList from "../components/chat/MessageList";
import NewChatModal from "../components/chat/NewChatModal";
import SendBox from "../components/chat/SendBox";
import MobileNavButton from "../components/MobileNavButton";
import { AppLink } from "../components/ui/AppLink";
import { MessageCircle, MessageCirclePlus } from "../components/ui/icons";
import WelcomeWizard, { WIZARD_DISMISSED_KEY } from "../components/WelcomeWizard";
import { cx } from "../lib/cx";
import {
  chatErrorAtom,
  chatIdAtom,
  chatsLoadedAtom,
  chatsTotalAtom,
  refreshChats,
} from "../stores/chat";
import { layoutChatsPaneHiddenAtom } from "../stores/layout";
import { useMobileChats } from "../stores/mobile-chats";
import { appStore } from "../stores/store";
import "../styles/chat.css";

/**
 * The Chats screen: the chat list column beside the open conversation
 * (header, transcript, and composer stacked in the right column). With no
 * chats at all, one centered empty state replaces that whole layout.
 */
export default function Chats() {
  const chatId = useAtomValue(chatIdAtom);
  const chatsTotal = useAtomValue(chatsTotalAtom);
  const chatsLoaded = useAtomValue(chatsLoadedAtom);
  const error = useAtomValue(chatErrorAtom);
  const chatsPaneHidden = useAtomValue(layoutChatsPaneHiddenAtom);
  const { chatsOpen, closeChats } = useMobileChats();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  // The auto-show is a one-shot per mount, not a derived condition: closing
  // the wizard without dismissing it would otherwise satisfy "0 chats + not
  // dismissed" again and snap the modal right back open.
  const autoShownRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once — the synchronous checks read the first-render snapshot (what Solid's onMount saw), and the async continuation reads live atoms through the store below.
  useEffect(() => {
    // Escape closes the mobile chat-history slide-over (a no-op on desktop,
    // where the atom never drives any visible state).
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeChats();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Cached revisit: the store already settled on an empty list, so the
    // wizard opens in the very first render — no skeleton/empty-state flash.
    if (
      !autoShownRef.current &&
      chatsLoaded &&
      error === null &&
      chatsTotal === 0 &&
      chatId === null &&
      localStorage.getItem(WIZARD_DISMISSED_KEY) === null
    ) {
      autoShownRef.current = true;
      setWizardOpen(true);
    }
    // First-ever load: the store's [] is ambiguous between "empty" and "not
    // loaded" — this mount refresh is the single initial load (ChatList's
    // skeleton settles through the same store-owned flag) and decides
    // whether the wizard should appear once it settles. The continuation
    // reads the atoms live: the refresh has already written them by the
    // time it resolves, and the mount closure's copy would be stale.
    void refreshChats().then(() => {
      if (
        !autoShownRef.current &&
        appStore.get(chatErrorAtom) === null && // chats actually loaded, not a failed request
        appStore.get(chatsTotalAtom) === 0 &&
        localStorage.getItem(WIZARD_DISMISSED_KEY) === null
      ) {
        autoShownRef.current = true;
        setWizardOpen(true);
      }
    });

    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Manual launcher from the empty state: works regardless of chat count,
   *  clears the dismissal so later visits can auto-show again too. */
  const openWizard = (): void => {
    autoShownRef.current = true;
    localStorage.removeItem(WIZARD_DISMISSED_KEY);
    setWizardOpen(true);
  };

  // Loaded (the store's settled flag — it survives route remounts, so
  // revisits land here at once) and chat-free with nothing open: one unified
  // empty state replaces both columns, so the sidebar's and the main pane's
  // empty messages never double up. A stale open chat id against an empty
  // list keeps the two-column layout alive.
  const noChatsAtAll = chatsLoaded && chatsTotal === 0 && chatId === null;

  return (
    <>
      {!noChatsAtAll ? (
        // The history column hides only while a chat is open — with none
        // open, the side column IS the content, so it always shows.
        <section
          className={cx(
            "chats-layout",
            chatId !== null && chatsPaneHidden && "chats-pane-hidden",
            chatsOpen && "mobile-chats-open",
            // With no chat open there is no header toggle to reopen the
            // drawer, so on phones the list stays in flow as the content.
            chatId === null && "mobile-chats-static",
          )}
        >
          {chatsOpen && (
            <button
              type="button"
              className="mobile-chats-scrim"
              aria-label="Close chat list"
              onClick={closeChats}
            />
          )}
          <div className="chats-side">
            <ChatList />
          </div>
          {chatId ? (
            <div className="chats-main">
              <ChatHeader />
              <MessageList />
              <SendBox />
            </div>
          ) : (
            <div className="card chats-empty">
              {/* Mirrors ChatHeader's error surface: with no chat open, the
                  empty pane is where the store's shared error signal lands
                  (e.g. a failed chat creation). */}
              {error ? (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="empty-state">
                <span className="empty-state-icon" aria-hidden="true">
                  <MessageCircle size={28} strokeWidth={1.5} />
                </span>
                <span className="empty-state-title">Select or start a chat</span>
                <span className="empty-state-hint">
                  Pick a conversation from the list, start one with the new-chat button, or pick a
                  character from <AppLink to="/characters">Characters</AppLink>.
                </span>
                {chatsTotal === 0 && (
                  <button type="button" className="btn btn-ghost" onClick={openWizard}>
                    Run the setup wizard
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      ) : (
        <section className="chats-empty-screen">
          <MobileNavButton />
          <div className="card chats-empty">
            {/* Mirrors ChatHeader's error surface: with no chat open, the
                empty screen is where the store's shared error signal lands
                (e.g. a failed chat-list refresh). */}
            {error ? (
              <p className="error-banner" role="alert">
                {error}
              </p>
            ) : null}
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true">
                <MessageCircle size={28} strokeWidth={1.5} />
              </span>
              <span className="empty-state-title">No chats yet</span>
              <span className="empty-state-hint">
                Pick a character and say hello, or browse{" "}
                <AppLink to="/characters">Characters</AppLink> to find one.
              </span>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setNewChatOpen(true)}
                >
                  <MessageCirclePlus size={15} />
                  Start your first chat
                </button>
                <button type="button" className="btn btn-ghost" onClick={openWizard}>
                  Run the setup wizard
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
      {wizardOpen && <WelcomeWizard onClose={() => setWizardOpen(false)} />}
      {newChatOpen && <NewChatModal onClose={() => setNewChatOpen(false)} />}
    </>
  );
}
