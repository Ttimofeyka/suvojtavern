/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModalCloseContext, useModalClose } from "./Modal";

/*
 * The Modal component itself needs a DOM (portal, focus, Motion), so it is not
 * rendered here. What these tests pin down is the useModalClose CONTRACT that
 * later batches depend on: it throws outside a modal, returns the provider's
 * close inside one, and resolves to the NEAREST provider when modals nest.
 * The provider is rendered directly (it is exported for exactly this) so the
 * check stays hermetic — no portal, no DOM.
 */

function Probe(): null {
  useModalClose();
  return null;
}

describe("useModalClose", () => {
  it("throws when called outside any <Modal> descendant", () => {
    expect(() => renderToStaticMarkup(createElement(Probe))).toThrow(/inside a <Modal>/);
  });

  it("returns the enclosing provider's close function", () => {
    const calls: string[] = [];
    const close = (): void => {
      calls.push("close");
    };
    let resolved: (() => void) | null = null;
    function Consumer(): null {
      resolved = useModalClose();
      return null;
    }

    renderToStaticMarkup(
      createElement(ModalCloseContext.Provider, { value: close }, createElement(Consumer)),
    );

    expect(resolved).toBe(close);
    // The captured handle is the one that actually closes the modal.
    resolved?.();
    expect(calls).toEqual(["close"]);
  });

  it("resolves to the NEAREST enclosing modal when providers nest", () => {
    const calls: string[] = [];
    const outer = (): void => {
      calls.push("outer");
    };
    const inner = (): void => {
      calls.push("inner");
    };
    let resolved: (() => void) | null = null;
    function Consumer(): null {
      resolved = useModalClose();
      return null;
    }

    // Mirrors a real stack: a lorebook editor modal (outer) whose body renders
    // an entry editor modal (inner). A consumer inside the inner body must get
    // the inner close, not the outer one.
    renderToStaticMarkup(
      createElement(
        ModalCloseContext.Provider,
        { value: outer },
        createElement(ModalCloseContext.Provider, { value: inner }, createElement(Consumer)),
      ),
    );

    expect(resolved).toBe(inner);
    resolved?.();
    expect(calls).toEqual(["inner"]);
  });
});
