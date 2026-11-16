/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import MobileNavButton from "../components/MobileNavButton";
import AiGenerationPanel from "../components/settings/AiGenerationPanel";
import AppearancePanel from "../components/settings/AppearancePanel";
import ChatDisplayPanel from "../components/settings/ChatDisplayPanel";
import ConnectionProfiles from "../components/settings/ConnectionProfiles";
import MemoryStrategyPanel from "../components/settings/MemoryStrategyPanel";
import PluginsPanel from "../components/settings/PluginsPanel";
import RegexRulesPanel from "../components/settings/RegexRulesPanel";
import TrackerSettings from "../components/settings/tracker/TrackerSettings";
import type { IconProps } from "../components/ui/icons";
import { Cable, Database, MessageCircle, Moon, SlidersHorizontal } from "../components/ui/icons";
import { Presence } from "../components/ui/presence";
import { INSTANT, riseVariants, useAppMotion } from "../lib/motion";
import "../styles/settings.css";

/** Section ids double as the #hash deep link (e.g. /settings#connections). */
type SectionId = "appearance" | "chat" | "connections" | "memory" | "advanced";

interface SettingsSection {
  id: SectionId;
  label: string;
  icon: ComponentType<IconProps>;
  /** Panel heading and its one-line description (rendered by the shell). */
  title: string;
  desc: string;
}

/**
 * Five task-shaped sections instead of nine peer tabs. Everything that still
 * exists has a home; the long tail is grouped under Advanced rather than
 * removed.
 */
const SECTIONS: readonly SettingsSection[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: Moon,
    title: "Appearance",
    desc: "Theme, reading size, motion, and navigation. Changes apply immediately.",
  },
  {
    id: "chat",
    label: "Chat",
    icon: MessageCircle,
    title: "Chat",
    desc: "How the conversation reads and how a reply streams in.",
  },
  {
    id: "connections",
    label: "Connections",
    icon: Cable,
    title: "Connections",
    desc: "Endpoints, keys, models, and the profile used for chat generation.",
  },
  {
    id: "memory",
    label: "Memory & tracking",
    icon: Database,
    title: "Memory & tracking",
    desc: "How older turns stay in context, and the optional scene snapshot kept across replies.",
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: SlidersHorizontal,
    title: "Advanced",
    desc: "AI generation prompts, regex rules, and plugins.",
  },
];

/**
 * Legacy hash deep links keep working. Each old section now lives inside one
 * of the five task-shaped groups above.
 */
const HASH_ALIASES: Readonly<Record<string, SectionId>> = {
  layout: "appearance",
  profiles: "connections",
  tracker: "memory",
  character: "advanced",
  regex: "advanced",
  plugins: "advanced",
};

function sectionFromHash(hash: string): SectionId {
  const id = hash.replace(/^#/, "");
  const direct = SECTIONS.find((section) => section.id === id);
  return direct?.id ?? HASH_ALIASES[id] ?? "appearance";
}

/** The settings page: section chips switch between the grouped panels. */
export default function Settings() {
  const location = useLocation();
  // The active-tab indicator is a Motion layoutId. Under reduced motion (OS or
  // the appearance knob) it collapses to INSTANT: the fill still moves to the
  // right tab, it just lands in one frame instead of sliding.
  const app = useAppMotion();

  // Deep link: opening /settings#profiles starts on Connections. The hash is
  // read once, at mount — selectSection below drives it from then on via
  // replaceState, and React Router does not re-render on a hash rewrite.
  const [active, setActive] = useState<SectionId>(() => sectionFromHash(location.hash));

  const selectSection = (id: SectionId): void => {
    setActive(id);
    // replaceState keeps the hash shareable without adding history entries.
    history.replaceState(null, "", `#${id}`);
  };

  // The scroll container is `.app-main` (shell.css), not the document, so a
  // tall panel can leave it scrolled past a short one's content. Reset it on
  // every section change — an instant jump, matching the route-change reset.
  const rootRef = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `active` is the section-change trigger; the effect body reads only the ref and the DOM.
  useEffect(() => {
    const scroller = rootRef.current?.closest(".app-main") as HTMLElement | null;
    scroller?.scrollTo({ top: 0 });
  }, [active]);

  // Roving tablist keyboard support: Left/Right wrap, Home/End jump, and the
  // newly selected tab takes focus (the platform gives radio groups this for
  // free; a button-tablist has to forward it).
  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = SECTIONS.findIndex((section) => section.id === active);
    if (currentIndex === -1) {
      return;
    }
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % SECTIONS.length;
        break;
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + SECTIONS.length) % SECTIONS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = SECTIONS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextSection = SECTIONS[nextIndex];
    if (nextSection === undefined) {
      return;
    }
    selectSection(nextSection.id);
    document.getElementById(`settings-tab-${nextSection.id}`)?.focus();
  };

  const renderBody = (id: SectionId): ReactNode => {
    switch (id) {
      case "appearance":
        return <AppearancePanel />;
      case "chat":
        return <ChatDisplayPanel />;
      case "connections":
        return <ConnectionProfiles />;
      case "memory":
        return (
          <>
            <MemoryStrategyPanel />
            <TrackerSettings />
          </>
        );
      case "advanced":
        return (
          <>
            <AiGenerationPanel />
            <RegexRulesPanel />
            <PluginsPanel />
          </>
        );
    }
  };

  /**
   * One panel, keyed by its id so React remounts it on a section change. The
   * header (icon + title + description) is driven by SECTIONS, so every
   * section reads identically. The whole `<Presence mode="wait">` below plays
   * the outgoing panel's `exit` before mounting the incoming one, so a tall →
   * short swap is a crossfade rather than a hard cut (the reduced-motion
   * collapse to INSTANT still applies).
   */
  const renderSection = (section: SettingsSection): ReactNode => {
    const Icon = section.icon;
    return (
      <motion.section
        key={section.id}
        className="panel settings-section"
        role="tabpanel"
        id={`settings-panel-${section.id}`}
        aria-labelledby={`settings-tab-${section.id}`}
        variants={riseVariants(app, 10)}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <header className="settings-head">
          <span className="settings-icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          <div className="settings-head-text">
            <h2>{section.title}</h2>
            <p className="caption settings-desc">{section.desc}</p>
          </div>
        </header>
        {renderBody(section.id)}
      </motion.section>
    );
  };

  const activeSection = SECTIONS.find((section) => section.id === active);

  return (
    // `stack` keeps the shell's `.app-main-content > section.stack` centering
    // contract; `set-stack` supplies the Settings rhythm (it wins the gap,
    // loaded after base.css).
    <section className="stack set-stack" ref={rootRef}>
      <div className="page-header">
        <MobileNavButton />
        <div className="page-heading">
          <h1>Settings</h1>
          <p className="caption page-desc">Everyday choices first; the long tail under Advanced.</p>
        </div>
      </div>

      <div
        className="set-tabs"
        role="tablist"
        aria-label="Settings sections"
        onKeyDown={onTabsKeyDown}
      >
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          const selected = active === section.id;
          // Only the selected tab's panel is mounted (inactive sections render
          // on demand), so aria-controls is set on the selected tab alone — an
          // inactive tab pointing at an unmounted panel is a dangling ref.
          return (
            <button
              type="button"
              role="tab"
              className="set-tab"
              id={`settings-tab-${section.id}`}
              aria-selected={selected}
              aria-controls={selected ? `settings-panel-${section.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectSection(section.id)}
              key={section.id}
            >
              {/* The fill is shared-layout decoration; the aria-selected state
                  above carries the function, so it is safe to hide. It renders
                  only on the active tab, and Motion slides it between tabs. */}
              {selected && (
                <motion.span
                  layoutId="settings-tab-indicator"
                  className="set-tab-indicator"
                  aria-hidden="true"
                  transition={app.reduce ? INSTANT : app.spring.snappy}
                />
              )}
              <Icon size={14} />
              <span className="set-tab-label">{section.label}</span>
            </button>
          );
        })}
      </div>

      <Presence mode="wait">{activeSection !== undefined && renderSection(activeSection)}</Presence>
    </section>
  );
}
