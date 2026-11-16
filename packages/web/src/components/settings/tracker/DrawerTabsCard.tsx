/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginInfo } from "../../../lib/api-plugins";
import type { PluginTrackerContributions } from "../../../lib/tracker-config";
import { useDrawerStore } from "../../../stores/drawer";
import { usePlugins } from "../../../stores/plugins";
import { ChevronDown, ChevronUp } from "../../ui/icons";

/**
 * Chat drawer tab management: visibility + order for the built-in tabs and
 * every plugin-contributed one, bound to the drawer store (persisted in
 * localStorage under "suvoj.drawer"). Independent of the tracker's enabled
 * state — hiding a tab here never turns the tracker off.
 *
 * Renders as `.set-rows` + a trailing caption, for the enclosing card's
 * `.set-card-body.is-flush` (so the row hairlines run edge-to-edge).
 */
export default function DrawerTabsCard() {
  const drawer = useDrawerStore();
  const { plugins } = usePlugins();

  /** Plugin-contributed drawer tabs with their owning plugin's name. */
  const pluginTabs = (): Array<{ id: string; label: string; owner: string }> => {
    const out: Array<{ id: string; label: string; owner: string }> = [];
    // PluginInfo's drawer contributions are optional overlay fields the
    // shared type doesn't declare yet (the server emits them per plugin).
    const list: Array<PluginInfo & PluginTrackerContributions> = plugins ?? [];
    for (const plugin of list) {
      for (const tab of plugin.drawerTabs ?? []) {
        out.push({ id: tab.id, label: tab.label, owner: plugin.name });
      }
    }
    return out;
  };

  /** Every tab id that can appear in the drawer right now (deduped). */
  const availableIds = (): string[] => {
    const ids = ["tracker", "summaries"];
    for (const tab of pluginTabs()) {
      if (!ids.includes(tab.id)) {
        ids.push(tab.id);
      }
    }
    return ids;
  };

  /** Row label: built-ins by name, plugin tabs as "label — owning plugin". */
  const labelOf = (id: string): string => {
    if (id === "tracker") {
      return "Tracker";
    }
    if (id === "summaries") {
      return "Summaries";
    }
    const tab = pluginTabs().find((entry) => entry.id === id);
    return tab === undefined ? id : `${tab.label} — ${tab.owner}`;
  };

  /** The management list keeps hidden tabs in place so they can be re-shown
   *  (orderedAllTabIds vs. the drawer's visibility-filtered orderedTabIds). */
  const rows = drawer.orderedAllTabIds(availableIds());

  return (
    <>
      <div className="set-rows">
        {rows.map((id, index) => (
          <div className="set-row tracker-drawer-row" key={id}>
            <label className="tracker-drawer-toggle" htmlFor={`tracker-drawer-${id}`}>
              <span className="set-row-main">
                <span className="set-row-label">{labelOf(id)}</span>
                {id === "tracker" && (
                  <span className="set-row-hint">
                    The drawer tab — independent of the tracker's enabled state.
                  </span>
                )}
              </span>
            </label>
            <span className="switch">
              <input
                id={`tracker-drawer-${id}`}
                type="checkbox"
                className="switch-input"
                checked={drawer.isTabVisible(id)}
                onChange={() => drawer.toggleTabVisible(id)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </span>
            <div className="stepper set-stepper">
              <button
                type="button"
                className="btn btn-icon stepper-btn"
                aria-label={`Move ${labelOf(id)} tab up`}
                disabled={index === 0}
                onClick={() => drawer.moveTab(id, -1)}
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                className="btn btn-icon stepper-btn"
                aria-label={`Move ${labelOf(id)} tab down`}
                disabled={index === rows.length - 1}
                onClick={() => drawer.moveTab(id, 1)}
              >
                <ChevronDown size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="caption muted tracker-drawer-note">
        Tracker is always first by default; drag-free reordering.
      </p>
    </>
  );
}
