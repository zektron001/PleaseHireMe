/**
 * Doc-vs-code contract for §4.7's kill-switch TOCTOU closure.
 *
 * docs/MIDDLEWARE_ARCHITECTURE.md §4.7 (and state/latch.ts's own header,
 * verbatim the same sentence):
 *   "The latch is checked in G1 and re-checked immediately before spawn,
 *   closing the time-of-check-to-time-of-use window between admission and
 *   execution."
 *
 * guarded-runner.ts does contain that second check - it sits right after
 * `acquireSlot` and right before the `guarded` request object (and therefore
 * `this.inner.run(...)`) is built:
 *
 *   if (this.aegis.latch.isArmed) { ...release ledger, forget run, throw... }
 *
 * But guarded-runner.test.ts's "KS-9 global kill switch" describe block only
 * ever calls `aegis.latch.arm(...)` BEFORE `guarded.run(...)`, i.e. before
 * `admit()` even starts. `admit()` has its own, earlier latch check (in
 * index.ts, first line of the admission path) and refuses there - so that
 * existing test proves G1's check works and never reaches the re-check block
 * at all. Nothing in the suite arms the latch strictly inside the window the
 * re-check exists to close.
 *
 * This file opens that window for real. Between `admit()` resolving (ticket
 * granted, budget reserved, concurrency slot acquired) and `this.inner.run()`
 * being invoked, the only code guarded-runner.ts runs is synchronous:
 * `grantCapability`, `acquireSlot`, then the re-check. There is no natural
 * async gap a test could race against, so the window is opened deterministically
 * by spying on `Aegis.grantCapability` - the first Aegis method the runner
 * calls once admission has already succeeded - and arming the latch as a side
 * effect of that call, before returning control to guarded-runner.ts. That is
 * a faithful stand-in for "an operator hit the kill switch in the few
 * microseconds between this run being admitted and it being spawned," which
 * is exactly the race §4.7 claims to have closed.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { PolicyAbortError } from "../errors.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { Aegis, ContainmentError } from "./index.js";
import { GuardedAgentRunner } from "./guarded-runner.js";

const AGENT_A = "11111111-1111-1111-1111-111111111111";

function eventLine(item: Record<string, unknown>): string {
  return JSON.stringify({ type: "item.completed", item });
}

const BENIGN = [
  eventLine({ type: "command_execution", command: "/usr/bin/node /workspace/build.js" }),
  eventLine({ type: "agent_message", text: "Done." }),
];

/** Minimal AgentRunner stand-in, duplicated from guarded-runner.test.ts's
 * FakeRunner (not exported from there) since this house idiom is what the
 * rest of the aegis suite uses to exercise GuardedAgentRunner without Docker. */
class FakeRunner implements AgentRunner {
  runs = 0;

  constructor(private readonly lines: string[]) {}

  setArgvTransform(): void {
    // Not exercised by these tests.
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.runs += 1;
    for (const line of this.lines) {
      if (request.inspect && !request.inspect(line)) {
        throw new PolicyAbortError();
      }
    }
    return { output: "ok", threadId: "thread-1", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

let dir = "";
let vault = "";

async function makeAegis(): Promise<Aegis> {
  const config = loadConfig({
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_VAULT_PATH: vault,
    ARK_API_KEY: "ark-test-key-0123456789",
    ARK_MODEL: "ep-test",
  } as NodeJS.ProcessEnv);
  return Aegis.bootstrap(config);
}

function request(agentId: string, prompt: string): RunnerRequest {
  return {
    agentId,
    workspacePath: path.join(dir, "workspaces", agentId),
    prompt,
    threadId: null,
  };
}

/** Arms the latch as a side effect of the first Aegis call the runner makes
 * once admission has already succeeded, i.e. squarely inside the TOCTOU
 * window between admit() returning and this.inner.run() being invoked. */
function armLatchBetweenAdmissionAndSpawn(aegis: Aegis): { fired: boolean } {
  const marker = { fired: false };
  const original = aegis.grantCapability.bind(aegis);
  vi.spyOn(aegis, "grantCapability").mockImplementation((token, agentId, runId) => {
    original(token, agentId, runId);
    aegis.latch.arm("operator armed between admission and spawn");
    marker.fired = true;
  });
  return marker;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aegis-toctou-"));
  vault = path.join(dir, "vault");
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, "customers.db"), "id,name,email\n1,ada,a@x.io\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe("§4.7 TOCTOU: re-check immediately before spawn", () => {
  it("refuses a run armed strictly between admission and spawn, though admission itself already succeeded", async () => {
    const aegis = await makeAegis();
    const marker = armLatchBetweenAdmissionAndSpawn(aegis);
    const inner = new FakeRunner(BENIGN);
    const guarded = new GuardedAgentRunner(inner, aegis, path.join(dir, "codex-home"));

    const error = (await guarded
      .run(request(AGENT_A, "hello"))
      .catch((caught: unknown) => caught)) as ContainmentError;

    // Sanity: the window was actually exercised, not skipped by a refactor
    // that stopped calling grantCapability.
    expect(marker.fired).toBe(true);

    expect(error).toBeInstanceOf(ContainmentError);
    expect(error.outcome).toBe("blocked");
    expect(error.verdict.ruleId).toBe("KS-9.killswitch.armed");
    // The whole point of the re-check: no container is ever spawned.
    expect(inner.runs).toBe(0);
  });

  it("releases the budget reservation admit() made, so the closed race does not leak spend", async () => {
    const aegis = await makeAegis();
    armLatchBetweenAdmissionAndSpawn(aegis);
    const before = aegis.ledger.remainingUsd(AGENT_A);

    const guarded = new GuardedAgentRunner(
      new FakeRunner(BENIGN),
      aegis,
      path.join(dir, "codex-home"),
    );
    await guarded.run(request(AGENT_A, "hello")).catch(() => undefined);

    expect(aegis.ledger.remainingUsd(AGENT_A)).toBeCloseTo(before, 10);
  });

  it("also releases the concurrency slot admission acquired", async () => {
    const aegis = await makeAegis();
    armLatchBetweenAdmissionAndSpawn(aegis);

    const guarded = new GuardedAgentRunner(
      new FakeRunner(BENIGN),
      aegis,
      path.join(dir, "codex-home"),
    );
    await guarded.run(request(AGENT_A, "hello")).catch(() => undefined);

    expect(aegis.activeRuns).toBe(0);
  });
});

describe("control: why the existing pre-admission KS-9 test cannot reach the re-check", () => {
  it("refuses inside admit() itself when armed before run() is called, never calling acquireSlot", async () => {
    const aegis = await makeAegis();
    const acquireSlot = vi.spyOn(aegis, "acquireSlot");
    aegis.latch.arm("operator stop");

    const guarded = new GuardedAgentRunner(
      new FakeRunner(BENIGN),
      aegis,
      path.join(dir, "codex-home"),
    );
    const error = (await guarded
      .run(request(AGENT_A, "hello"))
      .catch((caught: unknown) => caught)) as ContainmentError;

    expect(error).toBeInstanceOf(ContainmentError);
    expect(error.verdict.ruleId).toBe("KS-9.killswitch.armed");
    // This is the coverage gap in prose: arming before run() means admit()'s
    // own G1 check refuses first, so acquireSlot - and therefore the
    // re-check statement right after it in guarded-runner.ts - is never
    // reached. The re-check needs the window opened above to be exercised.
    expect(acquireSlot).not.toHaveBeenCalled();
  });
});
