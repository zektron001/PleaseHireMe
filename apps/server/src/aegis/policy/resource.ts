/**
 * Canonical resource forms and the predicates the rule bundle is written over.
 *
 * Rules are expressed over ACTIONS and RESOURCES, never over prompt keywords.
 * That is what makes them enforceable rather than advisory, and it is why every
 * function here is total and pure.
 */

import path from "node:path";

export const FILE_PREFIX = "file:";
export const NET_PREFIX = "net:";

export function fileResource(absolutePath: string): string {
  return FILE_PREFIX + canonical(absolutePath);
}

export function netResource(host: string, port: number): string {
  return NET_PREFIX + host.toLowerCase() + ":" + String(port);
}

/** Normalises a path and resolves `..` without touching the filesystem. */
export function canonical(input: string): string {
  const normalised = path.posix.normalize(input.replace(/\\/g, "/"));
  return normalised.length > 1 && normalised.endsWith("/")
    ? normalised.slice(0, -1)
    : normalised;
}

export function pathOf(resource: string): string | null {
  return resource.startsWith(FILE_PREFIX)
    ? canonical(resource.slice(FILE_PREFIX.length))
    : null;
}

export function hostOf(resource: string): string | null {
  if (!resource.startsWith(NET_PREFIX)) return null;
  const rest = resource.slice(NET_PREFIX.length);
  const colon = rest.lastIndexOf(":");
  return (colon === -1 ? rest : rest.slice(0, colon)).toLowerCase();
}

/** True when `child` is inside `parent`, with no `..` escape. */
export function isInside(parent: string, child: string): boolean {
  const p = canonical(parent);
  const c = canonical(child);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

const PRIVATE_V4: readonly [number, number, number][] = [
  // [firstOctet, secondOctetLow, secondOctetHigh]; -1 means "any second octet"
  [10, -1, -1],
  [127, -1, -1],
  [172, 16, 31],
  [192, 168, 168],
  [169, 254, 254],
  [100, 64, 127], // CGNAT - covers the Volcengine metadata address 100.96.0.96
  [0, -1, -1],
];

function parseV4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * KS-1 - closes SSRF to the cloud metadata service and to anything on the host
 * network. Applied AFTER DNS resolution as well as before, which is what
 * narrows the rebinding window (RR-7).
 */
export function isPrivateOrLinkLocal(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");

  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "metadata" || name.startsWith("metadata.")) return true;

  // IPv6
  if (name === "::1" || name === "::") return true;
  if (name.startsWith("fe80:") || name.startsWith("fc") || name.startsWith("fd")) {
    return name.includes(":");
  }

  const octets = parseV4(name);
  if (!octets) return false;
  const [first, second] = octets as [number, number, number, number];
  for (const [a, lo, hi] of PRIVATE_V4) {
    if (first !== a) continue;
    if (lo === -1) return true;
    if (second >= lo && second <= hi) return true;
  }
  return false;
}

/** Extracts network destinations named anywhere in a command string. */
export function destinationsIn(command: string): { host: string; port: number }[] {
  const found = new Map<string, { host: string; port: number }>();

  for (const match of command.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/([^/\s"']+)/gi)) {
    const scheme = (match[1] ?? "").toLowerCase();
    const authority = match[2] ?? "";
    const hostPort = authority.split("@").pop() ?? authority;
    const colon = hostPort.lastIndexOf(":");
    const hasPort = colon > -1 && /^\d+$/.test(hostPort.slice(colon + 1));
    const host = (hasPort ? hostPort.slice(0, colon) : hostPort).toLowerCase();
    if (!host) continue;
    const port = hasPort
      ? Number(hostPort.slice(colon + 1))
      : scheme === "https"
        ? 443
        : scheme === "http"
          ? 80
          : 0;
    found.set(host + ":" + String(port), { host, port });
  }

  // bare host:port, as used by nc / telnet / bash /dev/tcp
  for (const match of command.matchAll(
    /(?<![\w/:.-])((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[a-z0-9-]+(?:\.[a-z0-9-]+)+))\s*[:/]\s*(\d{2,5})\b/gi,
  )) {
    const host = (match[1] ?? "").toLowerCase();
    const port = Number(match[2]);
    if (!host || !Number.isFinite(port)) continue;
    found.set(host + ":" + String(port), { host, port });
  }

  return [...found.values()];
}

/** Extracts absolute filesystem paths named anywhere in a command string. */
export function pathsIn(command: string): string[] {
  const found = new Set<string>();
  for (const match of command.matchAll(/(?<![\w:/])(\/[A-Za-z0-9._~@/-]{1,200})/g)) {
    const raw = match[1];
    if (!raw || raw === "/") continue;
    found.add(canonical(raw.replace(/[.,;:'")\]]+$/, "")));
  }
  return [...found];
}
