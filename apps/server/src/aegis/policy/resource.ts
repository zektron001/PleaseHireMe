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

/**
 * Removes here-document BODIES from a command string, keeping everything else.
 *
 * `cat > out.ts << 'EOF' … EOF` is one command whose payload is FILE CONTENT,
 * not an invocation. Scanning that payload for paths and hosts is a category
 * error, and a damaging one: an Agent writing a TypeScript file that mentions
 * `http://collector:4317` was contained for "a network destination that is not
 * allowlisted", and one writing a test that mentions `/etc/config` for
 * "filesystem access outside the Agent workspace". Neither had opened a socket
 * or touched a file outside its workspace; both were killed mid-run.
 *
 * What survives the strip is everything that actually acts: the command name,
 * its flags, and the redirect target. So `cat > /etc/passwd << EOF` is still
 * refused on `/etc/passwd`, and a real `curl` to a blocked host is still
 * refused - only the inert body between the delimiters is dropped.
 */
export function stripHeredocs(command: string): string {
  // The delimiter may be quoted (`<< 'EOF'`, `<< "EOF"`) or bare (`<<EOF`),
  // and `<<-` allows leading tabs on the terminator.
  const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let result = command;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(result)) !== null) {
    const delimiter = match[2];
    if (!delimiter) continue;
    const bodyStart = match.index + match[0].length;
    const terminator = new RegExp("^[ \\t]*" + delimiter + "[ \\t]*$", "m");
    const rest = result.slice(bodyStart);
    const end = terminator.exec(rest);
    // An unterminated heredoc means the rest of the string is body. Dropping it
    // is the safe direction here: the acting part of the command is before it.
    const cut = end ? bodyStart + end.index + end[0].length : result.length;
    result = result.slice(0, bodyStart) + " " + result.slice(cut);
    opener.lastIndex = bodyStart;
  }
  return result;
}

/**
 * Extracts absolute filesystem paths named anywhere in a command string.
 *
 * The lookbehind rejects a `/` that is glued to something else, because an
 * absolute path BEGINS at its slash - if a character precedes it, what follows
 * is not one. Word characters and colons were always excluded (`http://`,
 * `a/b`); glob metacharacters are excluded too, and that mattered in practice.
 *
 * A real turn ran, inside its own workspace:
 *
 *   find <workspace> -type f -not -path '*\/.git/*' -not -path '*\/.codex/*'
 *
 * and `*\/.git/*` yielded a "path" of `/.git`, which is outside any workspace,
 * so G3 killed the run. The Agent had touched nothing but its own directory.
 * A glob cannot escape the working directory - `cat *\/etc/passwd` matches
 * children of the cwd, never `/etc` - so declining to read one as an absolute
 * path costs no enforcement.
 */
export function pathsIn(command: string): string[] {
  const found = new Set<string>();
  // `\/` is just `/` once the shell is done with it, so both halves of this
  // matter. Unescaping FIRST means `sed 's/x/tests\/a.ts/'` reads as
  // `tests/a.ts` - a relative path, correctly ignored, where the raw text
  // yielded a spurious absolute `/a.ts` and killed a run. It also means
  // `cat \/etc\/passwd` reads as `/etc/passwd` and is caught, where the raw
  // text would have hidden it. Rejecting escaped slashes outright would have
  // fixed the first and opened the second.
  const unescaped = command
    .replace(/\\\//g, "/")
    // Shell concatenation: a quote WEDGED between two non-spaces joins the two
    // halves, so `src'"'"'/a.ts` is the relative `src/a.ts`. Removing only the
    // wedged quotes keeps `cat "/etc/passwd"` intact, where the quote follows a
    // space and is really quoting rather than joining.
    .replace(/(?<=\S)['"](?=\S)/g, "");
  // The first character after the slash must begin a NAME. A sed delimiter
  // leaves fragments like `/-` behind, and a one-character non-name is never a
  // path anybody meant - but it is outside every workspace, so treating it as
  // one refused the run.
  // The lookbehind excludes every character that can END a path segment, not
  // just word characters: `./.agents/*` and `src/a.ts` are relative, and their
  // slashes are glued to a name. Only a slash with whitespace, a quote or a
  // shell operator before it begins an absolute path.
  for (const match of unescaped.matchAll(
    /(?<![\w:/*?\].~@-])(\/[A-Za-z0-9._~@][A-Za-z0-9._~@/-]{0,199})/g,
  )) {
    const raw = match[1];
    if (!raw || raw === "/") continue;
    found.add(canonical(raw.replace(/[.,;:'")\]]+$/, "")));
  }
  return [...found];
}
