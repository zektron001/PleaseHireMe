/**
 * The greeting is written in the person's own colour, so the thing worth
 * pinning is that the colour actually follows the person - and that it is
 * carried as a HUE, not as a finished colour. A finished colour would have to
 * pick a theme, and be wrong in the other one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Hello } from "./Hello";
import { hueOf } from "../participants";
import type { Human } from "../types";

const alice: Human = { id: "human:alice", handle: "alice", displayName: "Alice Chen" };
const bob: Human = { id: "human:bob", handle: "bob", displayName: "Bob Okafor" };

function hueOnOverlay(): string | null {
  const overlay = document.querySelector<HTMLElement>(".hello");
  return overlay?.style.getPropertyValue("--hello-hue").trim() ?? null;
}

afterEach(cleanup);

describe("the greeting takes the colour of the person being greeted", () => {
  it("carries that human's participant hue", () => {
    render(<Hello human={alice} onDone={() => {}} now={new Date(2026, 0, 1, 19)} />);
    expect(hueOnOverlay()).toBe(String(hueOf(alice.id)));
  });

  it("gives a different human a different hue", () => {
    render(<Hello human={alice} onDone={() => {}} now={new Date(2026, 0, 1, 19)} />);
    const first = hueOnOverlay();
    cleanup();
    render(<Hello human={bob} onDone={() => {}} now={new Date(2026, 0, 1, 19)} />);
    expect(hueOnOverlay()).not.toBe(first);
    expect(hueOnOverlay()).toBe(String(hueOf(bob.id)));
  });

  it("passes a bare hue, so the theme still chooses the lightness", () => {
    render(<Hello human={bob} onDone={() => {}} now={new Date(2026, 0, 1, 19)} />);
    const hue = hueOnOverlay() ?? "";
    expect(hue).toMatch(/^\d+$/);
    // Not a hex, an hsl() or any other finished colour.
    expect(hue).not.toMatch(/#|hsl|rgb/);
  });
});

describe("the words on screen", () => {
  it("greets the signed-in human by their first name", () => {
    render(<Hello human={alice} onDone={() => {}} now={new Date(2026, 0, 1, 19)} />);
    expect(screen.getByText("Good evening, Alice.")).toBeTruthy();
  });

  it("labels the dialog with the greeting, for a screen reader", () => {
    render(<Hello human={bob} onDone={() => {}} now={new Date(2026, 0, 1, 9)} />);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      "Good morning, Bob.",
    );
  });
});
