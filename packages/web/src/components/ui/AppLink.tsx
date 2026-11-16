/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * AppLink — internal navigation rendered as a <button>, never an <a href>.
 *
 * Firefox (and some other browsers) paint a bottom-left destination preview
 * whenever the pointer hovers an element that carries an href. That preview
 * cannot be suppressed with CSS, and JS never gets a chance to intercept it —
 * it shows before any handler runs. So a real react-router <Link> leaks the
 * destination of every in-app route into that popup, which reads as a browser
 * artifact on a self-contained app. A <button> has no href, so no preview.
 *
 * It stays a first-class control: a button is natively focusable (Enter/Space
 * activate it), and the app's existing `button:focus-visible` ring applies
 * unchanged. useNavigate keeps the navigation client-side, so the router's
 * history and route transitions behave exactly as they did with <Link>.
 *
 * Styling is the caller's business: pass an existing class (e.g. "btn") or
 * omit it to get `inline-link`, the accent-colored inline prose link that
 * mirrors the global `a` rule.
 */

import type { ReactNode } from "react";
import { useNavigate } from "react-router";

export function AppLink(props: { to: string; className?: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={props.className ?? "inline-link"}
      onClick={() => navigate(props.to)}
    >
      {props.children}
    </button>
  );
}
