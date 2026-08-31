/**
 * CONCORD_SHARED_STATE.md, section 6 "Limitations", row C7 (not struck
 * through the way C1 and C5 are, so it reads as a live, still-true limit):
 *
 *   "**C7** | Concurrency *outcomes* (`merged`, `conflict`, `leased`) are not
 *   appended to the audit chain - only the authority decision behind them is.
 *   | The chain records authorization, and that is what Track B requires. |
 *   Append the outcome too, so 'both edits survived' is chain evidence rather
 *   than an API response. |"
 *
 * That is not what the code does. src/warrant/index.ts wires
 * SharedDocStore's `onEvent` callback to `this.recordConcord(event)`
 * (index.ts:58), and `recordConcord` (index.ts:210-235) appends every
 * ConcordEvent - written, merged, conflict, denied, leased alike - to
 * `this.audit`, the very same hash-chained AuditLog `record()` uses for
 * authorization decisions, under gate `"C.concord"`. src/concord/store.ts's
 * `write()` calls `this.emit(...)` (which fires `onEvent`) for every one of
 * those outcomes (store.ts:466-470, 486-491, 564-570, 581-587, 609-616). Even
 * the GateId type in src/aegis/types.ts documents it in so many words:
 * `"C.concord" // CONCORD concurrency outcomes: written, merged, conflict,
 * resolved.`
 *
 * In other words: the C7 "Next" column ("Append the outcome too...") reads
 * like a plan that was already carried out in code without the doc's table
 * being updated - the opposite of what C1/C5's strikethroughs do when a
 * limitation actually closes. This test drives a real merge and a real
 * conflict through SharedDocStore inside a real WarrantPlane and asserts the
 * DOCUMENTED claim (no outcome events reach the chain). It is expected to
 * fail, loudly, because the code already does the opposite of what C7 says.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { WarrantPlane } from "../warrant/index.js";

const SHARED = "docs/CHANGELOG.md";

let dir = "";
let plane: WarrantPlane;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "concord-audit-scope-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

interface Planned {
  id: string;
  ownerId: string;
  agentId: string;
  paths: string[];
}

/** Plans a task whose subtasks both share one document, as shared.test.ts does. */
async function planShared(): Promise<Planned[]> {
  const result = await plane.orchestrator.plan({
    title: "Add rate limiting to the API",
    createdBy: "human:alice",
    owners: ["human:alice", "human:bob"],
    maxSubtasks: 2,
    sharedPaths: [SHARED],
  });
  return result.subtasks as unknown as Planned[];
}

describe("the audit chain records authorization, not concurrency outcomes", () => {
  it("drives a real merge and a real conflict, then checks what actually reached plane.audit", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    // Seed, then let both Agents check out the same version.
    await plane.docs.write(SHARED, alice.agentId, 0, "# Changelog\n\n- entry one\n- entry two");
    await plane.docs.read(SHARED, alice.agentId);
    await plane.docs.read(SHARED, bob.agentId);
    const base = plane.docs.snapshot(SHARED)!;

    // Disjoint edits from that shared base -> a real "merged" outcome.
    const aliceWrite = await plane.docs.write(
      SHARED,
      alice.agentId,
      base.version,
      "# Changelog\n\n- ALICE\n- entry two",
    );
    expect(aliceWrite.status).toBe("written");
    const bobMerge = await plane.docs.write(
      SHARED,
      bob.agentId,
      base.version,
      "# Changelog\n\n- entry one\n- BOB",
    );
    expect(bobMerge.status).toBe("merged");

    // Same-line edits from a shared base -> a real "conflict" outcome.
    await plane.docs.read(SHARED, alice.agentId);
    await plane.docs.read(SHARED, bob.agentId);
    const v = plane.docs.snapshot(SHARED)!.version;
    await plane.docs.write(SHARED, alice.agentId, v, "# Changelog\n\n- rate limiting by Alice");
    const bobConflict = await plane.docs.write(
      SHARED,
      bob.agentId,
      v,
      "# Changelog\n\n- rate limiting by Bob",
    );
    expect(bobConflict.status).toBe("conflict");

    const chain = plane.audit.recent(1_000);

    // Sanity: the chain really does hold authorization decisions. This part
    // of C7 is true.
    const authz = chain.filter((event) => event.gate === "B.authz");
    expect(authz.length).toBeGreaterThan(0);

    // The claim under test: "Concurrency outcomes (merged, conflict, leased)
    // are not appended to the audit chain." Named outcomes only - "written"
    // is not one of the three C7 names, so it is excluded from this
    // assertion even though the code does not distinguish it either.
    const outcomeEvents = chain.filter(
      (event) =>
        event.evidence["action"] === "document.merged" ||
        event.evidence["action"] === "document.conflict" ||
        event.evidence["action"] === "document.leased",
    );
    expect(outcomeEvents).toHaveLength(0);

    // The chain must still verify regardless of which way the count above
    // falls - a doc/code mismatch is not the same thing as a broken chain.
    expect(plane.audit.verify() === -1).toBe(true);
  });
});
