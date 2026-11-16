/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import { ChevronRight } from "../ui/icons";

/**
 * Collapsed settings group for controls most people never touch. Native
 * <details> supplies the disclosure semantics and keyboard behavior, so this
 * component only owns the presentation. Saved values stay mounted while the
 * section is closed: we hide it, never unmount it.
 */
export default function AdvancedSection({
  title = "Advanced",
  summary,
  children,
}: {
  title?: string;
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="set-advanced">
      <summary className="set-advanced-summary">
        <ChevronRight size={14} className="set-advanced-chevron" aria-hidden="true" />
        <span className="set-advanced-title">{title}</span>
        {summary !== undefined && <span className="set-advanced-hint">{summary}</span>}
      </summary>
      <div className="set-advanced-body">{children}</div>
    </details>
  );
}
