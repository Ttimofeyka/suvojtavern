/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clipboard writes that survive an insecure context.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost), so
 * it is `undefined` when a self-hosted Suvoj is opened from a phone over LAN
 * HTTP — the common mobile case. Every copy button therefore goes through
 * `copyText`, which prefers the async Clipboard API and falls back to the
 * legacy `document.execCommand("copy")` path when it is missing or rejects.
 *
 * Browser-only: this module is never imported from core or server.
 */

/**
 * Writes `text` to the clipboard, resolving `true` when a path succeeded and
 * `false` when both paths failed. Never rejects: a caller only needs the
 * boolean to decide whether to show "Copied" feedback.
 *
 * Contract for empty text: it is copied verbatim (the Clipboard API clears the
 * clipboard on `writeText("")`, and the fallback copies an empty selection).
 * Callers that treat "nothing to copy" as a no-op guard their own input —
 * MessageBubble and PromptPreview do; the macros guide's syntax is never empty.
 */
export async function copyText(text: string): Promise<boolean> {
  // Typed as optional even though lib.dom declares `navigator.clipboard`
  // non-optional: the runtime property genuinely is absent outside a secure
  // context, and the annotation keeps this check from reading as dead code.
  const clipboard: Clipboard | undefined =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // A rejected write (permissions, a gesture the browser no longer counts)
      // still gets the fallback below rather than silently dropping the copy.
    }
  }
  try {
    return legacyCopy(text);
  } catch {
    // The fallback is best-effort DOM surgery; any failure is a failed copy,
    // not an error the caller should have to catch.
    return false;
  }
}

/**
 * The pre-Clipboard-API path, and the only one an insecure context has: an
 * off-screen-but-focusable textarea, selected and copied with
 * `document.execCommand("copy")`. The user's focus and selection are captured
 * and restored so the transient textarea does not visibly steal either.
 */
function legacyCopy(text: string): boolean {
  const active = document.activeElement as { focus?: (options?: FocusOptions) => void } | null;
  const selection = typeof document.getSelection === "function" ? document.getSelection() : null;
  // Selection ranges are live: clone them before selecting the textarea, which
  // otherwise collapses them.
  const ranges: Range[] = [];
  if (selection !== null) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  // Off-screen rather than `display: none` / `hidden`: a textarea that is not
  // rendered cannot be selected, and `select()` would then be a no-op.
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  let copied = false;
  try {
    // `preventScroll` because focusing the textarea should not scroll the page
    // to the off-screen corner.
    textarea.focus({ preventScroll: true });
    // `select()` alone misses iOS Safari; `setSelectionRange` selects the text
    // on every mobile browser (and is a no-op-safe range for empty text).
    textarea.setSelectionRange(0, text.length);
    copied = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (selection !== null) {
      selection.removeAllRanges();
      for (const range of ranges) {
        selection.addRange(range);
      }
    }
    if (active !== null && typeof active.focus === "function") {
      active.focus({ preventScroll: true });
    }
  }
  return copied;
}
