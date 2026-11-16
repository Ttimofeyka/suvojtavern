/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { basicAuth, isLoopbackHost, lanAddresses, resolveServerConfig } from "./access";

/** Builds a tiny app whose only route reports whether auth let the request through. */
function authApp(username: string, password: string): Hono {
  const app = new Hono();
  app.use("*", basicAuth(username, password));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

/** Encodes Basic credentials the way a browser/curl would. */
function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("isLoopbackHost", () => {
  it("accepts loopback addresses and localhost", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("rejects wildcard, LAN, and public hosts", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});

describe("resolveServerConfig", () => {
  it("defaults to loopback, port 3210, and no auth", () => {
    expect(resolveServerConfig({})).toEqual({
      hostname: "127.0.0.1",
      port: 3210,
      access: { requireAuth: false },
    });
  });

  it("honors PORT and falls back on invalid values", () => {
    expect(resolveServerConfig({ PORT: "8080" }).port).toBe(8080);
    expect(resolveServerConfig({ PORT: "abc" }).port).toBe(3210);
  });

  it("refuses a non-loopback HOST without credentials", () => {
    expect(() => resolveServerConfig({ HOST: "0.0.0.0" })).toThrow(/Refusing to expose/);
  });

  it("refuses credentials that are too short even when exposed", () => {
    expect(() =>
      resolveServerConfig({
        HOST: "0.0.0.0",
        SUVOJ_AUTH_USERNAME: "ab",
        SUVOJ_AUTH_PASSWORD: "longenough",
      }),
    ).toThrow(/SUVOJ_AUTH_USERNAME/);
    expect(() =>
      resolveServerConfig({
        HOST: "0.0.0.0",
        SUVOJ_AUTH_USERNAME: "alice",
        SUVOJ_AUTH_PASSWORD: "short",
      }),
    ).toThrow(/SUVOJ_AUTH_PASSWORD/);
  });

  it("allows a non-loopback HOST with valid credentials", () => {
    const config = resolveServerConfig({
      HOST: "0.0.0.0",
      SUVOJ_AUTH_USERNAME: "alice",
      SUVOJ_AUTH_PASSWORD: "hunter2!!",
    });
    expect(config.hostname).toBe("0.0.0.0");
    expect(config.access).toEqual({
      requireAuth: true,
      username: "alice",
      password: "hunter2!!",
    });
  });

  it("enables auth on loopback when both credentials are set", () => {
    const config = resolveServerConfig({
      SUVOJ_AUTH_USERNAME: "alice",
      SUVOJ_AUTH_PASSWORD: "hunter2!!",
    });
    expect(config.access.requireAuth).toBe(true);
  });

  it("rejects a partial credential pair on loopback", () => {
    expect(() => resolveServerConfig({ SUVOJ_AUTH_USERNAME: "alice" })).toThrow(/both/);
    expect(() => resolveServerConfig({ SUVOJ_AUTH_PASSWORD: "hunter2!!" })).toThrow(/both/);
  });

  it("accepts credentials at the exact minimum length", () => {
    const config = resolveServerConfig({
      SUVOJ_AUTH_USERNAME: "abc",
      SUVOJ_AUTH_PASSWORD: "12345678",
    });
    expect(config.access.requireAuth).toBe(true);
  });

  it("preserves a password containing a colon", () => {
    const config = resolveServerConfig({
      SUVOJ_AUTH_USERNAME: "alice",
      SUVOJ_AUTH_PASSWORD: "pa:ss:word",
    });
    expect(config.access.password).toBe("pa:ss:word");
  });

  it("binds wildcard when SUVOJ_LAN is truthy, with auth", () => {
    const config = resolveServerConfig({
      SUVOJ_LAN: "1",
      SUVOJ_AUTH_USERNAME: "alice",
      SUVOJ_AUTH_PASSWORD: "hunter2!!",
    });
    expect(config.hostname).toBe("0.0.0.0");
    expect(config.access.requireAuth).toBe(true);
  });

  it("refuses SUVOJ_LAN without credentials", () => {
    expect(() => resolveServerConfig({ SUVOJ_LAN: "1" })).toThrow(/Refusing to expose/);
  });

  it("treats falsy SUVOJ_LAN values as disabled", () => {
    for (const value of ["0", "false", "", "  ", "OFF", "No"]) {
      const config = resolveServerConfig({ SUVOJ_LAN: value });
      expect(config.hostname).toBe("127.0.0.1");
      expect(config.access.requireAuth).toBe(false);
    }
  });

  it("lets an explicit HOST win over SUVOJ_LAN", () => {
    const config = resolveServerConfig({ HOST: "127.0.0.1", SUVOJ_LAN: "1" });
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.access.requireAuth).toBe(false);
  });

  it("treats a whitespace-only HOST as unset and falls through to SUVOJ_LAN", () => {
    const config = resolveServerConfig({
      HOST: "   ",
      SUVOJ_LAN: "1",
      SUVOJ_AUTH_USERNAME: "alice",
      SUVOJ_AUTH_PASSWORD: "hunter2!!",
    });
    expect(config.hostname).toBe("0.0.0.0");
  });
});

describe("lanAddresses", () => {
  it("returns unique, sorted private IPv4 addresses", () => {
    const addresses = lanAddresses({
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      eth0: [
        {
          address: "192.168.1.5",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.1.5/24",
        },
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 2,
        },
      ],
      wlan0: [
        {
          address: "10.0.0.7",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "10.0.0.7/8",
        },
        {
          address: "192.168.1.5",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.1.5/24",
        },
      ],
      docker0: [
        {
          address: "172.17.0.1",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.17.0.1/16",
        },
        // Boundary cases for 172.16.0.0/12: the second octet runs 16–31.
        {
          address: "172.16.0.1",
          netmask: "255.240.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.16.0.1/12",
        },
        {
          address: "172.25.0.1",
          netmask: "255.240.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.25.0.1/12",
        },
        {
          address: "172.31.255.254",
          netmask: "255.240.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.31.255.254/12",
        },
      ],
    });
    expect(addresses).toContain("192.168.1.5");
    expect(addresses).toEqual([
      "10.0.0.7",
      "172.16.0.1",
      "172.17.0.1",
      "172.25.0.1",
      "172.31.255.254",
      "192.168.1.5",
    ]);
  });

  it("excludes internal, non-private, and IPv6 addresses", () => {
    const addresses = lanAddresses({
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      eth0: [
        {
          address: "8.8.8.8",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "8.8.8.8/24",
        },
        {
          address: "::1",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "::1/128",
          scopeid: 1,
        },
      ],
      eth1: [
        {
          address: "172.15.0.1",
          netmask: "255.240.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.15.0.1/12",
        },
        {
          address: "172.32.0.1",
          netmask: "255.240.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.32.0.1/12",
        },
        {
          address: "192.169.1.1",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.169.1.1/16",
        },
      ],
    });
    expect(addresses).toEqual([]);
  });

  it("returns an empty array for an empty map", () => {
    expect(lanAddresses({})).toEqual([]);
  });

  it("accepts the legacy numeric IPv4 family form", () => {
    // Older Node/runtimes report `family` as the number 4; that value is
    // outside the typed union, so cast at this one seam.
    const legacyFamily = 4 as unknown as "IPv4";
    const addresses = lanAddresses({
      eth0: [
        {
          address: "192.168.1.5",
          netmask: "255.255.255.0",
          family: legacyFamily,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.1.5/24",
        },
      ],
    });
    expect(addresses).toEqual(["192.168.1.5"]);
  });
});

describe("basicAuth", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await authApp("alice", "hunter2!!").request("/");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic realm=");
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  it("rejects wrong credentials", async () => {
    const res = await authApp("alice", "hunter2!!").request("/", {
      headers: { Authorization: basicHeader("alice", "wrongpass") },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid credentials" });
  });

  it("rejects malformed base64 without throwing", async () => {
    const res = await authApp("alice", "hunter2!!").request("/", {
      headers: { Authorization: "Basic !!!not-base64!!!" },
    });
    expect(res.status).toBe(401);
  });

  it("allows correct credentials through to the downstream handler", async () => {
    const res = await authApp("alice", "hunter2!!").request("/", {
      headers: { Authorization: basicHeader("alice", "hunter2!!") },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("splits on the first colon so passwords may contain colons", async () => {
    const res = await authApp("alice", "pa:ss:word").request("/", {
      headers: { Authorization: basicHeader("alice", "pa:ss:word") },
    });
    expect(res.status).toBe(200);
  });
});
