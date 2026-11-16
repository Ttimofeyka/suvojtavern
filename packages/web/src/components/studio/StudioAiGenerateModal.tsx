/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from "react";
import type { SeedFieldKey } from "../../lib/api-character-generation";
import { SEED_FIELD_LABELS, SEED_FIELD_ORDER } from "../../lib/api-character-generation";
import { WandSparkles } from "../ui/icons";
import Modal from "../ui/Modal";

interface StudioAiGenerateModalProps {
  open: boolean;
  /** Fields marked for this pass. */
  marks: SeedFieldKey[];
  /** Optional per-field directions shown in the summary. */
  directions: Partial<Record<SeedFieldKey, string>>;
  /** How many swipes the alternate-greeting pass will write. */
  alternateCount: number;
  busy: boolean;
  error: string | null;
  onGenerate: () => void;
  onClose: () => void;
}

/**
 * The batch pass's confirmation sheet. It is deliberately a summary rather than
 * a second editor: marks and directions are set inline so the author sees them
 * in context, and this dialog answers the one question that matters — which
 * fields is the AI about to write?
 */
export default function StudioAiGenerateModal(
  props: StudioAiGenerateModalProps,
): ReactElement | null {
  if (!props.open) {
    return null;
  }
  const ordered = SEED_FIELD_ORDER.filter((field) => props.marks.includes(field));

  return (
    <Modal title="Generate with AI" onClose={props.onClose}>
      <p className="caption muted studio-ai-modal-intro">
        The AI reads every field you have filled, the concept notes, and the directions below. It
        writes only the marked fields; everything else is context.
      </p>

      <ul className="studio-ai-summary">
        {ordered.map((field) => (
          <li className="studio-ai-summary-row" key={field}>
            <span className="studio-ai-summary-label">{SEED_FIELD_LABELS[field]}</span>
            <span className="studio-ai-summary-detail">
              {field === "alternate_greetings"
                ? `${props.alternateCount} alternate${props.alternateCount === 1 ? "" : "s"}${
                    props.directions[field]?.trim() ? ` · ${props.directions[field]?.trim()}` : ""
                  }`
                : props.directions[field]?.trim() || "No direction"}
            </span>
          </li>
        ))}
      </ul>

      {props.error !== null && (
        <p className="error-banner" role="alert">
          {props.error}
        </p>
      )}

      <div className="studio-ai-modal-actions">
        <span className="caption muted tnum">
          {ordered.length} {ordered.length === 1 ? "field" : "fields"} marked
        </span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={props.busy || ordered.length === 0}
          onClick={props.onGenerate}
        >
          {props.busy ? (
            <span className="spinner btn-spinner" aria-hidden="true" />
          ) : (
            <WandSparkles size={16} />
          )}
          {props.busy ? "Writing…" : "Generate"}
        </button>
      </div>
    </Modal>
  );
}
