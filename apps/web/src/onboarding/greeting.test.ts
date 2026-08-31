/**
 * The greeting is the first sentence the product says to a person, so the
 * failure that matters is not a broken animation - it is getting their name
 * or their standing wrong.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  firstName,
  greetingLines,
  hasSeenHello,
  markHelloSeen,
  partOfDay,
  HELLO_SEEN_PREFIX,
} from "./greeting";

describe("the name someone is greeted by", () => {
  it("is their first name, not their full listing", () => {
    expect(firstName("Alice Chen", "alice")).toBe("Alice");
    expect(firstName("Bob Okafor", "bob")).toBe("Bob");
  });

  it("keeps a single-word name as it is", () => {
    expect(firstName("Prince", "prince")).toBe("Prince");
  });

  it("falls back to a capitalised handle rather than greeting nobody", () => {
    expect(firstName("", "carol")).toBe("Carol");
    expect(firstName("   ", "dave")).toBe("Dave");
  });

  it("says 'there' when there is nothing at all to go on", () => {
    expect(firstName("", "")).toBe("there");
  });
});

describe("the time of day", () => {
  it("splits morning, afternoon and evening at the hours people expect", () => {
    expect(partOfDay(6)).toBe("morning");
    expect(partOfDay(11)).toBe("morning");
    expect(partOfDay(12)).toBe("afternoon");
    expect(partOfDay(17)).toBe("afternoon");
    expect(partOfDay(18)).toBe("evening");
    expect(partOfDay(23)).toBe("evening");
  });

  it("treats the small hours as evening, not morning", () => {
    // 3am is still "tonight" to the person sitting there.
    expect(partOfDay(0)).toBe("evening");
    expect(partOfDay(3)).toBe("evening");
    expect(partOfDay(5)).toBe("morning");
  });
});

describe("what the greeting says", () => {
  it("greets a delegating human by name, and describes what they hold", () => {
    const { headline, subtitle } = greetingLines({
      displayName: "Alice Chen",
      handle: "alice",
      hour: 9,
    });
    expect(headline).toBe("Good morning, Alice.");
    expect(subtitle).toContain("act for you");
  });

  it("does not tell the orchestrator that Agents act for them", () => {
    // The orchestrator owns no subtask. Saying otherwise would be a lie in
    // the first sentence the product ever says.
    const { headline, subtitle } = greetingLines({
      displayName: "Orchestrator",
      handle: "orchestrator",
      hour: 20,
    });
    expect(headline).toBe("Good evening, Orchestrator.");
    expect(subtitle).toContain("decide what gets merged");
    expect(subtitle).not.toContain("act for you");
  });
});

describe("remembering that someone has been greeted", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("is per human, so a second person still gets their own hello", () => {
    markHelloSeen("human:alice");
    expect(hasSeenHello("human:alice")).toBe(true);
    expect(hasSeenHello("human:bob")).toBe(false);
  });

  it("writes under a namespaced key", () => {
    markHelloSeen("human:alice");
    expect(localStorage.getItem(HELLO_SEEN_PREFIX + "human:alice")).toBe("1");
  });

  it("treats unreadable storage as 'not seen' rather than throwing", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked site data");
      },
    });
    expect(() => hasSeenHello("human:alice")).not.toThrow();
    expect(hasSeenHello("human:alice")).toBe(false);
    expect(() => markHelloSeen("human:alice")).not.toThrow();
    if (original) Object.defineProperty(window, "localStorage", original);
  });
});
