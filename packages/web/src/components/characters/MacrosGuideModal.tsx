/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { filterMacroSections, MACRO_INTRO } from "../../lib/macro-guide";
import { fadeVariants, useAppMotion } from "../../lib/motion";
import { Check, Copy, Search } from "../ui/icons";
import Modal from "../ui/Modal";
import { Presence } from "../ui/presence";
import "../../styles/macros.css";

/**
 * In-app reference for the macro engine, opened from the character editor.
 * Content is static app data (macro-guide.ts), so everything renders as plain
 * text interpolation — no HTML injection anywhere.
 */
export default function MacrosGuideModal(props: { onClose: () => void }) {
  const app = useAppMotion();
  const [query, setQuery] = useState("");
  const sections = useMemo(() => filterMacroSections(query), [query]);

  // Copy feedback: the check shows briefly after a successful write. `copyText`
  // falls back to `execCommand` in an insecure context (LAN HTTP), so a `false`
  // result is a real failure — the shared pattern from PromptPreview/MessageBubble.
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  const copy = async (syntax: string): Promise<void> => {
    if (!(await copyText(syntax))) {
      return;
    }
    setCopied(syntax);
    window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Modal title="Macros" xl onClose={props.onClose}>
      <div className="stack">
        <div className="macros-intro">
          {MACRO_INTRO.map((paragraph) => (
            <p className="field-hint" key={paragraph}>
              {paragraph}
            </p>
          ))}
        </div>
        <div className="search-field macros-search">
          <span className="search-icon" aria-hidden="true">
            <Search size={16} />
          </span>
          <input
            className="input"
            type="search"
            placeholder="Search macros…"
            aria-label="Search macros"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <Presence mode="wait">
          <motion.div
            key={sections.length > 0 ? "results" : "empty"}
            className="stack"
            variants={fadeVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {sections.length > 0 ? (
              sections.map((section) => (
                <section
                  className="macros-section"
                  aria-labelledby={`macros-section-${section.id}`}
                  key={section.id}
                >
                  <h4 className="macros-section-title" id={`macros-section-${section.id}`}>
                    {section.title}
                  </h4>
                  <p className="macros-section-blurb">{section.blurb}</p>
                  <div className="macros-list">
                    {section.entries.map((entry) => (
                      <div className="macros-entry" key={entry.syntax}>
                        <div className="macros-syntax">
                          <code>{entry.syntax}</code>
                          <span className="macros-syntax-name">{entry.name}</span>
                        </div>
                        <div className="macros-body">
                          <p className="macros-desc">{entry.description}</p>
                          <p className="macros-example">{entry.example}</p>
                          {entry.note !== undefined && entry.note !== "" && (
                            <p className="macros-note">{entry.note}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-icon macros-copy"
                          aria-label={`Copy ${entry.syntax}`}
                          data-tip="Copy"
                          onClick={() => void copy(entry.syntax)}
                        >
                          {/* mode="wait" crossfades the confirmation mark in. */}
                          <Presence mode="wait">
                            <motion.span
                              key={copied === entry.syntax ? "copied" : "copy"}
                              variants={fadeVariants(app)}
                              initial="hidden"
                              animate="visible"
                              exit="exit"
                            >
                              {copied === entry.syntax ? <Check size={16} /> : <Copy size={16} />}
                            </motion.span>
                          </Presence>
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <p className="macros-empty">
                No macros match “{query}”. Try a name like random, or a section like time.
              </p>
            )}
          </motion.div>
        </Presence>
      </div>
    </Modal>
  );
}
