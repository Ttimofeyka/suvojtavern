/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import Sidebar from "./components/Sidebar";
import { cx } from "./lib/cx";
import { useDesign } from "./stores/design";
import { useLayout } from "./stores/layout";
import { useMobileNav } from "./stores/mobile-nav";
import { usePluginThemes } from "./stores/plugin-theme";
import { useTheme } from "./stores/theme";
import CharacterStudio from "./views/CharacterStudio";
import Characters from "./views/Characters";
import Chats from "./views/Chats";
import Lorebooks from "./views/Lorebooks";
import Personas from "./views/Personas";
import Presets from "./views/Presets";
import Settings from "./views/Settings";

/** Root layout: the persistent shell that wraps every route's outlet. */
function Shell() {
  // Hooks run unconditionally on every render, so their order is stable.
  useTheme();
  // Watches the shared plugin list and injects the enabled plugins' theme
  // declarations + global stylesheets, so a stored plugin theme applies on
  // boot without visiting Settings.
  usePluginThemes();
  // Applies the design defaults (data attributes) and hydrates stored
  // appearance on first paint, before Settings → Appearance is ever opened.
  useDesign();
  const { layout } = useLayout();
  const { navOpen, closeNav } = useMobileNav();
  const location = useLocation();

  // The scroll container is `.app-main` (shell.css sets overflow-y: auto), not
  // the document, so navigating away from a long page would otherwise land the
  // incoming route mid-scroll. Reset it on every pathname change; the
  // window.scrollTo is defensive for any layout where the document itself
  // scrolled. Deliberately an instant jump: a route change should start at the
  // top with no travel, and easing it would need a reduced-motion branch.
  const mainRef = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.pathname is the route-change trigger; it is intentionally read only by the dependency list (`mainRef` is a stable ref).
  useEffect(() => {
    if (mainRef.current !== null) {
      mainRef.current.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // Dismiss the mobile drawer whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.pathname is the route-change trigger; it is intentionally read only by the dependency list.
  useEffect(() => {
    closeNav();
  }, [location.pathname, closeNav]);

  // Escape closes the drawer; the listener lives for the shell's lifetime.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeNav();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeNav]);

  return (
    <div
      className={cx(
        "app-shell",
        layout.side === "right" && "sidebar-right",
        layout.side === "top" && "sidebar-top",
        navOpen && "mobile-nav-open",
      )}
    >
      <Sidebar />
      {navOpen && (
        <button
          type="button"
          className="mobile-nav-scrim"
          aria-label="Close navigation"
          onClick={closeNav}
        />
      )}
      <main className="app-main" ref={mainRef}>
        {/* Keyed by pathname so the .page-enter entrance replays on every
            route change, not only the first app paint. Reusing the existing
            element (instead of inserting a wrapper) keeps the
            `.app-main-content > section.stack` centering contract intact.
            Pathname only, so a ?search= update does not remount mid-typing. */}
        <div className="app-main-content page-enter" key={location.pathname}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* One layout route wraps every page, so the shell (and its hooks)
            stays mounted across navigation. */}
        <Route element={<Shell />}>
          <Route index element={<Chats />} />
          <Route path="characters" element={<Characters />} />
          {/* The studio is a full-viewport workspace; it renders its own
              fixed overlay above the shell and returns via its topbar. A card
              ID in the URL opens that character directly, so the Characters
              grid can hand off without a modal. */}
          <Route path="characters/studio" element={<CharacterStudio />} />
          <Route path="characters/studio/:characterId" element={<CharacterStudio />} />
          <Route path="personas" element={<Personas />} />
          <Route path="lorebooks" element={<Lorebooks />} />
          <Route path="presets" element={<Presets />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
