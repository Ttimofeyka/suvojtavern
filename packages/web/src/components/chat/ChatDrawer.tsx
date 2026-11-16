/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchPluginTabData, type PluginTabData } from "../../lib/api-plugins";
import { cx } from "../../lib/cx";
import {
  INSTANT,
  type MotionVariants,
  riseVariants,
  scaleVariants,
  useAppMotion,
} from "../../lib/motion";
import { pluginIcon } from "../../lib/plugin-icons";
import { chatTrackerAtom } from "../../stores/chat";
import { useDrawerStore } from "../../stores/drawer";
import { usePlugins } from "../../stores/plugins";
import { TemplateFrame } from "../shared/TemplateFrame";
import type { IconProps } from "../ui/icons";
import {
  ChevronDown,
  ChevronUp,
  Layers,
  Radar,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  X,
} from "../ui/icons";
import { Presence } from "../ui/presence";
import SummariesPanel from "./SummariesPanel";
import TrackerPanel from "./TrackerPanel";
// Self-contained so the manage menu's chrome ships wherever the drawer mounts.
import "../../styles/chrome.css";

interface ChatDrawerProps {
  chatId: string;
  /** Requests closing — the drawer plays its exit animation first. */
  onClose: () => void;
  /** True while the parent has requested close: the drawer child unmounts so
   *  Presence can play its exit before `onClosed` unmounts the whole drawer. */
  closing: boolean;
  /** Fired when the exit animation ended — the parent unmounts. */
  onClosed: () => void;
}

/** One tab the drawer can host. */
interface DrawerTabInfo {
  id: string;
  label: string;
  kind: "tracker" | "summaries" | "plugin";
  /** Lucide icon name (plugin tabs only; resolved with a Puzzle fallback). */
  icon?: string;
  /** The contributing plugin (plugin tabs only). */
  pluginId?: string;
}

/** Built-in tabs' icons; plugin tabs resolve their icon name via the
 *  shared plugin icon map. */
const BUILTIN_TAB_ICONS: Record<string, ComponentType<IconProps>> = {
  tracker: Radar,
  summaries: Sparkles,
};

const iconOf = (tab: DrawerTabInfo): ComponentType<IconProps> =>
  tab.kind === "plugin" ? pluginIcon(tab.icon) : (BUILTIN_TAB_ICONS[tab.id] ?? Layers);

/**
 * One plugin tab's body: fetches the tab's panel data (its `onPanelData`
 * hook result) when mounted and whenever the chat changes, then renders it.
 *
 * The panel data JSON is the data root; the tab's rendering (htmlTemplate/
 * css) may ride along as string fields on that JSON — the only channel the
 * server leaves for plugin markup, since GET /api/plugins exposes tab
 * metadata only. Without a template the raw JSON renders, so tabs are
 * never blank.
 */
function PluginTabPanel(props: { chatId: string; tab: DrawerTabInfo }) {
  const app = useAppMotion();
  const [envelope, setEnvelope] = useState<PluginTabData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (chatId: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchPluginTabData(props.tab.pluginId ?? "", props.tab.id, chatId);
        // Ignore a response that arrives after the chat switched underneath.
        if (props.chatId === chatId) {
          setEnvelope(result);
        }
      } catch (err: unknown) {
        if (props.chatId === chatId) {
          setError(err instanceof Error ? err.message : "Failed to load panel data");
        }
      } finally {
        if (props.chatId === chatId) {
          setLoading(false);
        }
      }
    },
    [props.chatId, props.tab.pluginId, props.tab.id],
  );

  // Runs once on mount and again whenever the open chat changes (the Solid
  // `createEffect` over props.chatId / the tab identity).
  useEffect(() => {
    void load(props.chatId);
  }, [load, props.chatId]);

  /** The tab's declared template (shipped by the data route's envelope);
   *  an empty or missing one falls back to the raw JSON view. */
  const templateValue = envelope?.htmlTemplate;
  const template = typeof templateValue === "string" && templateValue !== "" ? templateValue : null;

  const stylesheet = typeof envelope?.css === "string" ? envelope.css : "";

  return (
    <section className="drawer-plugin" aria-label={props.tab.label}>
      {/* The four body states are exclusive, so they crossfade through a
          wait-mode Presence: the outgoing surface clears before the next
          lands (the branch elements are the motion nodes themselves, so the
          frame keeps its flex:1 drawer layout). */}
      <Presence mode="wait">
        {error !== null ? (
          <motion.div
            key="error"
            className="drawer-panel-error"
            role="alert"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TriangleAlert size={14} />
            <span>{error}</span>
            <button
              type="button"
              className="btn drawer-panel-retry"
              onClick={() => void load(props.chatId)}
            >
              <RotateCcw size={13} />
              Retry
            </button>
          </motion.div>
        ) : !loading ? (
          template !== null ? (
            <motion.div
              key="frame"
              className="drawer-plugin-frame"
              variants={riseVariants(app)}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <TemplateFrame html={template} css={stylesheet} data={envelope?.data ?? {}} />
            </motion.div>
          ) : (
            <motion.pre
              key="json"
              className="drawer-plugin-json"
              variants={riseVariants(app)}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              {JSON.stringify(envelope?.data ?? null, null, 2)}
            </motion.pre>
          )
        ) : (
          <motion.div
            key="loading"
            className="drawer-panel-loading"
            aria-hidden="true"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <span className="spinner" />
          </motion.div>
        )}
      </Presence>
    </section>
  );
}

/**
 * The chat drawer: the tabbed panel sliding in over the conversation's
 * right edge. Hosts the built-in tracker and summaries tabs plus every
 * tab enabled plugins contribute; tab order, visibility, and the selection
 * persist in the drawer store.
 *
 * The tracker tab appears only while the tracker is enabled and visible
 * (the GET /tracker payload's flags — invisible mode keeps snapshots
 * flowing but hides the surface).
 */
export default function ChatDrawer(props: ChatDrawerProps) {
  const drawer = useDrawerStore();
  const { plugins, load } = usePlugins();
  // Granular tracker read: the drawer stays mounted through generation, so
  // it must not subscribe to the per-token stream slices through the whole
  // chat store.
  const tracker = useAtomValue(chatTrackerAtom);
  const [manageOpen, setManageOpen] = useState(false);
  const manageRoot = useRef<HTMLDivElement | null>(null);
  const app = useAppMotion();
  // The drawer's own slide: in from the right, out the same way. Owned by
  // Motion (not the old CSS keyframes) so the exit actually completes before
  // the parent unmounts — `onClosed` is driven by that completion.
  //
  // Symmetric house ease-out tween in both directions: `app.transition` is the
  // base tween (med duration + `--ease-out`) overridden here to the
  // floating-panel duration token (`app.duration.panel`, ~240ms). That makes
  // open and close symmetric and matches the app's CSS entrance/slide-over
  // timing language (`.chats-side`'s `--dur-collapse` ease-out slide), instead
  // of the old slow spring in / abrupt 120ms `duration.fast` flicker out.
  // Under reduce the collapse falls out for free — `app.transition` is already
  // INSTANT and `app.duration.panel` is then 0, so no separate branch is
  // needed, and the exit still completes, emitting `onExitComplete`. 24px
  // reads as a perceptible glide without becoming a full off-canvas slide.
  const drawerVariants = useMemo<MotionVariants>(
    () => ({
      hidden: { opacity: 0, x: 24 },
      visible: {
        opacity: 1,
        x: 0,
        transition: { ...app.transition, duration: app.duration.panel },
      },
      exit: {
        opacity: 0,
        x: 24,
        transition: { ...app.transition, duration: app.duration.panel },
      },
    }),
    [app],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Click-away closes the manage menu (the header pickers' pattern). The
  // listener re-registers with the menu's open state; it only ever acts
  // while the menu is up.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (manageOpen && manageRoot.current && !manageRoot.current.contains(event.target as Node)) {
        setManageOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [manageOpen]);

  /** Tabs enabled plugins contribute, in plugin-list order. */
  const pluginTabs: DrawerTabInfo[] = (plugins ?? [])
    .filter((plugin) => plugin.enabled && plugin.error == null)
    .flatMap((plugin) =>
      (plugin.drawerTabs ?? []).map((tab) => ({
        id: tab.id,
        label: tab.label,
        icon: tab.icon,
        kind: "plugin" as const,
        pluginId: plugin.id,
      })),
    );

  /** Every tab currently available, in canonical order (tracker first —
   *  only while the tracker is enabled and visible — then summaries, then
   *  the plugin tabs). */
  const availableTabs: DrawerTabInfo[] = (() => {
    const tabs: DrawerTabInfo[] = [];
    if (tracker?.enabled && !tracker.invisible) {
      tabs.push({ id: "tracker", label: "Tracker", kind: "tracker" });
    }
    tabs.push({ id: "summaries", label: "Summaries", kind: "summaries" });
    return [...tabs, ...pluginTabs];
  })();

  /** The tabs the drawer renders: availability + saved order/visibility. */
  const orderedTabs: DrawerTabInfo[] = (() => {
    const byId = new Map(availableTabs.map((tab) => [tab.id, tab]));
    return drawer
      .orderedTabIds(availableTabs.map((tab) => tab.id))
      .map((id) => byId.get(id))
      .filter((tab): tab is DrawerTabInfo => tab !== undefined);
  })();

  /** Every available tab (hidden ones included) — the manage menu's rows. */
  const managedTabs: DrawerTabInfo[] = (() => {
    const byId = new Map(availableTabs.map((tab) => [tab.id, tab]));
    return drawer
      .orderedAllTabIds(availableTabs.map((tab) => tab.id))
      .map((id) => byId.get(id))
      .filter((tab): tab is DrawerTabInfo => tab !== undefined);
  })();

  /** The saved selection while it still renders; otherwise the first tab. */
  const activeTab: DrawerTabInfo | null =
    orderedTabs.find((tab) => tab.id === drawer.activeTabId()) ?? orderedTabs[0] ?? null;

  const selectTab = (id: string): void => {
    drawer.setActiveTabId(id);
    setManageOpen(false);
  };

  // Roving tablist: Left/Right wrap, Home/End jump, and the newly selected tab
  // takes focus — the model Settings' section tabs already implement.
  const onTabsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = orderedTabs.findIndex((tab) => tab.id === activeTab?.id);
    if (currentIndex === -1) {
      return;
    }
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % orderedTabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + orderedTabs.length) % orderedTabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = orderedTabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTab = orderedTabs[nextIndex];
    if (nextTab === undefined) {
      return;
    }
    selectTab(nextTab.id);
    document.getElementById(`drawer-tab-${nextTab.id}`)?.focus();
  };

  return (
    // Presence owns the exit: `closing` removes the child, the section runs
    // its `exit` variant, and onExitComplete hands control back — the same
    // pattern Modal uses. The parent keeps this component mounted through the
    // exit (its timeout fallback is idempotent) and only unmounts it from
    // `onClosed`, so the exit always gets to finish.
    <Presence initial onExitComplete={props.onClosed}>
      {!props.closing && (
        <motion.section
          key="drawer"
          className="drawer"
          aria-label="Chat panels"
          variants={drawerVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <header className="drawer-head">
            <div
              className="drawer-tabs"
              role="tablist"
              aria-label="Chat panels"
              onKeyDown={onTabsKeyDown}
            >
              {orderedTabs.map((tab) => {
                const Icon = iconOf(tab);
                const isActive = activeTab?.id === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={cx("drawer-tab", isActive && "is-active")}
                    id={`drawer-tab-${tab.id}`}
                    role="tab"
                    aria-selected={isActive}
                    aria-controls="drawer-panel"
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => selectTab(tab.id)}
                  >
                    {/* Shared-layout pill: slides between tabs as the selection
                    changes (the Segmented control's trick, kept on real
                    role="tab" buttons so the tablist semantics survive). */}
                    {isActive && (
                      <motion.span
                        layoutId="chat-drawer-tab"
                        aria-hidden="true"
                        className="drawer-tab-indicator"
                        transition={app.reduce ? INSTANT : app.spring.snappy}
                      />
                    )}
                    <Icon size={13} />
                    <span className="drawer-tab-label">{tab.label}</span>
                  </button>
                );
              })}
            </div>
            <span className="chat-header-spacer" />
            {/* Tab management: hide what you don't use, reorder the rest. */}
            <div className="drawer-manage" ref={manageRoot}>
              <button
                type="button"
                className="btn btn-icon header-action"
                aria-haspopup="true"
                aria-expanded={manageOpen}
                aria-label="Manage tabs"
                data-tip="Manage tabs"
                onClick={() => setManageOpen((open) => !open)}
              >
                <SlidersHorizontal size={14} />
              </button>
              <Presence>
                {manageOpen ? (
                  <motion.div
                    key="drawer-manage-menu"
                    className="drawer-manage-menu"
                    variants={scaleVariants(app)}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    {managedTabs.map((tab, index) => (
                      <div key={tab.id} className="drawer-manage-row">
                        <span className="drawer-manage-name">{tab.label}</span>
                        <span className="drawer-manage-move">
                          <button
                            type="button"
                            className="btn btn-icon"
                            aria-label={`Move ${tab.label} up`}
                            disabled={index === 0}
                            onClick={() => drawer.moveTab(tab.id, -1)}
                          >
                            <ChevronUp size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-icon"
                            aria-label={`Move ${tab.label} down`}
                            disabled={index === managedTabs.length - 1}
                            onClick={() => drawer.moveTab(tab.id, 1)}
                          >
                            <ChevronDown size={13} />
                          </button>
                        </span>
                        <label className="switch">
                          <input
                            id={`drawer-tab-${tab.id}`}
                            type="checkbox"
                            className="switch-input"
                            aria-label={`Show ${tab.label} tab`}
                            checked={drawer.isTabVisible(tab.id)}
                            onChange={() => drawer.toggleTabVisible(tab.id)}
                          />
                          <span className="switch-track">
                            <span className="switch-thumb" />
                          </span>
                        </label>
                      </div>
                    ))}
                  </motion.div>
                ) : null}
              </Presence>
            </div>
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Close drawer"
              onClick={props.onClose}
            >
              <X size={15} />
            </button>
          </header>
          <div
            className="drawer-body"
            role="tabpanel"
            id="drawer-panel"
            aria-labelledby={activeTab !== null ? `drawer-tab-${activeTab.id}` : undefined}
          >
            {/* The tab body crossfades on switch: a short rise + fade so the
                panel reads as one surface being replaced rather than a hard
                cut. mode="wait" (not sync) keeps the two panels from stacking
                in the column layout mid-swap; the exit is a fast tween, so the
                incoming panel is not held back noticeably. */}
            <Presence mode="wait">
              {activeTab !== null ? (
                <motion.div
                  key={activeTab.id}
                  className="drawer-body-swap"
                  variants={riseVariants(app)}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  {activeTab.kind === "tracker" ? (
                    <TrackerPanel chatId={props.chatId} />
                  ) : activeTab.kind === "summaries" ? (
                    <SummariesPanel />
                  ) : (
                    <PluginTabPanel chatId={props.chatId} tab={activeTab} />
                  )}
                </motion.div>
              ) : (
                // Loaded-but-empty drawer: the shared empty-state vocabulary
                // (icon + title + hint) rather than a bare caption.
                <motion.div
                  key="empty"
                  className="empty-state drawer-empty"
                  variants={riseVariants(app)}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  <span className="empty-state-icon" aria-hidden="true">
                    <Layers size={22} strokeWidth={1.5} />
                  </span>
                  <span className="empty-state-title">No panels</span>
                  <span className="empty-state-hint">
                    Every tab is hidden — re-show one via the manage menu.
                  </span>
                </motion.div>
              )}
            </Presence>
          </div>
        </motion.section>
      )}
    </Presence>
  );
}
