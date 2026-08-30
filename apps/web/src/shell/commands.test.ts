import { describe, expect, it } from "vitest";
import { fuzzy, matchKey } from "./commands";

/** A KeyboardEvent-shaped literal is enough; matchKey reads five fields. */
function key(
  init: Partial<Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">>,
): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("matchKey", () => {
  it("treats cmd and ctrl as the same modifier, so one spec covers both platforms", () => {
    expect(matchKey(key({ key: "b", ctrlKey: true }), "ctrl+b")).toBe(true);
    expect(matchKey(key({ key: "b", metaKey: true }), "ctrl+b")).toBe(true);
  });

  it("requires the modifier", () => {
    expect(matchKey(key({ key: "b" }), "ctrl+b")).toBe(false);
  });

  it("does not fire a plain binding when shift is held", () => {
    // Ctrl+Shift+P must not also trigger Ctrl+P, or the palette opens in the
    // wrong mode.
    expect(matchKey(key({ key: "p", ctrlKey: true, shiftKey: true }), "ctrl+p")).toBe(false);
    expect(matchKey(key({ key: "p", ctrlKey: true, shiftKey: true }), "ctrl+shift+p")).toBe(true);
  });

  it("falls back to `code` when a modifier changes the reported glyph", () => {
    expect(matchKey(key({ key: "|", code: "Backslash", ctrlKey: true }), "ctrl+backslash")).toBe(
      true,
    );
  });
});

describe("fuzzy", () => {
  it("matches a substring", () => {
    expect(fuzzy("side", "View: Toggle Primary Side Bar")).toBe(true);
  });

  it("matches a subsequence, which is how palette shorthand works", () => {
    expect(fuzzy("tpsb", "View: Toggle Primary Side Bar")).toBe(true);
  });

  it("rejects characters that are out of order", () => {
    expect(fuzzy("barside", "View: Toggle Primary Side Bar")).toBe(false);
  });

  it("matches everything on an empty needle", () => {
    expect(fuzzy("", "anything")).toBe(true);
  });
});
