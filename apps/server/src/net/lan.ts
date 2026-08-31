/**
 * Where this server can be reached from, and how to say so out loud.
 *
 * The multi-computer demo uses **mDNS** rather than a tunnel or a hardcoded IP:
 * every macOS machine (Bonjour) and every Linux machine running Avahi already
 * answers to `<hostname>.local` on the local network, with no daemon of ours,
 * no dependency, and no external service. So "implementing mDNS" here is not
 * implementing a protocol - the OS already speaks it. It is:
 *
 *   1. binding to every interface instead of loopback, so the answer the OS
 *      gives actually leads somewhere, and
 *   2. telling the operator the exact URL to hand their teammates.
 *
 * Point 2 is the part that is usually missing. A server that prints
 * `listening on 0.0.0.0:3003` has told you nothing you can send to anyone.
 *
 * Everything here is a pure function of values the caller resolves, so the
 * banner can be tested without a network, a hostname, or a real interface.
 */

/** One reachable address, and how much to trust it. */
export interface Reachable {
  readonly url: string;
  readonly label: string;
  /** mDNS depends on Bonjour/Avahi being present on BOTH machines. */
  readonly caveat?: string;
}

/**
 * `<hostname>.local`, the name Bonjour and Avahi answer to.
 *
 * `os.hostname()` may already carry a domain (`box.lan`, `box.local`) or be
 * uppercase; mDNS names are the short label, lowercased.
 */
export function mdnsHostname(rawHostname: string): string | null {
  const short = rawHostname.trim().split(".")[0]?.toLowerCase() ?? "";
  // mDNS labels are letters, digits and hyphens. A hostname that is not a legal
  // label (or is empty) gets no claim made about it.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(short)) return null;
  return short + ".local";
}

/** Non-internal IPv4 addresses, in the order the OS reported their interfaces. */
export function lanAddresses(
  interfaces: Record<string, readonly { address: string; family: string; internal: boolean }[] | undefined>,
): string[] {
  const found: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // Node reports family as "IPv4" (>=18) or 4 (older); accept both shapes.
      const isV4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (isV4 && !entry.internal && !found.includes(entry.address)) {
        found.push(entry.address);
      }
    }
  }
  return found;
}

export interface ReachInput {
  readonly demoMode: "single" | "multi";
  readonly host: string;
  readonly port: number;
  readonly hostname: string;
  readonly interfaces: Record<
    string,
    readonly { address: string; family: string; internal: boolean }[] | undefined
  >;
}

/**
 * Every URL that actually reaches this server, best first.
 *
 * In `single` mode that is loopback and nothing else - which is the honest
 * answer, because the socket is bound to loopback and no other address leads
 * to it however the network is configured.
 */
export function reachableUrls(input: ReachInput): Reachable[] {
  const { demoMode, host, port, hostname, interfaces } = input;
  const local: Reachable = {
    url: "http://localhost:" + port,
    label: "this computer",
  };
  if (demoMode === "single") return [local];

  const out: Reachable[] = [];
  const mdns = mdnsHostname(hostname);
  if (mdns) {
    out.push({
      url: "http://" + mdns + ":" + port,
      label: "other computers (mDNS)",
      caveat: "needs Bonjour (macOS) or Avahi (Linux) on both machines",
    });
  }
  for (const address of lanAddresses(interfaces)) {
    out.push({ url: "http://" + address + ":" + port, label: "other computers (IP)" });
  }
  out.push(local);

  // Bound to loopback but asked for multi: say so rather than printing URLs
  // that cannot work. The caller decides what to do about it.
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
    return [local];
  }
  return out;
}

/** True when multi mode was asked for but the socket cannot serve it. */
export function isMisconfiguredMulti(demoMode: string, host: string): boolean {
  return (
    demoMode === "multi" && ["127.0.0.1", "::1", "localhost"].includes(host)
  );
}

/**
 * The block printed once at startup. Deliberately loud: the single most common
 * failure in a multi-machine demo is not knowing which URL to send.
 */
export function startupBanner(input: ReachInput): string[] {
  const targets = reachableUrls(input);
  const width = 68;
  const rule = "─".repeat(width);
  const lines: string[] = [
    "",
    "┌" + rule + "┐",
    pad("  DEMO_MODE=" + input.demoMode + "  " + modeSummary(input.demoMode), width),
    "├" + rule + "┤",
  ];
  for (const target of targets) {
    lines.push(pad("  " + target.url + "   (" + target.label + ")", width));
    if (target.caveat) lines.push(pad("    ↳ " + target.caveat, width));
  }
  if (isMisconfiguredMulti(input.demoMode, input.host)) {
    lines.push("├" + rule + "┤");
    lines.push(pad("  ⚠ DEMO_MODE=multi but HOST=" + input.host + " (loopback).", width));
    lines.push(pad("    No other computer can reach this. Unset HOST.", width));
  }
  if (input.demoMode === "single") {
    lines.push("├" + rule + "┤");
    lines.push(pad("  For other computers: DEMO_MODE=multi (see README)", width));
  }
  lines.push("└" + rule + "┘", "");
  return lines;
}

function modeSummary(demoMode: string): string {
  return demoMode === "multi" ? "— reachable across the network" : "— this computer only";
}

/**
 * One boxed line. Truncates rather than overflowing: a long hostname must not
 * be able to break the border, which is the only thing making this readable.
 */
function pad(text: string, width: number): string {
  const glyphs = [...text];
  const body =
    glyphs.length > width ? glyphs.slice(0, width - 1).join("") + "…" : text;
  return "│" + body + " ".repeat(Math.max(0, width - [...body].length)) + "│";
}
