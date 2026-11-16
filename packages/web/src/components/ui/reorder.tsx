/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * ReorderableList — Motion-driven drag-to-reorder with a keyboard escape hatch.
 *
 * This is the replacement for the HTML5 drag-and-drop the editors use today
 * (draggable + onDragStart/onDrop + a hand-rolled index swap). HTML5 DnD is
 * pointer-only, has no touch support, and renders no drag preview of the row
 * itself — so it is clunky on touch and invisible to keyboard users. Motion's
 * Reorder gives a live layout animation for free; this wrapper adds the two
 * things Reorder does not:
 *
 *   1. a dedicated drag grip. `dragListener={false}` makes the whole row inert
 *      to drags and routes them through a `useDragControls` handle on the grip,
 *      so a click on a row's own controls never starts a drag.
 *   2. move buttons. Drag is pointer-only by nature, so each row ships "Move
 *      up"/"Move down" buttons — the keyboard/AT path to the same reorder. The
 *      grip itself is removed from the tab order (tabIndex -1): it is a pointer
 *      affordance, and the buttons already expose the function.
 *
 * The caller owns the array and applies `onReorder`; the component never
 * mutates `items`.
 */

import { Reorder, useDragControls } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { cx } from "../../lib/cx";
import type { AppMotion } from "../../lib/motion";
import { INSTANT, useAppMotion } from "../../lib/motion";
import { ChevronDown, ChevronUp, GripVertical } from "./icons";

export interface ReorderableListProps<T> {
  /** Current order. Mutable array: Reorder.Group's `values` type is `T[]`. */
  items: T[];
  /** Receives the reordered copy; the caller decides what to do with it. */
  onReorder: (items: T[]) => void;
  /** Stable identity per item — required by React keys and Motion layout. */
  getKey: (item: T) => string;
  /** Renders a row's content (everything except the grip and move buttons). */
  children: (item: T, index: number) => ReactNode;
  /** Accessible name for the list. */
  ariaLabel?: string;
  className?: string;
}

export function ReorderableList<T>({
  items,
  onReorder,
  getKey,
  children,
  ariaLabel,
  className,
}: ReorderableListProps<T>): ReactElement {
  const app = useAppMotion();

  // Pure index swap; the caller's onReorder commits the copy.
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= items.length) {
      return;
    }
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    if (moved === undefined) {
      return;
    }
    next.splice(to, 0, moved);
    onReorder(next);
  };

  return (
    <Reorder.Group
      as="ul"
      axis="y"
      values={items}
      onReorder={onReorder}
      className={cx("reorder-list", className)}
      aria-label={ariaLabel}
      // The layout transition is what animates the rows into their new slots
      // after a drop/button move; under reduced motion it snaps.
      transition={app.reduce ? INSTANT : app.spring.soft}
    >
      {items.map((item, index) => (
        <ReorderRow
          key={getKey(item)}
          value={item}
          index={index}
          total={items.length}
          onMove={move}
          app={app}
        >
          {children(item, index)}
        </ReorderRow>
      ))}
    </Reorder.Group>
  );
}

interface ReorderRowProps<T> {
  value: T;
  index: number;
  total: number;
  onMove: (from: number, to: number) => void;
  app: AppMotion;
  children: ReactNode;
}

/**
 * One row. Split out because `useDragControls` is a hook and must run once per
 * item, not once per list.
 */
function ReorderRow<T>({
  value,
  index,
  total,
  onMove,
  app,
  children,
}: ReorderRowProps<T>): ReactElement {
  const controls = useDragControls();

  return (
    <Reorder.Item
      as="li"
      value={value}
      dragListener={false}
      dragControls={controls}
      className="reorder-item"
      transition={app.reduce ? INSTANT : app.spring.soft}
      // A drag is a physical gesture, so the row lifts slightly while held.
      whileDrag={app.reduce ? undefined : { scale: 1.01 }}
    >
      <button
        type="button"
        className="btn btn-icon reorder-grip"
        aria-label="Drag to reorder"
        tabIndex={-1}
        onPointerDown={(event) => controls.start(event)}
      >
        <GripVertical size={16} />
      </button>
      <div className="reorder-body">{children}</div>
      <div className="reorder-actions">
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Move up"
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Move down"
          disabled={index === total - 1}
          onClick={() => onMove(index, index + 1)}
        >
          <ChevronDown size={16} />
        </button>
      </div>
    </Reorder.Item>
  );
}
