/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import type { ChatImportResult } from "../../lib/api-transfer";
import { importChat } from "../../lib/api-transfer";
import { useCharacterPager } from "../../lib/character-paging";
import { fadeVariants, useAppMotion } from "../../lib/motion";
import { Check, MessageCircle, Search, TriangleAlert } from "../ui/icons";
import { Presence } from "../ui/presence";
import CharacterListMore from "./CharacterListMore";
import DropZone from "./DropZone";

export interface ChatImportPanelProps {
  /** Any import is running anywhere in the dialog. */
  busy: boolean;
  /** This panel's own import is running. */
  importing: boolean;
  run: (action: () => Promise<void>) => void;
  onChanged: () => void;
}

/**
 * Chat tab: a SillyTavern `.jsonl` export belongs to an existing character, so
 * the target picker comes first and starts empty. Silently defaulting to the
 * first character (as the old single-form dialog did) risked filing a chat
 * under the wrong card.
 */
export default function ChatImportPanel(props: ChatImportPanelProps) {
  const app = useAppMotion();
  const pager = useCharacterPager();
  const items = pager.items;
  const [characterId, setCharacterId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The loaded page can change under the selection (a search, a refresh). Drop
  // a target that no longer exists rather than keeping a stale id.
  useEffect(() => {
    if (characterId !== "" && !items.some((item) => item.id === characterId)) {
      setCharacterId("");
    }
  }, [items, characterId]);

  const importChatFile = (file: File): void => {
    if (characterId === "") {
      setError("Choose the character this chat belongs to.");
      return;
    }
    const targetName = items.find((item) => item.id === characterId)?.name;
    setMessage(null);
    setError(null);
    props.run(async () => {
      try {
        const result: ChatImportResult = await importChat(file, { character_id: characterId });
        const count = result.messages.length;
        const into = targetName === undefined ? "the chosen character" : targetName;
        setMessage(`Imported ${count} message${count === 1 ? "" : "s"} into ${into}.`);
        props.onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed");
      }
    });
  };

  const empty = !pager.loading && !pager.loadingMore && pager.total === 0 && pager.error === null;

  return (
    <div className="char-transfer-panel">
      <header className="char-transfer-panel-head">
        <span className="char-transfer-panel-icon" aria-hidden="true">
          <MessageCircle size={20} />
        </span>
        <div className="char-transfer-panel-copy">
          <h4 className="char-transfer-panel-title">Import a chat</h4>
          <p className="char-transfer-panel-desc">
            Continue a SillyTavern chat export inside one of your characters.
          </p>
        </div>
      </header>

      <div className="char-group">
        <div className="char-group-head">
          <h5 className="char-group-title">Target character</h5>
        </div>
        <p className="field-hint">
          The chat is attached to this character. Its card is not changed.
        </p>
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
            disabled={props.busy}
            onChange={(event) => pager.onSearch(event.currentTarget.value)}
          />
        </div>
        <select
          className="select"
          aria-label="Target character"
          value={characterId}
          disabled={props.busy || pager.loading}
          onChange={(event) => setCharacterId(event.currentTarget.value)}
        >
          <option value="">Select a character…</option>
          {items.map((character) => (
            <option value={character.id} key={character.id}>
              {character.name}
            </option>
          ))}
        </select>
        <CharacterListMore
          loaded={items.length}
          total={pager.total}
          loadingMore={pager.loadingMore}
          hasMore={pager.hasMore}
          onLoadMore={pager.loadMore}
        />
        {pager.error !== null && (
          <p className="error-banner" role="alert">
            <TriangleAlert size={16} />
            {pager.error}
          </p>
        )}
        {empty && (
          <p className="field-hint">
            {pager.search.trim() === ""
              ? "You have no characters yet. Create one first, then import its chat."
              : "No character matches this search."}
          </p>
        )}
      </div>

      <DropZone
        accept=".jsonl"
        icon={<MessageCircle size={22} />}
        title="Drop a chat export here"
        hint={
          characterId === ""
            ? "Choose a target character first"
            : ".jsonl from SillyTavern · or click to browse"
        }
        busy={props.importing}
        busyTitle="Importing chat…"
        disabled={characterId === "" || (props.busy && !props.importing)}
        onFile={importChatFile}
      />

      <Presence>
        {message !== null && (
          <motion.p
            className="transfer-msg"
            variants={fadeVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <Check size={14} />
            {message}
          </motion.p>
        )}
      </Presence>

      {error !== null && (
        <p className="error-banner" role="alert">
          <TriangleAlert size={16} />
          {error}
        </p>
      )}
    </div>
  );
}
