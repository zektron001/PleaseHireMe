import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_INSTRUCTION,
  MAX_CHECKPOINT_MESSAGE,
  parseCheckpoint,
  withCheckpointInstruction,
} from "./checkpoint.js";

describe("Agent checkpoint messages", () => {
  it("reads the checkpoint an Agent declared", () => {
    const reply = [
      "I extracted the guard clause and added a test.",
      "",
      "CONCORD-COMMIT: extract the rate-limit guard and cover it",
    ].join("\n");
    expect(parseCheckpoint(reply)).toBe("extract the rate-limit guard and cover it");
  });

  it("takes the last marker, so a restated plan does not win over the result", () => {
    const reply = [
      "Plan:",
      "CONCORD-COMMIT: I will refactor the limiter",
      "...work happens...",
      "CONCORD-COMMIT: refactored the limiter and fixed the off-by-one",
    ].join("\n");
    expect(parseCheckpoint(reply)).toBe("refactored the limiter and fixed the off-by-one");
  });

  it("returns null when the Agent declared nothing", () => {
    expect(parseCheckpoint("I could not find anything to change.")).toBeNull();
    expect(parseCheckpoint("")).toBeNull();
    expect(parseCheckpoint("CONCORD-COMMIT:")).toBeNull();
    expect(parseCheckpoint("CONCORD-COMMIT:    ")).toBeNull();
  });

  it("bounds a message a model tried to make enormous", () => {
    const long = "CONCORD-COMMIT: " + "x".repeat(500);
    const parsed = parseCheckpoint(long);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(MAX_CHECKPOINT_MESSAGE);
  });

  it("collapses a message onto one line", () => {
    // The pattern is line-anchored, so an embedded newline ends the message
    // rather than letting a model smuggle extra lines into the log.
    const parsed = parseCheckpoint("CONCORD-COMMIT: tidy   the\tparser");
    expect(parsed).toBe("tidy the parser");
  });

  it("is case-insensitive and tolerates leading whitespace", () => {
    expect(parseCheckpoint("   concord-commit:  lower case works")).toBe(
      "lower case works",
    );
  });

  it("appends the instruction without discarding the task", () => {
    const composed = withCheckpointInstruction("Refactor the limiter.");
    expect(composed).toContain("Refactor the limiter.");
    expect(composed).toContain("CONCORD-COMMIT:");
    expect(CHECKPOINT_INSTRUCTION).toContain("one line");
  });
});
