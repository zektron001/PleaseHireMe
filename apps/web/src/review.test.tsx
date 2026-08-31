import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReviewPanel } from "./Review";
import type { ReviewComment, ReviewState } from "./types";

const COMMENT: ReviewComment = {
  id: "comment-1",
  docId: "docs/CHANGELOG.md",
  baseVersion: 3,
  startLine: 2,
  endLine: 4,
  selectedText: "some code",
  selectedTextHash: "hash-1",
  body: "Please rename this",
  responsibleAgentId: "agent_1234567890",
  createdByHumanId: "human:alice",
  status: "open",
  lastReiterationRunId: null,
  createdAt: "2026-08-30T16:00:00.000Z",
  updatedAt: "2026-08-30T16:00:00.000Z",
};

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function stubFetch(impl: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReviewPanel", () => {
  it("renders nothing when there is no document open", () => {
    const { container } = render(
      <ReviewPanel
        docId={null}
        state={null}
        selection={null}
        busy={false}
        onRefresh={vi.fn()}
        onError={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("shows a loading skeleton while review state has not loaded yet", () => {
    render(
      <ReviewPanel
        docId="docs/CHANGELOG.md"
        state={null}
        selection={null}
        busy={false}
        onRefresh={vi.fn()}
        onError={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Loading review comments")).toBeTruthy();
  });

  it("shows an empty-state hint once state has loaded with no comments", () => {
    const state: ReviewState = { comments: [], runs: [], events: [] };
    render(
      <ReviewPanel
        docId="docs/CHANGELOG.md"
        state={state}
        selection={null}
        busy={false}
        onRefresh={vi.fn()}
        onError={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(screen.getByText(/no comments yet\. select a document line/i)).toBeTruthy();
  });

  it("submits a new comment for the selected line range with the typed body", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { comment: COMMENT }));
    const onRefresh = vi.fn();
    const onClearSelection = vi.fn();
    const state: ReviewState = { comments: [], runs: [], events: [] };

    render(
      <ReviewPanel
        docId="docs/CHANGELOG.md"
        state={state}
        selection={{ start: 2, end: 4 }}
        busy={false}
        onRefresh={onRefresh}
        onError={vi.fn()}
        onClearSelection={onClearSelection}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("What should the responsible Agent change?"), {
      target: { value: "Please rename this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add review comment" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/review/docs/docs%2FCHANGELOG.md/comments");
    expect(JSON.parse(init.body as string)).toEqual({
      startLine: 2,
      endLine: 4,
      body: "Please rename this",
    });

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("reports a failed submit through onError instead of throwing or silently failing", async () => {
    stubFetch(() => jsonResponse(409, { error: "Ambiguous: choose a target agent" }));
    const onError = vi.fn();
    const onRefresh = vi.fn();
    const state: ReviewState = { comments: [], runs: [], events: [] };

    render(
      <ReviewPanel
        docId="docs/CHANGELOG.md"
        state={state}
        selection={{ start: 1, end: 1 }}
        busy={false}
        onRefresh={onRefresh}
        onError={onError}
        onClearSelection={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("What should the responsible Agent change?"), {
      target: { value: "fix" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add review comment" }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Ambiguous: choose a target agent"),
    );
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("resolves a comment and refreshes on success", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { comment: { ...COMMENT, status: "resolved" } }),
    );
    const onRefresh = vi.fn();
    const state: ReviewState = { comments: [COMMENT], runs: [], events: [] };

    render(
      <ReviewPanel
        docId="docs/CHANGELOG.md"
        state={state}
        selection={null}
        busy={false}
        onRefresh={onRefresh}
        onError={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/review/comments/comment-1/resolve");

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it("sends the checked comment ids when reiterating", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { runs: [] }));
    const onRefresh = vi.fn();
    const state: ReviewState = { comments: [COMMENT], runs: [], events: [] };

    render(
      <ReviewPanel
        docId="docs/CHANGELOG.md"
        state={state}
        selection={null}
        busy={false}
        onRefresh={onRefresh}
        onError={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Reiterate selected comments" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/review/reiterations");
    expect(JSON.parse(init.body as string)).toEqual({ commentIds: ["comment-1"] });

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });
});
