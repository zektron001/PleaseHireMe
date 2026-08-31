/**
 * The banner is the whole user interface of the multi-computer demo: if it
 * prints a URL that does not work, the demo fails in front of people. So the
 * rule under test is narrow and absolute - never print an address that cannot
 * reach this process.
 */

import { describe, expect, it } from "vitest";
import {
  isMisconfiguredMulti,
  lanAddresses,
  mdnsHostname,
  reachableUrls,
  startupBanner,
} from "./lan.js";

const iface = (address: string, internal = false) => ({
  address,
  family: "IPv4",
  internal,
});

describe("the mDNS name", () => {
  it("is the short hostname, lowercased, with .local", () => {
    expect(mdnsHostname("MacBook-Pro")).toBe("macbook-pro.local");
  });

  it("drops a domain the OS already appended, rather than doubling it", () => {
    expect(mdnsHostname("box.lan")).toBe("box.local");
    expect(mdnsHostname("box.local")).toBe("box.local");
  });

  it("claims nothing for a hostname that is not a legal mDNS label", () => {
    expect(mdnsHostname("")).toBeNull();
    expect(mdnsHostname("_weird_")).toBeNull();
    expect(mdnsHostname("-leading")).toBeNull();
  });
});

describe("the addresses other computers could use", () => {
  it("keeps external IPv4 and drops loopback", () => {
    expect(
      lanAddresses({
        lo: [iface("127.0.0.1", true)],
        eth0: [iface("192.168.1.20")],
      }),
    ).toEqual(["192.168.1.20"]);
  });

  it("accepts the numeric family older Node reports", () => {
    const legacy = { eth0: [{ address: "10.0.0.5", family: 4 as never, internal: false }] };
    expect(lanAddresses(legacy)).toEqual(["10.0.0.5"]);
  });

  it("does not repeat an address reported on two interfaces", () => {
    expect(
      lanAddresses({ eth0: [iface("192.168.1.20")], wlan0: [iface("192.168.1.20")] }),
    ).toEqual(["192.168.1.20"]);
  });
});

describe("single mode promises only what loopback can deliver", () => {
  it("offers localhost and no network address at all", () => {
    const urls = reachableUrls({
      demoMode: "single",
      host: "127.0.0.1",
      port: 3000,
      hostname: "box",
      interfaces: { eth0: [iface("192.168.1.20")] },
    });
    expect(urls.map((u) => u.url)).toEqual(["http://localhost:3000"]);
  });

  it("still offers only localhost even when bound to every interface", () => {
    // Someone set HOST=0.0.0.0 but left the mode alone. The mode is the
    // promise being made to the operator; do not advertise beyond it.
    const urls = reachableUrls({
      demoMode: "single",
      host: "0.0.0.0",
      port: 3000,
      hostname: "box",
      interfaces: { eth0: [iface("192.168.1.20")] },
    });
    expect(urls.map((u) => u.url)).toEqual(["http://localhost:3000"]);
  });
});

describe("multi mode leads with the name a teammate can type", () => {
  const input = {
    demoMode: "multi" as const,
    host: "0.0.0.0",
    port: 3003,
    hostname: "MacBook-Pro",
    interfaces: { lo: [iface("127.0.0.1", true)], en0: [iface("192.168.1.20")] },
  };

  it("puts the .local name first, then the raw IP as the fallback", () => {
    expect(reachableUrls(input).map((u) => u.url)).toEqual([
      "http://macbook-pro.local:3003",
      "http://192.168.1.20:3003",
      "http://localhost:3003",
    ]);
  });

  it("says out loud that mDNS needs Bonjour or Avahi", () => {
    expect(reachableUrls(input)[0]?.caveat).toMatch(/Bonjour|Avahi/);
  });

  it("falls back to IP alone when the hostname cannot be an mDNS label", () => {
    const urls = reachableUrls({ ...input, hostname: "_nope_" });
    expect(urls.map((u) => u.url)).toEqual([
      "http://192.168.1.20:3003",
      "http://localhost:3003",
    ]);
  });

  it("advertises nothing beyond localhost when the socket is on loopback", () => {
    // multi was asked for, but HOST=127.0.0.1 overrode it. Printing the
    // .local URL here would send a teammate to a connection refused.
    const urls = reachableUrls({ ...input, host: "127.0.0.1" });
    expect(urls.map((u) => u.url)).toEqual(["http://localhost:3003"]);
  });
});

describe("the contradiction is reported rather than hidden", () => {
  it("flags multi mode bound to loopback", () => {
    expect(isMisconfiguredMulti("multi", "127.0.0.1")).toBe(true);
    expect(isMisconfiguredMulti("multi", "0.0.0.0")).toBe(false);
    expect(isMisconfiguredMulti("single", "127.0.0.1")).toBe(false);
  });

  it("puts the warning in the banner where it cannot be missed", () => {
    const banner = startupBanner({
      demoMode: "multi",
      host: "127.0.0.1",
      port: 3003,
      hostname: "box",
      interfaces: {},
    }).join("\n");
    expect(banner).toContain("DEMO_MODE=multi but HOST=127.0.0.1");
  });

  it("keeps every line inside the border, however long the hostname", () => {
    const lines = startupBanner({
      demoMode: "multi",
      host: "0.0.0.0",
      port: 3003,
      hostname: "a".repeat(120),
      interfaces: { en0: [iface("192.168.1.20")] },
    });
    const widths = new Set(lines.filter((l) => l.startsWith("│")).map((l) => [...l].length));
    expect(widths.size, "every boxed line is the same width").toBe(1);
  });

  it("tells a single-mode operator how to reach the other mode", () => {
    const banner = startupBanner({
      demoMode: "single",
      host: "127.0.0.1",
      port: 3000,
      hostname: "box",
      interfaces: {},
    }).join("\n");
    expect(banner).toContain("DEMO_MODE=multi");
  });
});
