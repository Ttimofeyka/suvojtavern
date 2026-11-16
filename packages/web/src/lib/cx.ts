/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Joins the truthy entries of a class list with a single space. The React port
 * of Solid's `classList` binding: callers pass base classes plus `cond && "name"`
 * entries, and falsy slots simply drop out.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}
