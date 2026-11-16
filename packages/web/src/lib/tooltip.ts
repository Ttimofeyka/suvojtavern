/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Global `data-tip` tooltip controller.
 *
 * The old CSS-only tooltip rendered `attr(data-tip)` in an ::after pill
 * centered on its anchor — which clipped off-screen whenever the anchor sat
 * near a viewport edge (the persona picker on the left, "Previous swipe"
 * and "Hide chats" on the right). This module mounts ONE tooltip element on
 * <body> and positions it in fixed coordinates, so it can see — and stay
 * inside — the viewport.
 *
 * Everything is delegated from the document, so `data-tip` stays a
 * zero-touch API: any element, whenever it is added, gets a tooltip, and
 * nothing needs registration or cleanup when it goes away.
 */

/** Anchor-to-tooltip gap; mirrors the old `calc(100% + 6px)`. */
const GAP = 6;
/** Minimum distance kept between the tooltip and the viewport edges. */
const MARGIN = 8;
/**
 * Mouse hover dwell before a tip appears. Sweeping the cursor across the UI
 * brushes every control on the way; only a deliberate pause is intent, so
 * gate the reveal behind a full second of hover. Keyboard focus is NOT
 * delayed — tabbing is already intentional navigation.
 */
const HOVER_DELAY = 1000;

/** The singleton tooltip element; null until mountTooltip() runs. */
let tooltip: HTMLElement | null = null;
/** The [data-tip] element the tooltip currently describes. */
let anchor: Element | null = null;
/** The anchor a hover timer is ticking for; null when no hover is pending. */
let pendingAnchor: Element | null = null;
/** The pending hover timer; null when nothing is scheduled. */
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Mounts the tooltip element and its document-level listeners. Idempotent;
 * call once at startup (index.tsx does).
 */
export function mountTooltip(): void {
  if (tooltip !== null) {
    return;
  }
  const el = document.createElement("div");
  el.className = "tooltip";
  el.setAttribute("role", "tooltip");
  document.body.appendChild(el);
  tooltip = el;

  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("keydown", onKeyDown, true);
  // Scroll doesn't bubble, but a capturing document listener still sees
  // every scroller; passive because hiding never needs preventDefault.
  document.addEventListener("scroll", hide, { capture: true, passive: true });
  window.addEventListener("resize", hide);
  // Bubble phase: component click handlers run first, so a click that
  // navigates or toggles the anchor is already processed before we hide.
  // Hiding is unconditional and order-agnostic, but bubble keeps the click
  // feeling instantaneous rather than pre-empting the handler.
  document.addEventListener("click", onDocClick);
}

function onPointerOver(event: PointerEvent): void {
  // Touch has no hover: a tap's synthetic "over" — and the sticky hover mobile
  // browsers keep afterwards — must never raise a tooltip; the button's own
  // click action is the feedback. Any tooltip left over from a mouse hover is
  // stale once a finger takes over, so drop it.
  if (event.pointerType === "touch") {
    hide();
    return;
  }
  const next = tipAnchor(event.target);
  if (next !== null) {
    // Already describing this anchor, or its hover timer is already ticking:
    // moving from a button onto its own child <span> fires pointerover again
    // for the same [data-tip] ancestor. Restarting the timer there would let
    // internal jitter keep pushing the reveal out forever.
    if (next === anchor || next === pendingAnchor) {
      return;
    }
    // Arm the dwell timer rather than showing now; a sustained hover is what
    // calls show() below.
    cancelPendingHover();
    pendingAnchor = next;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      const target = pendingAnchor;
      pendingAnchor = null;
      // The anchor may have left the DOM during the delay (async update,
      // route change): never show a tip for a detached node.
      if (target?.isConnected) {
        show(target);
      }
    }, HOVER_DELAY);
    return;
  }
  // No [data-tip] target under the pointer while a tooltip shows or a hover is
  // pending: drop both. The normal move-off case is already handled by
  // onPointerOut — hiding again here is idempotent — but pointerout never
  // fires for an anchor that was REMOVED from the DOM (async update, route
  // change), so without this the tooltip would linger until the next click.
  hide();
}

function onPointerOut(event: PointerEvent): void {
  const current = anchor ?? pendingAnchor;
  if (current === null) {
    return;
  }
  // Moves between the anchor's own children keep the tooltip up (and keep a
  // pending hover on the same anchor armed).
  const to = event.relatedTarget;
  if (to instanceof Node && current.contains(to)) {
    return;
  }
  hide();
}

function onFocusIn(event: FocusEvent): void {
  // Keyboard focus only: mouse clicks focus buttons too, and a tooltip
  // popping up under the pointer then would be noise. This mirrors the
  // old [data-tip]:focus-visible rule.
  const target = event.target;
  if (!(target instanceof Element) || !target.matches(":focus-visible")) {
    return;
  }
  const next = tipAnchor(target);
  if (next !== null) {
    show(next);
  }
}

function onFocusOut(event: FocusEvent): void {
  const current = anchor ?? pendingAnchor;
  if (current === null) {
    return;
  }
  const to = event.relatedTarget;
  if (to instanceof Node && current.contains(to)) {
    return;
  }
  hide();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    hide();
  }
}

function onDocClick(): void {
  // A click is intent to ACT, not to read the hint: hide the tip. pointerover
  // won't re-fire while the cursor stays put, so the tip stays gone until the
  // pointer leaves and returns. No tip is shown here, so an anchor that drops
  // its data-tip on click (e.g. a control that swaps its tooltip text once
  // toggled) is handled for free — bubble phase (see mountTooltip) lets
  // component handlers mutate first.
  hide();
}

/** The nearest [data-tip] ancestor of an event target, if any. */
function tipAnchor(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest("[data-tip]") : null;
}

/** Shows the tooltip for `next`; an empty data-tip hides it instead. */
function show(next: Element): void {
  // This is the single "reveal now" path — keyboard focus calls it directly,
  // bypassing HOVER_DELAY. Any hover timer still ticking belongs to another
  // anchor (or this one, already revealed): drop it so it can't fire later.
  cancelPendingHover();
  const text = next.getAttribute("data-tip")?.trim() ?? "";
  if (text === "" || tooltip === null) {
    hide();
    return;
  }
  anchor = next;
  tooltip.textContent = text;
  place();
  tooltip.dataset.show = "";
}

/** Drops a pending hover show (timer + anchor); safe to call when idle. */
function cancelPendingHover(): void {
  if (hoverTimer !== null) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  pendingAnchor = null;
}

function hide(): void {
  cancelPendingHover();
  anchor = null;
  tooltip?.removeAttribute("data-show");
}

/**
 * Viewport-aware placement.
 *
 * Preferred spot: horizontally centered above the anchor — the classic
 * look — flipping below when there is no vertical room above. The centered
 * X is clamped into the viewport with a MARGIN; when clamping would shift
 * the tooltip more than half its width (an edge-hugging anchor, e.g. an icon
 * in the sidebar rail), it flanks the anchor instead: to its right in the
 * left half of the viewport, to its left in the right half, vertically
 * centered on it.
 */
function place(): void {
  if (tooltip === null || anchor === null) {
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const box = tooltip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minLeft = MARGIN;
  const maxLeft = vw - MARGIN - box.width;
  const minY = MARGIN;
  const maxY = Math.max(vh - MARGIN - box.height, MARGIN);
  const clampX = (x: number): number => Math.min(Math.max(x, minLeft), maxLeft);
  const clampY = (y: number): number => Math.min(Math.max(y, minY), maxY);

  let left = rect.left + (rect.width - box.width) / 2;
  const clamped = clampX(left);
  let top: number;

  if (Math.abs(clamped - left) > box.width / 2) {
    const leftHalf = rect.left + rect.width / 2 < vw / 2;
    left = clampX(leftHalf ? rect.right + GAP : rect.left - GAP - box.width);
    top = clampY(rect.top + (rect.height - box.height) / 2);
  } else {
    left = clamped;
    if (rect.top - GAP - MARGIN >= box.height) {
      top = rect.top - GAP - box.height; // above
    } else {
      top = clampY(rect.bottom + GAP); // below when there's no room above
    }
  }

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}
