import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setAuthToken, setSessionToken } from "./api";

const SHARED_TOKEN = "shared-demo-token";
const SESSION_TOKEN = "session-token-for-alice";

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function badJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON at position 0")),
  } as unknown as Response;
}

function stubFetch(impl: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function authHeader(mock: { mock: { calls: unknown[][] } }, callIndex = 0): string | undefined {
  const call = mock.mock.calls[callIndex] as [string, RequestInit] | undefined;
  if (!call) throw new Error("fetch was not called at index " + callIndex);
  const headers = call[1]?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

beforeEach(() => {
  setAuthToken("");
  setSessionToken("");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------- credential routing
//
// Two credential schemes travel in the same Authorization header:
//   - the shared demo token (`authToken`, set via setAuthToken) says the
//     browser may talk to the server at all.
//   - the per-human session token (`sessionToken`, set via setSessionToken,
//     from POST /api/warrant/session) says WHICH human is asking.
// `request()` always defaults to the shared token; `asHuman()` overrides the
// header with the session token when one is set. Sending the wrong one is a
// real bug class, so every representative family is checked both ways: which
// credential a call attaches, and that it is never the other one.

describe("credential routing", () => {
  it("a baseline route (listAgents) attaches the shared demo token, never the session token", async () => {
    setAuthToken(SHARED_TOKEN);
    setSessionToken(SESSION_TOKEN);
    const fetchMock = stubFetch(() => jsonResponse(200, { agents: [] }));

    await api.listAgents();

    expect(authHeader(fetchMock)).toBe("Bearer " + SHARED_TOKEN);
    expect(authHeader(fetchMock)).not.toBe("Bearer " + SESSION_TOKEN);
  });

  it("a warrant write route (plan) attaches the per-human session token, never the shared token", async () => {
    setAuthToken(SHARED_TOKEN);
    setSessionToken(SESSION_TOKEN);
    const fetchMock = stubFetch(() => jsonResponse(200, { task: {}, subtasks: [] }));

    await api.plan({ title: "Add rate limiting", owners: ["human:alice"] });

    expect(authHeader(fetchMock)).toBe("Bearer " + SESSION_TOKEN);
    expect(authHeader(fetchMock)).not.toBe("Bearer " + SHARED_TOKEN);
  });

  it("a concord write route (resolveConflict) attaches the per-human session token, never the shared token", async () => {
    setAuthToken(SHARED_TOKEN);
    setSessionToken(SESSION_TOKEN);
    const fetchMock = stubFetch(() => jsonResponse(200, { outcome: { status: "resolved" } }));

    await api.resolveConflict("docs/CHANGELOG.md", { conflictId: "c1", choice: "ours" });

    expect(authHeader(fetchMock)).toBe("Bearer " + SESSION_TOKEN);
    expect(authHeader(fetchMock)).not.toBe("Bearer " + SHARED_TOKEN);
  });

  it("a review write route (addComment) attaches the per-human session token, never the shared token", async () => {
    setAuthToken(SHARED_TOKEN);
    setSessionToken(SESSION_TOKEN);
    const fetchMock = stubFetch(() => jsonResponse(200, { comment: {} }));

    await api.addComment("docs/CHANGELOG.md", { startLine: 1, endLine: 2, body: "fix this" });

    expect(authHeader(fetchMock)).toBe("Bearer " + SESSION_TOKEN);
    expect(authHeader(fetchMock)).not.toBe("Bearer " + SHARED_TOKEN);
  });

  it("documents that a concord read route (docs) deliberately uses the shared token, not the session token", async () => {
    // Not every /api/warrant, /api/concord or /api/review route needs a human
    // identity: reads that are not scoped to a specific viewer (docs, doc,
    // docHistory, blame, humans, tasks, warrantStatus, signIn itself) go
    // through plain `request`, i.e. the shared token. Only routes that need
    // to know WHICH human is asking go through `asHuman`. Recorded here so
    // this split is not mistaken for a routing bug.
    setAuthToken(SHARED_TOKEN);
    setSessionToken(SESSION_TOKEN);
    const fetchMock = stubFetch(() => jsonResponse(200, { docs: [] }));

    await api.docs("agent_1");

    expect(authHeader(fetchMock)).toBe("Bearer " + SHARED_TOKEN);
  });

  it("REAL FINDING: an identity route silently falls back to the shared token when no human has signed in", async () => {
    // api.ts's sessionToken docstring says the two tokens are mutually
    // exclusive: the shared token says the browser may talk to the server at
    // all, the session token says WHICH human is asking, and "the middleware
    // routes want this one" (the session token). `asHuman` only overrides the
    // Authorization header when sessionToken is truthy; when it is empty (no
    // sign-in yet) it falls through to request()'s default, which sends the
    // shared token instead. A warrant/concord/review call made before sign-in
    // should omit Authorization (or fail fast), not silently impersonate the
    // shared demo credential the docstring says is "not an identity".
    setAuthToken(SHARED_TOKEN);
    // sessionToken deliberately left unset - nobody has signed in.
    const fetchMock = stubFetch(() => jsonResponse(200, { task: {}, subtasks: [] }));

    await api.plan({ title: "Add rate limiting", owners: ["human:alice"] });

    expect(authHeader(fetchMock)).not.toBe("Bearer " + SHARED_TOKEN);
  });
});

// ------------------------------------------------------------ error handling

describe("error handling", () => {
  it("rejects with an ApiError on a non-2xx response", async () => {
    stubFetch(() => jsonResponse(500, { error: "boom" }));

    await expect(api.listAgents()).rejects.toBeInstanceOf(ApiError);
  });

  it("carries the server's error message and status through the rejection", async () => {
    stubFetch(() => jsonResponse(503, { error: "agents unavailable" }));

    await expect(api.listAgents()).rejects.toMatchObject({
      message: "agents unavailable",
      status: 503,
    });
  });

  it("propagates a network failure as a rejection instead of swallowing it", async () => {
    stubFetch(() => Promise.reject(new Error("network down")));

    await expect(api.listAgents()).rejects.toThrow("network down");
  });

  it("resolves with an empty object rather than throwing when a 2xx body is not JSON", async () => {
    stubFetch(() => badJsonResponse(200));

    await expect(api.listAgents()).resolves.toEqual({});
  });

  it("falls back to a generic error message when a non-2xx body is not JSON", async () => {
    stubFetch(() => badJsonResponse(502));

    await expect(api.listAgents()).rejects.toMatchObject({
      message: "Request failed",
      status: 502,
    });
  });

  it("surfaces a 401 as an ApiError with status 401, distinct from other failures", async () => {
    stubFetch(() => jsonResponse(401, { error: "unauthorized" }));

    await expect(api.listAgents()).rejects.toBeInstanceOf(ApiError);
    await expect(api.listAgents()).rejects.toMatchObject({ status: 401 });
  });
});
