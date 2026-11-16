/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import { Collapsible } from "../ui/collapsible";
import { ChevronDown, Info } from "../ui/icons";

export interface PresetSectionProps {
  /** Short stable key: also forms the body's DOM id (`preset-section-<id>`). */
  id: string;
  title: string;
  /** Longer explanation for the section title's Info button; omitted = no button. */
  tip?: string;
  /** Optional right-aligned summary (counts, validity) — tabular figures. */
  meta?: ReactNode;
  /** Whether the body is disclosed. Controlled so the editor owns the state. */
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * One titled, collapsible block of the preset editor. Extracted so the three
 * sections (Generation / Prompts / Controls) share one trigger shape — a real
 * <button> with aria-expanded/aria-controls, the chevron as pure decoration —
 * and one disclosure animation via the house Collapsible, instead of each
 * section re-deriving it. The Info button is a SIBLING of the trigger, not a
 * child, so the trigger's accessible name stays exactly the section title.
 */
export function PresetSection(props: PresetSectionProps): ReactNode {
  const bodyId = `preset-section-${props.id}`;

  return (
    <section className="preset-section">
      <div className="preset-section-head">
        <button
          type="button"
          className="preset-section-toggle"
          aria-expanded={props.open}
          aria-controls={bodyId}
          onClick={props.onToggle}
        >
          <span className="preset-section-chevron" aria-hidden="true">
            <ChevronDown size={15} />
          </span>
          <span className="preset-section-title">{props.title}</span>
        </button>
        {props.tip !== undefined && (
          <button type="button" className="info-tip" aria-label={props.tip} data-tip={props.tip}>
            <Info size={13} aria-hidden="true" />
          </button>
        )}
        {props.meta !== undefined && <span className="preset-section-meta tnum">{props.meta}</span>}
      </div>
      {/* Always mounted so the open/close is a real height animation (the
          Collapsible clips + inerts the body while shut; see ui/collapsible). */}
      <Collapsible id={bodyId} open={props.open}>
        <div className="preset-section-body">{props.children}</div>
      </Collapsible>
    </section>
  );
}
