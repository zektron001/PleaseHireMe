import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Console from "./Console";
import { setAuthToken, setSessionToken } from "./api";
import type { Human } from "./types";

const ALICE: Human = { id: "human:alice", handle: "alice", displayName: "Alice" };

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function defaultHandlers(): Record<string, () => Response | Promise<Response>> {
  return {
    "/api/warrant/humans": () => jsonResponse(200, { humans: [ALICE] }),
    "/api/warrant/session": () => jsonResponse(200, { token: "session-abc", human: ALICE }),
    "/api/warrant/events": () =>
      jsonResponse(200, {
        viewer: ALICE.id,
        scope: "yours",
        captureLevel: "full",
        retained: 0,
        pruned: 0,
        chainHead: "-",
        chainAnchor: "-",
        chainValid: true,
        events: [],
      }),
    "/api/warrant/status": () =>
      jsonResponse(200, { policyVersion: "1", warrants: [], chainHead: "-", chainValid: true }),
  };
}

// Console fires several requests once signed in (events, warrantStatus, and -
// once a task exists - docs/doc/blame/reviewState). This router lets each
// test override only the endpoint it cares about and get sane defaults for
// the rest, keyed by URL prefix since api.ts always calls fetch with a plain
// path string.
function stubConsoleFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const handlers = { ...defaultHandlers(), ...overrides };
  const mock = vi.fn((input: string) => {
    const key = Object.keys(handlers).find((candidate) => input.startsWith(candidate));
    if (!key) throw new Error("Unhandled fetch in test: " + input);
    return Promise.resolve(handlers[key]());
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  setAuthToken("shared-demo-token");
  setSessionToken("");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Console", () => {
  it("shows a sign-in prompt and a WAITING chain state before anything has loaded", () => {
    // A fetch that never resolves stands in for "still loading".
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    render(<Console onExit={vi.fn()} />);

    expect(screen.getByText("WAITING")).toBeTruthy();
    expect(screen.getByText("Sign in to inspect the authorization chain.")).toBeTruthy();
  });

  it("empties the human roster without showing any error when the initial fetch fails", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", fetchMock);

    render(<Console onExit={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Give the rejected promise's `.catch(() => setHumans([]))` a chance to run.
    await waitFor(() => {
      expect(document.querySelectorAll(".whoami button")).toHaveLength(0);
    });
    // Console.tsx never calls setError for this failure - it is swallowed.
    expect(document.querySelector(".console-error")).toBeNull();
  });

  it("does not crash when /api/warrant/humans responds without a humans field", async () => {
    const fetchMock = stubConsoleFetch({
      "/api/warrant/humans": () => jsonResponse(200, {}),
    });

    render(<Console onExit={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // If rendering `humans.map(...)` over a non-array throws during the
    // resulting re-render, the whole tree unmounts and this static header
    // text (present since the very first render) disappears with it.
    await waitFor(() => {
      expect(screen.getByText("authorization record")).toBeTruthy();
    });
  });

  it("surfaces a refresh failure as a visible error banner once a human is signed in", async () => {
    stubConsoleFetch({
      "/api/warrant/events": () => jsonResponse(500, { error: "chain unavailable" }),
    });

    render(<Console onExit={vi.fn()} />);

    const signInButton = await screen.findByRole("button", { name: ALICE.displayName });
    fireEvent.click(signInButton);

    await screen.findByText("chain unavailable");
    expect(document.querySelector(".console-error")).not.toBeNull();
  });
});

/**
 * The greeting is only worth anything if it actually reaches the screen. The
 * component itself is covered in onboarding/hello.test.tsx; what is checked
 * here is the wiring - that signing in mounts it, and that having been
 * greeted once stops it coming back.
 */
describe("the first-run greeting", () => {
  it("greets the human who just signed in", async () => {
    localStorage.clear();
    stubConsoleFetch();
    render(<Console onExit={() => {}} />);

    // The chip carries the avatar initials as well as the name, so match loosely.
    const chip = await screen.findByRole("button", { name: /Alice/ });
    fireEvent.click(chip);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toMatch(/^Good (morning|afternoon|evening), Alice\.$/);
  });

  it("does not greet the same human twice", async () => {
    localStorage.clear();
    localStorage.setItem("launchpad.hello.seen." + ALICE.id, "1");
    stubConsoleFetch();
    render(<Console onExit={() => {}} />);

    const chip = await screen.findByRole("button", { name: /Alice/ });
    fireEvent.click(chip);

    await waitFor(() => expect(chip.getAttribute("data-active")).toBe("true"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
