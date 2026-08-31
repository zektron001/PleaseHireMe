/**
 * Does the shipped browser client talk to routes this server actually has?
 *
 * Nothing else in the repo checks this. `apps/web` and `apps/server` are
 * separate workspaces compiled separately, and the wire between them is a
 * string: `fetch("/api/warrant/tasks")`. TypeScript checks the response TYPE on
 * one side and the handler's return on the other, and never once checks that
 * the two are the same endpoint. Rename a route and both workspaces still
 * typecheck, both still build, `npm run check` still passes, and the console
 * 404s in front of whoever opened it.
 *
 * So the client's URL list is read out of `apps/web/src/api.ts` and matched
 * against the server's route table, read out of `apps/server/src/**.ts`. Both
 * sides are derived, never transcribed: a hand-copied list is a list that goes
 * stale on the day someone adds route 41.
 *
 * This is a drift detector, not a security test. A failure here means the two
 * halves of the product disagree about the shape of their own API.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSrc = fileURLToPath(new URL(".", import.meta.url));
const webSrc = path.resolve(serverSrc, "../../web/src");

/** `/api/agents/:id/start` and `/api/agents/:agentId/start` are one route. */
const canonical = (url: string) => url.replace(/:[A-Za-z0-9_]+/g, ":p").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// The server's side of the contract
// ---------------------------------------------------------------------------

/**
 * Every route the server registers. Fastify does not expose its route table
 * after construction and `createApp` owns the instance, so the source is the
 * census - the same technique `security.test.ts` uses for its auth gate.
 */
async function serverRoutes(): Promise<Set<string>> {
  const files = (await readdir(serverSrc, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => path.join(e.parentPath ?? serverSrc, e.name));

  const routes = new Set<string>();
  const pattern = /\bapp\.(get|post|put|patch|delete)\(\s*"(\/api\/[^"]*)"/g;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      routes.add(match[1].toUpperCase() + " " + canonical(match[2]));
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// The client's side of the contract
// ---------------------------------------------------------------------------

/**
 * Reads the URL expression starting at `start` (the opening quote of a
 * `"/api/..."` literal) and rebuilds the route it produces at runtime.
 *
 * The client builds URLs by concatenation - `"/api/agents/" + id + "/start"` -
 * so the literal fragments are the route's fixed parts and everything between
 * them is a path parameter. Quoted fragments are taken verbatim; every other
 * term becomes `:p`. A query string is dropped: `?agentId=` is not part of the
 * route Fastify matches.
 */
function readUrlExpression(source: string, start: number): { url: string; end: number } {
  let i = start;
  let depth = 0;
  let url = "";
  let pendingParam = false;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '"' && depth === 0) {
      const close = source.indexOf('"', i + 1);
      if (close === -1) break;
      if (pendingParam) {
        url += ":p";
        pendingParam = false;
      }
      url += source.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") {
      // The `)` that closes the enclosing call ends the expression.
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === "," && depth === 0) break;
    else if (ch === "+" && depth === 0) pendingParam = true;

    i += 1;
  }

  // `"/api/agents/" + id` ends on the parameter, with no literal after it to
  // trigger the flush inside the loop.
  if (pendingParam) url += ":p";

  return { url: url.split("?")[0].replace(/\/$/, ""), end: i };
}

/**
 * The remainder of the call expression that owns the URL, from the end of the
 * URL through the `)` that closes the call. The options argument routinely sits
 * on a later line than the URL, so a line-bounded window reads most calls as GET
 * and invents drift that is not there.
 */
function callTail(source: string, end: number): string {
  let depth = 0;
  let i = end;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  return source.slice(end, i);
}

/** The HTTP method for a client call: `json(...)` is POST, `method:` wins. */
function methodFor(callSource: string): string {
  const explicit = /method:\s*"([A-Za-z]+)"/.exec(callSource);
  if (explicit) return explicit[1].toUpperCase();
  return /\bjson\(/.test(callSource) ? "POST" : "GET";
}

async function clientCalls(): Promise<Array<{ method: string; url: string; line: number }>> {
  const file = path.join(webSrc, "api.ts");
  const source = await readFile(file, "utf8");
  const calls: Array<{ method: string; url: string; line: number }> = [];

  for (let i = source.indexOf('"/api/'); i !== -1; i = source.indexOf('"/api/', i + 1)) {
    const { url, end } = readUrlExpression(source, i);
    // The rest of this call expression carries the method, if any.
    calls.push({
      method: methodFor(source.slice(i, end) + callTail(source, end)),
      url: canonical(url),
      line: source.slice(0, i).split("\n").length,
    });
    i = end;
  }
  return calls;
}

// ---------------------------------------------------------------------------

describe("the browser client and the server agree on the API", () => {
  it("finds the client's calls and the server's routes at all", async () => {
    // A parser that silently matches nothing would make every other test here
    // pass for the wrong reason.
    const [calls, routes] = await Promise.all([clientCalls(), serverRoutes()]);
    expect(calls.length).toBeGreaterThan(20);
    expect(routes.size).toBeGreaterThan(20);
    for (const call of calls) expect(call.url.startsWith("/api/")).toBe(true);
  });

  it("registers a route for every endpoint the client calls", async () => {
    const [calls, routes] = await Promise.all([clientCalls(), serverRoutes()]);

    const missing = calls
      .filter((call) => !routes.has(call.method + " " + call.url))
      .map((call) => call.method + " " + call.url + "  (api.ts:" + call.line + ")");

    expect([...new Set(missing)]).toEqual([]);
  });

  /**
   * The other direction: server routes with no caller in the browser client.
   *
   * A route the client never calls is not automatically a bug - some are
   * driven by the agent runner, the CLI demo, or an operator with curl, and the
   * developers' own docs say so. So this is a ratchet, not a prohibition: the
   * dead surface must match the list below exactly. Add a route and forget to
   * wire it up, and this fails with its name. Wire one up and this fails too,
   * telling you to strike it off the list - a baseline that only ever grows is
   * a baseline nobody trusts.
   *
   * Every entry carries the source that justifies it. An entry with no
   * justification is a bug someone has not looked at yet.
   */
  it("keeps its unreachable server routes to the documented set", async () => {
    const [calls, routes] = await Promise.all([clientCalls(), serverRoutes()]);
    const called = new Set(calls.map((c) => c.method + " " + c.url));

    const noBrowserCaller = new Set([
      // -- infrastructure, never a UI call ---------------------------------
      "GET /api/health", // liveness probe

      // -- the agent runner and the CLI demo call these, not the console ---
      "POST /api/warrant/act", // PDP oracle, WARRANT_TRACK_B.md
      "POST /api/warrant/subtasks/:p/submit", // runner callback
      "POST /api/warrant/subtasks/:p/approve", // integration gate
      "POST /api/warrant/tasks/:p/integrate", // demo.ts:224,247,264
      "POST /api/concord/docs/:p", // agents write docs; the console reads them
      "POST /api/concord/docs/:p/lease", // lease is taken by the writing agent
      "DELETE /api/concord/docs/:p/lease", // and released by it

      // -- AEGIS: built, no UI yet. MIDDLEWARE_ARCHITECTURE.md:928 says so --
      "GET /api/aegis/status", // header widget, unbuilt
      "GET /api/aegis/policy", // policy panel, unbuilt
      "GET /api/aegis/events", // evidence panel, unbuilt
      "GET /api/aegis/attestation", // "asset intact" badge, unbuilt
      "POST /api/aegis/killswitch", // operator-only
      "POST /api/aegis/budget/:p", // operator-only

      // -- documented API surface with no console screen -------------------
      "GET /api/concord/docs/:p/contributions", // CONCORD_REVIEW_LOOP.md:167
      "POST /api/review/consultations", // CONCORD_REVIEW_LOOP.md:173
      "GET /api/review/consultations/:p", // CONCORD_REVIEW_LOOP.md:174
      "GET /api/review/docs/:p/consultations", // sibling of the above

      // -- reachable data the console gets another way ---------------------
      "GET /api/concord/docs/:p/presence", // presence rides along on the doc read
      "GET /api/agents/:p", // console lists agents, never fetches one
      "GET /api/warrant/me", // console reads the human off the session response
    ]);

    const orphans = [...routes].filter((r) => !called.has(r)).sort();
    const undocumented = orphans.filter((r) => !noBrowserCaller.has(r));
    const stale = [...noBrowserCaller].filter((r) => called.has(r)).sort();

    expect({ undocumented, stale }).toEqual({ undocumented: [], stale: [] });
  });
});
