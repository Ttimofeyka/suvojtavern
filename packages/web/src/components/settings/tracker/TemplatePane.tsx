/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useState } from "react";
import { cx } from "../../../lib/cx";
import { fadeVariants, useAppMotion } from "../../../lib/motion";
import { TemplateFrame } from "../../shared/TemplateFrame";
import { Collapsible } from "../../ui/collapsible";
import ErrorBoundary from "../../ui/ErrorBoundary";
import { ChevronDown, ChevronUp, WandSparkles } from "../../ui/icons";
import { Presence } from "../../ui/presence";
import { Segmented } from "../../ui/segmented";

/** The two template editors behind the pane's tab control. */
type TemplateTab = "html" | "css";

/** The template-syntax reference shown under the HTML editor. Kept as data so
 *  the tokens and their descriptions stay aligned. */
const CHEATSHEET: Array<[string, string]> = [
  ["{{path}}", "escaped value"],
  ["{{{path}}}", "raw value"],
  ["{{#each arr}}…{{/each}}", "loop"],
  ["{{#if path}}…{{else}}…{{/if}}", "conditional"],
  ['{{join arr ", "}}', "join a string list"],
];

/**
 * The output side of the editor: the HTML/CSS template editors behind tabs and
 * the live preview.
 *
 * The preview values are the DEBOUNCED ones the caller already computed (the
 * textareas edit the committed preset directly, so typing stays snappy while
 * the iframe re-renders at most every 300ms). A template syntax error is
 * likewise surfaced by the caller's `renderTemplate` pre-check, so the frame
 * never has to throw.
 */
export function TemplatePane(props: {
  html: string;
  css: string;
  onHtml: (value: string) => void;
  onCss: (value: string) => void;
  /** Replace the HTML with one derived from the current schema. */
  onRegenerate: () => void;
  previewHtml: string;
  previewCss: string;
  previewData: Record<string, unknown>;
  previewError: string | null;
}) {
  const app = useAppMotion();
  const [tab, setTab] = useState<TemplateTab>("html");
  const [syntaxOpen, setSyntaxOpen] = useState(false);

  return (
    <section className="tracker-template-pane">
      <div className="tracker-pane-head">
        <h4 className="tracker-pane-title">Template</h4>
        <Segmented
          ariaLabel="Template to edit"
          options={[
            { value: "html", label: "HTML" },
            { value: "css", label: "CSS" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {/* mode="wait": the two editors are the same surface, so the outgoing one
          should finish before the incoming one arrives rather than overlap. */}
      <Presence mode="wait">
        <motion.div
          key={tab}
          className="stack tracker-template-editor"
          variants={fadeVariants(app)}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          {tab === "html" ? (
            <>
              <div className="tracker-template-toolbar">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => props.onRegenerate()}
                  title="Replace the template with one derived from the current schema"
                >
                  <WandSparkles size={12} />
                  Auto-generate from schema
                </button>
                <button
                  type="button"
                  className="btn btn-ghost tracker-collapse-toggle"
                  aria-expanded={syntaxOpen}
                  onClick={() => setSyntaxOpen((open) => !open)}
                >
                  {syntaxOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  Syntax
                </button>
              </div>
              <textarea
                className="textarea tracker-code"
                rows={10}
                spellCheck={false}
                aria-label="HTML template"
                value={props.html}
                onChange={(event) => props.onHtml(event.currentTarget.value)}
              />
              <Collapsible open={syntaxOpen} className="tracker-syntax">
                <dl className="tracker-cheatsheet">
                  {CHEATSHEET.map(([syntax, meaning]) => (
                    <div className="tracker-cheatsheet-row" key={syntax}>
                      <dt>
                        <code>{syntax}</code>
                      </dt>
                      <dd>{meaning}</dd>
                    </div>
                  ))}
                </dl>
              </Collapsible>
            </>
          ) : (
            <textarea
              className="textarea tracker-code"
              rows={16}
              spellCheck={false}
              aria-label="Template CSS"
              value={props.css}
              onChange={(event) => props.onCss(event.currentTarget.value)}
            />
          )}
        </motion.div>
      </Presence>

      <div className="tracker-preview">
        <div className="tracker-preview-head">
          <span className="field-label">Preview</span>
          <span className={cx("tracker-preview-live", props.previewError !== null && "is-error")}>
            <span className="tracker-preview-dot" aria-hidden="true" />
            {props.previewError !== null ? "Template error" : "Live"}
          </span>
        </div>
        <Presence mode="wait">
          {props.previewError === null ? (
            <motion.div
              key="frame"
              className="tracker-preview-frame"
              variants={fadeVariants(app)}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <ErrorBoundary
                fallback={(err) => (
                  <p className="field-error tracker-preview-error" role="alert">
                    Preview failed: {err instanceof Error ? err.message : String(err)}
                  </p>
                )}
              >
                <TemplateFrame
                  html={props.previewHtml}
                  css={props.previewCss}
                  data={props.previewData}
                />
              </ErrorBoundary>
            </motion.div>
          ) : (
            <motion.p
              key="error"
              className="field-error tracker-preview-error"
              role="alert"
              variants={fadeVariants(app)}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              {props.previewError}
            </motion.p>
          )}
        </Presence>
        <span className="field-hint">Rendered from a sample of the edited schema.</span>
      </div>
    </section>
  );
}
