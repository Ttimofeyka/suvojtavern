/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import { Component } from "react";

interface ErrorBoundaryProps {
  /**
   * Renders in place of the crashed subtree. The `reset` callback clears the
   * caught error and retries the children — the same pair Solid's
   * `<ErrorBoundary fallback={(err, reset) => …}>` hands to its fallback.
   */
  fallback: (error: Error, reset: () => void) => ReactNode;
  children?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React's error boundary requires a class component — there is no hook
 * equivalent — so this is the one class in the app. The public API mirrors the
 * Solid component it replaces: a single `fallback` render prop.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}
