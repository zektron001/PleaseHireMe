/**
 * Doc-vs-code contract for §5.5's containment latency budget.
 *
 * docs/MIDDLEWARE_ARCHITECTURE.md §5.5:
 *   "Δcontain = t_reaped - t_violation = Δparse (<1ms) + ΔPDP (<1ms) + Δrm (≈300ms)
 *   with the target Δcontain < 1s at p95, asserted by an automated test."
 *
 * §11's verification matrix repeats the claim as a row ("Latency | p95 Δcontain
 * < 1s | — | integration") with an empty negative-test cell, and nothing in
 * the existing suite (guarded-runner.test.ts included) computes a p95 or
 * asserts a numeric bound anywhere. "asserted by an automated test" was true
 * of nothing before this file.
 *
 * HONESTY NOTE, read before trusting the number this test produces: this
 * environment has no container engine, so t_reaped here is NOT "the container
 * is gone" - it is "GuardedAgentRunner has recorded live.violatedAt and
 * returned to the point where guarded.safetyFor() reports a containmentMs".
 * That is Δparse + ΔPDP only (line arrives at `inspect()` -> PolicyEngine
 * denies it -> live.violatedAt is stamped -> the catch block in run() computes
 * `Date.now() - live.violatedAt`). Δrm - the ≈300ms `docker rm --force` /
 * SIGTERM-then-SIGKILL escalation - never runs: FakeRunner throws
 * PolicyAbortError synchronously and no container ever existed to remove. So
 * a pass here is real evidence that the in-process half of the budget holds,
 * and precisely zero evidence about the ≈300ms Δrm term or about p95 under a
 * real docker/podman engine. See reap.contract.test.ts for what Δrm-adjacent
 * coverage exists (argv/escalation shape, still without a real engine).
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { PolicyAbortError } from "../errors.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { Aegis, ContainmentError } from "./index.js";
import { GuardedAgentRunner } from "./guarded-runner.js";

/**
 * Same shape as guarded-runner.test.ts's FakeRunner (not exported from
 * there, so reproduced here rather than reached into): stands in for the
 * container runner and drives lines through the `inspect` hook AEGIS wires
 * up. This copy only ever needs a single violating line.
 */
class FakeRunner implements AgentRunner {
  runs = 0;

  constructor(private readonly lines: string[]) {}

  // Deliberately NOT implementing setArgvTransform: this file measures G1
  // admission + G3 detection latency only, so GuardedAgentRunner's duck-typed
  // supportsArgvTransform(inner) check must see this runner as unsupporting,
  // and skip G2 argv hardening entirely. hardenContainerArgs expects a
  // realistic container argv (it locates the runtime image name in it), and
  // feeding it a placeholder throws SandboxProfileError - a test-harness
  // concern, not anything this file is trying to measure.

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
    return { output: "ok", threadId: "thread-1", usage: null };
  }
}

function eventLine(item: Record<string, unknown>): string {
  return JSON.stringify({ type: "item.completed", item });
}

/** Reads /vault/customers.db - the same violating command guarded-runner.test.ts
 * uses for its KS-2 case, kept identical so this reuses a rule already known
 * to fire on the first inspected line (no benign lines ahead of it to pad the
 * measured latency with irrelevant PDP calls). */
const VAULT_READ = eventLine({ type: "command_execution", command: "cat /vault/customers.db" });

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

function request(agentId: string): RunnerRequest {
  return {
    agentId,
    workspacePath: path.join(dir, "workspaces", agentId),
    prompt: "read the vault",
    threadId: null,
  };
}

/** Nearest-rank p95: sorted ascending, index ceil(0.95n) - 1. */
function p95(samplesMs: readonly number[]): number {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const index = Math.max(Math.ceil(0.95 * sorted.length) - 1, 0);
  return sorted[index] as number;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aegis-latency-"));
  vault = path.join(dir, "vault");
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, "customers.db"), "id,name,email\n1,ada,a@x.io\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe("§5.5: p95 Δcontain < 1s (in-process detect-and-decide path only)", () => {
  it("keeps p95 containmentMs under 1000ms across many independent containments", async () => {
    const aegis = await makeAegis();
    const codexHome = path.join(dir, "codex-home");
    const guarded = new GuardedAgentRunner(new FakeRunner([VAULT_READ]), aegis, codexHome);

    const RUNS = 300;
    const samples: number[] = [];

    for (let i = 0; i < RUNS; i += 1) {
      // A fresh agentId per iteration: KS-9's breaker opens after one
      // violation (see guarded-runner.test.ts, "opens the breaker and
      // refuses the Agent's next run"), and reusing an agentId would start
      // measuring breaker-refusal latency instead of containment latency.
      const agentId = randomUUID();
      const error = (await guarded
        .run(request(agentId))
        .catch((caught: unknown) => caught)) as ContainmentError;

      expect(error).toBeInstanceOf(ContainmentError);
      expect(error.outcome).toBe("killed");
      expect(error.verdict.ruleId).toBe("KS-2.vault.deny-any-access");

      const containmentMs = guarded.safetyFor(agentId)?.containmentMs;
      expect(containmentMs).not.toBeNull();
      samples.push(containmentMs as number);
    }

    expect(samples).toHaveLength(RUNS);
    const observedP95 = p95(samples);
    // The doc's own number. Not weakened, not rounded up "to be safe".
    expect(observedP95).toBeLessThan(1000);
  }, 20_000);
});
