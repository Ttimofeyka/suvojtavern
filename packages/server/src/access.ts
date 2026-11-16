/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { MiddlewareHandler } from "hono";

/** Minimum accepted length for `SUVOJ_AUTH_USERNAME`. */
export const MIN_USERNAME_LENGTH = 3;
/** Minimum accepted length for `SUVOJ_AUTH_PASSWORD`. */
export const MIN_PASSWORD_LENGTH = 8;

/** Basic-auth policy derived from the environment. */
export interface AccessConfig {
  /** When true, every request requires HTTP Basic Auth. */
  requireAuth: boolean;
  /** Basic-auth credentials; present iff requireAuth is true. */
  username?: string;
  password?: string;
}

/** The bind hostname plus derived access policy. */
export interface ServerConfig {
  hostname: string;
  port: number;
  access: AccessConfig;
}

const BASIC_REALM = 'Basic realm="SuvojTavern", charset="UTF-8"';

/**
 * Values that explicitly disable an opt-in flag. Anything else that is present
 * (e.g. `1`, `true`, `yes`, `on`) enables it; absent stays disabled.
 */
const FALSY_FLAG_VALUES = new Set(["", "0", "false", "no", "off"]);

/**
 * True when `value` is present and not one of the documented falsy strings.
 *
 * NOTE: duplicated (deliberately, no cross-package import) as `lanEnabled` in
 * `packages/web/vite.config.ts`. Keep both in sync with the `SUVOJ_LAN` bullet
 * in `AGENTS.md` ("Server env vars").
 */
function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return !FALSY_FLAG_VALUES.has(value.trim().toLowerCase());
}

/** True for RFC1918 private IPv4 addresses (10/8, 172.16/12 => 172.16–172.31, 192.168/16). */
function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  // 172.16.0.0/12 covers the second octet through 31 inclusive, not 24.
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True when an interface entry is IPv4, accepting both the `"IPv4"` and `4` forms. */
function isIpv4Entry(entry: { family: string | number }): boolean {
  return entry.family === "IPv4" || entry.family === 4;
}

/**
 * Private IPv4 addresses this machine can be reached on over the LAN, for the
 * startup banner. `interfaces` is injectable so tests never read the real host.
 */
export function lanAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || !isIpv4Entry(entry)) {
        continue;
      }
      if (isPrivateIpv4(entry.address)) {
        found.add(entry.address);
      }
    }
  }
  // Stable order keeps the log identical across restarts.
  return [...found].sort();
}

/**
 * True when binding to `host` only reaches the local machine. Anything else
 * (wildcard addresses, LAN/Internet IPs, public hostnames) counts as exposed.
 */
export function isLoopbackHost(host: string): boolean {
  // Brackets are an IPv6 URL/authority notation, not part of the address.
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  // Any 127.0.0.0/8 address is loopback, not just the canonical 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Resolves the bind host/port and auth policy from the environment.
 *
 * Exposing the server beyond loopback is refused unless a username and a
 * sufficiently long password are configured, because an unauthenticated
 * network-exposed instance would leak every stored chat and API key.
 *
 * `SUVOJ_LAN` opts into wildcard binding; an explicit `HOST` always wins.
 */
export function resolveServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const configuredHost = env.HOST?.trim() || undefined;
  // Wildcard binding routes through the same exposure guard as any other
  // non-loopback host, so the credentials check below is unavoidable.
  const hostname = configuredHost ?? (flagEnabled(env.SUVOJ_LAN) ? "0.0.0.0" : "127.0.0.1");
  const port = Number(env.PORT ?? 3210) || 3210;

  // Raw values are preserved (passwords may contain significant spaces and
  // colons); only blank/whitespace-only values are treated as absent.
  const username = present(env.SUVOJ_AUTH_USERNAME);
  const password = present(env.SUVOJ_AUTH_PASSWORD);
  const exposed = !isLoopbackHost(hostname);

  // A present-but-too-short credential is always a misconfiguration, exposed
  // or not; failing fast avoids silently running with a weak secret.
  if (username !== undefined && username.length < MIN_USERNAME_LENGTH) {
    throw new Error(`SUVOJ_AUTH_USERNAME must be at least ${MIN_USERNAME_LENGTH} characters.`);
  }
  if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`SUVOJ_AUTH_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  if (exposed) {
    const missing: string[] = [];
    if (username === undefined) {
      missing.push(`SUVOJ_AUTH_USERNAME (min ${MIN_USERNAME_LENGTH} chars)`);
    }
    if (password === undefined) {
      missing.push(`SUVOJ_AUTH_PASSWORD (min ${MIN_PASSWORD_LENGTH} chars)`);
    }
    if (missing.length > 0) {
      throw new Error(
        `Refusing to expose the server to the network: set ${missing.join(" and ")}.`,
      );
    }
  }

  // Exactly one credential set is a misconfiguration even on loopback: it is
  // almost certainly a forgotten variable, not an intentional policy.
  if ((username === undefined) !== (password === undefined)) {
    throw new Error(
      "Basic auth is partially configured: set both SUVOJ_AUTH_USERNAME and " +
        "SUVOJ_AUTH_PASSWORD, or neither.",
    );
  }

  if (username !== undefined && password !== undefined) {
    return { hostname, port, access: { requireAuth: true, username, password } };
  }
  return { hostname, port, access: { requireAuth: false } };
}

/**
 * HTTP Basic Auth middleware. Credentials are compared with a timing-safe
 * equality so response timing does not reveal the correct username/password.
 */
export function basicAuth(username: string, password: string): MiddlewareHandler {
  // Precompute expected bytes once per middleware instance (not per request).
  const expectedUser = toBytes(username);
  const expectedPass = toBytes(password);

  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined || !header.startsWith("Basic ")) {
      return c.json({ error: "Authentication required" }, 401, { "WWW-Authenticate": BASIC_REALM });
    }

    const credentials = decodeCredentials(header.slice("Basic ".length));
    if (credentials === null) {
      return c.json({ error: "Invalid credentials" }, 401, { "WWW-Authenticate": BASIC_REALM });
    }

    const [user, pass] = credentials;
    // Evaluate both comparisons unconditionally so a wrong username does not
    // short-circuit the password check and leak that fact through timing.
    const userOk = safeEqual(toBytes(user), expectedUser);
    const passOk = safeEqual(toBytes(pass), expectedPass);
    if (!(userOk && passOk)) {
      return c.json({ error: "Invalid credentials" }, 401, { "WWW-Authenticate": BASIC_REALM });
    }

    await next();
  };
}

/** Returns the value unless it is absent or blank, in which case `undefined`. */
function present(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

/**
 * Decodes a Basic Auth payload, splitting on the first colon so passwords may
 * contain colons. Returns null for anything that is not `user:pass` so the
 * caller answers 401 instead of throwing on hostile input.
 */
function decodeCredentials(encoded: string): [string, string] | null {
  // Buffer.from(..., "base64") is lenient and never throws; a payload that
  // decodes to no colon is still malformed and gets rejected below.
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return [decoded.slice(0, separator), decoded.slice(separator + 1)];
}

/**
 * Constant-time string equality. `timingSafeEqual` throws when buffer lengths
 * differ, so mismatched lengths are compared against themselves first (same
 * work, no crash) and then reported unequal.
 */
function safeEqual(candidate: Uint8Array, expected: Uint8Array): boolean {
  if (candidate.length !== expected.length) {
    timingSafeEqual(candidate, candidate);
    return false;
  }
  return timingSafeEqual(candidate, expected);
}

/** UTF-8 bytes as a plain `Uint8Array` (the type `timingSafeEqual` accepts). */
function toBytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, "utf8"));
}
