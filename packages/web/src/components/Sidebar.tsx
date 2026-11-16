/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ComponentType, CSSProperties } from "react";
import { useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { INSTANT, useAppMotion } from "../lib/motion";
import { pluginIcon } from "../lib/plugin-icons";
import { useMobileNav } from "../stores/mobile-nav";
import { usePlugins } from "../stores/plugins";
import type { IconProps } from "./ui/icons";
import { BookOpen, Drama, MessageCircle, Settings, SlidersHorizontal, User, X } from "./ui/icons";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<IconProps>;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Chats", icon: MessageCircle },
  { href: "/characters", label: "Characters", icon: Drama },
  { href: "/personas", label: "Personas", icon: User },
  { href: "/lorebooks", label: "Lorebooks", icon: BookOpen },
  { href: "/presets", label: "Presets", icon: SlidersHorizontal },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Nav row rendered as a <button> (no href → no browser URL preview on hover).
 *  The vertical rails are permanently icon-only, so each link carries its
 *  label as a tooltip (`tip`); the horizontal top bar shows the labels inline
 *  and therefore passes `tip: false`. */
function SidebarLink(props: {
  href: string;
  icon: ComponentType<IconProps>;
  index: number;
  label: string;
  tip: boolean;
  onClick?: () => void;
}) {
  const app = useAppMotion();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Plugin items may link into a settings section (e.g. `/settings#plugins`),
  // and /characters/studio is a nested surface of the Characters tab, so a
  // direct child path keeps its parent lit. Only the index route needs the "/"
  // guard (a bare startsWith would make it match everything).
  const path = props.href.split("#")[0];
  const isActive =
    props.href === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
  // A stable component reference: `props.icon` never changes identity for a
  // given link (NAV_ITEMS is a constant; plugin icons are memoized), so React
  // reuses the same element type across renders and never remounts the glyph.
  const Icon = props.icon;
  // The icon rail hides the visible label (display:none removes it from the
  // a11y tree), so the link's accessible name is carried explicitly via
  // aria-label; in the top bar the label is visible and this just matches it.
  return (
    <button
      type="button"
      className="nav-link anim-rise"
      style={{ "--stagger-i": props.index } as CSSProperties}
      data-tip={props.tip ? props.label : undefined}
      aria-label={props.label}
      aria-current={isActive ? "page" : undefined}
      onClick={() => {
        // closeNav (props.onClick) runs first — on mobile it closes the drawer
        // before the route swaps underneath.
        props.onClick?.();
        navigate(props.href);
      }}
    >
      {/* One shared-layout element, rendered only on the current link, so the
          selection glides between nav items on route change instead of popping.
          aria-current (set right here) still carries the state, so the
          indicator is decorative. Under reduce it snaps. */}
      {isActive && (
        <motion.span
          layoutId="sidebar-active-indicator"
          className="nav-active-indicator"
          aria-hidden="true"
          transition={app.reduce ? INSTANT : app.spring.snappy}
        />
      )}
      <span className="nav-icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="nav-label">{props.label}</span>
    </button>
  );
}

export default function Sidebar() {
  const { closeNav } = useMobileNav();
  // Every layout now shows the label inline, so a tooltip would only repeat
  // what is already on screen.
  const tip = false;

  // Plugin contributions come from the shared store — the same atoms the
  // Settings panel toggles — so enabling a plugin here updates the sidebar.
  const { plugins, load } = usePlugins();
  useEffect(() => {
    void load();
  }, [load]);

  /** Sidebar links from enabled, healthy plugins (broken ones contribute nothing). */
  const pluginLinks = useMemo(
    () =>
      (plugins ?? [])
        .filter((plugin) => plugin.enabled && plugin.error == null)
        .flatMap((plugin) => plugin.ui?.sidebarItems ?? [])
        .map((item) => ({ ...item, icon: pluginIcon(item.icon) })),
    [plugins],
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-brand row anim-rise">
        <span className="brand-mark" aria-hidden="true">
          <img src="/logo.png" alt="" className="brand-logo" />
        </span>
        <span className="sidebar-title">SuvojTavern</span>
        <button
          type="button"
          className="btn btn-icon sidebar-close"
          aria-label="Close navigation"
          onClick={closeNav}
        >
          <X />
        </button>
      </div>

      <nav className="sidebar-nav stack" aria-label="Main">
        {NAV_ITEMS.map((item, index) => (
          <SidebarLink
            key={item.href}
            href={item.href}
            icon={item.icon}
            index={index + 1}
            label={item.label}
            tip={tip}
            onClick={closeNav}
          />
        ))}
        {pluginLinks.length > 0 && (
          <div className="sidebar-plugins">
            <span className="nav-label sidebar-plugins-label">Plugins</span>
            {pluginLinks.map((item, index) => (
              <SidebarLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                index={index + NAV_ITEMS.length + 1}
                label={item.label}
                tip={tip}
                onClick={closeNav}
              />
            ))}
          </div>
        )}
      </nav>
    </aside>
  );
}
