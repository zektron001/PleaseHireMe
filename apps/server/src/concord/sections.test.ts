/**
 * Section ownership.
 *
 * The claim: two Agents working one file at the same time were never able to
 * touch the same lines - not merely merged afterwards. These tests drive the
 * real store, so the refusal comes from the same critical section that decides
 * authority, not from a helper called on the way in.
 */

import { describe, expect, it } from "vitest";
import { SharedDocStore, docResource, type AuthzCheck } from "./store.js";
import { findOutOfBounds, locateSection } from "./sections.js";

const allow: AuthzCheck = (agentId) => ({
  allowed: true,
  ruleId: "TEST.allow",
  reason: "test",
  humanId: "human:you",
});

const DOC = "docs/CHANGELOG.md";

const SEED = [
  "# Changelog",
  "",
  "## Rate limiting",
  "- TBD",
  "",
  "## Upload limits",
  "- TBD",
  "",
].join("\n");

async function seeded(): Promise<SharedDocStore> {
  const store = new SharedDocStore(allow);
  await store.write(DOC, "agent_seed", 0, SEED);
  return store;
}

describe("locating a section", () => {
  it("runs from its heading to the next heading of the same or higher level", () => {
    expect(locateSection(SEED, "## Rate limiting")).toEqual({
      startLine: 3,
      endLine: 5,
    });
    // The last section runs to the end of the file.
    expect(locateSection(SEED, "## Upload limits")).toEqual({
      startLine: 6,
      endLine: 8,
    });
  });

  it("does not let a nested heading close its parent", () => {
    const nested = ["## A", "text", "### A1", "more", "## B", "x"].join("\n");
    expect(locateSection(nested, "## A")).toEqual({ startLine: 1, endLine: 4 });
  });

  it("returns null when the heading is absent", () => {
    expect(locateSection(SEED, "## Nothing here")).toBeNull();
  });
});

describe("what counts as reaching outside", () => {
  const range = { startLine: 3, endLine: 5 };

  it("allows a replacement inside the section", () => {
    const next = SEED.replace("## Rate limiting\n- TBD", "## Rate limiting\n- token bucket");
    expect(findOutOfBounds(SEED, next, range)).toBeNull();
  });

  it("allows appending at the section's closing line", () => {
    const lines = SEED.split("\n");
    lines.splice(5, 0, "- per-IP counters");
    expect(findOutOfBounds(SEED, lines.join("\n"), range)).toBeNull();
  });

  it("refuses a change to another section", () => {
    const next = SEED.replace("## Upload limits\n- TBD", "## Upload limits\n- 5MB");
    expect(findOutOfBounds(SEED, next, range)?.reason).toContain("outside lines 3-5");
  });

  it("refuses a change to the document title", () => {
    const next = SEED.replace("# Changelog", "# Changes");
    expect(findOutOfBounds(SEED, next, range)).not.toBeNull();
  });
});

describe("the store refuses a write outside the allocation", () => {
  it("lets each Agent change only its own section", async () => {
    const store = await seeded();
    store.sections.allocate(DOC, "agent_a", "## Rate limiting");
    store.sections.allocate(DOC, "agent_b", "## Upload limits");

    const v = store.snapshot(DOC)!.version;
    const mine = SEED.replace("## Rate limiting\n- TBD", "## Rate limiting\n- token bucket");
    const ok = await store.write(DOC, "agent_a", v, mine);
    expect(ok.status).toBe("written");

    // The same Agent reaching into B's section is refused, and canonical
    // content does not move.
    const after = store.snapshot(DOC)!;
    const trespass = after.content.replace("## Upload limits\n- TBD", "## Upload limits\n- 5MB");
    const denied = await store.write(DOC, "agent_a", after.version, trespass);
    expect(denied.status).toBe("denied");
    if (denied.status === "denied") {
      expect(denied.ruleId).toBe("CD-section.outside");
      expect(denied.reason).toContain("## Rate limiting");
    }
    expect(store.snapshot(DOC)!.content).toBe(after.content);
    expect(store.snapshot(DOC)!.version).toBe(after.version);
  });

  it("refuses an Agent this document allocates nothing to", async () => {
    const store = await seeded();
    store.sections.allocate(DOC, "agent_a", "## Rate limiting");
    const v = store.snapshot(DOC)!.version;
    const outcome = await store.write(DOC, "agent_stranger", v, SEED + "\n- sneaky");
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.ruleId).toBe("CD-section.not-allocated");
    }
  });

  it("refuses rather than guesses when the heading has been removed", async () => {
    const store = await seeded();
    store.sections.allocate(DOC, "agent_a", "## Rate limiting");
    // A HUMAN renames the heading out from under the allocation. Only a human
    // can: an unallocated Agent is refused, which is the point of the rule.
    const v = store.snapshot(DOC)!.version;
    const renamed = await store.writeAsHuman(
      DOC,
      "human:you",
      v,
      SEED.replace("## Rate limiting", "## Throttling"),
    );
    expect(renamed.status).toBe("written");

    const now = store.snapshot(DOC)!;
    const outcome = await store.write(DOC, "agent_a", now.version, now.content + "- x\n");
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.ruleId).toBe("CD-section.missing");
    }
  });

  it("lets the human edit anywhere, because allocations bind Agents not people", async () => {
    const store = await seeded();
    store.sections.allocate(DOC, "agent_a", "## Rate limiting");
    const now = store.snapshot(DOC)!;

    const edited = await store.writeAsHuman(
      DOC,
      "human:you",
      now.version,
      now.content.replace("## Upload limits\n- TBD", "## Upload limits\n- 5MB, by hand"),
    );
    expect(edited.status).toBe("written");
    expect(store.snapshot(DOC)!.content).toContain("by hand");

    // And the line carries the human, with NO responsible Agent - so the
    // review loop will not route a question about it at an Agent.
    const provenance = store.provenanceOf(DOC);
    const line = provenance.find((entry) => entry.lastModifiedByHumanId === "human:you");
    expect(line).toBeDefined();
    expect(line?.lastModifiedByAgentId).toBeNull();
  });

  it("refuses a human edit against a version that already moved", async () => {
    const store = await seeded();
    const now = store.snapshot(DOC)!;
    const stale = await store.writeAsHuman(DOC, "human:you", now.version - 1, "whatever");
    expect(stale.status).toBe("stale");
    expect(store.snapshot(DOC)!.content).toBe(now.content);
  });

  it("leaves an unallocated document completely unrestricted", async () => {
    const store = await seeded();
    const v = store.snapshot(DOC)!.version;
    const outcome = await store.write(DOC, "agent_anyone", v, "totally different");
    expect(outcome.status).toBe("written");
  });

  it("lets two Agents commit to one document from the same base, in their own sections", async () => {
    const store = await seeded();
    store.sections.allocate(DOC, "agent_a", "## Rate limiting");
    store.sections.allocate(DOC, "agent_b", "## Upload limits");

    const base = store.snapshot(DOC)!;
    await store.read(DOC, "agent_a");
    await store.read(DOC, "agent_b");

    const a = base.content.replace("## Rate limiting\n- TBD", "## Rate limiting\n- token bucket");
    const b = base.content.replace("## Upload limits\n- TBD", "## Upload limits\n- 5MB cap");

    const first = await store.write(DOC, "agent_a", base.version, a);
    expect(first.status).toBe("written");
    // B writes from the STALE version and is merged, not conflicted.
    const second = await store.write(DOC, "agent_b", base.version, b);
    expect(second.status).toBe("merged");

    const final = store.snapshot(DOC)!.content;
    expect(final).toContain("token bucket");
    expect(final).toContain("5MB cap");
  });

  it("records the refusal as evidence", async () => {
    const events: { outcome: string; detail: Record<string, unknown> }[] = [];
    const store = new SharedDocStore(allow, Date.now, {
      onEvent: (event) => events.push({ outcome: event.outcome, detail: event.detail }),
    });
    await store.write(DOC, "agent_seed", 0, SEED);
    store.sections.allocate(DOC, "agent_a", "## Rate limiting");

    const now = store.snapshot(DOC)!;
    await store.write(
      DOC,
      "agent_a",
      now.version,
      now.content.replace("# Changelog", "# Rewritten"),
    );

    const denial = events.filter((event) => event.outcome === "denied").at(-1);
    expect(denial?.detail["ruleId"]).toBe("CD-section.outside");
    expect(String(denial?.detail["reason"])).toContain("outside lines");
    expect(docResource(DOC)).toContain(DOC);
  });
});
