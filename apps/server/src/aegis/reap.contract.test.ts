/**
 * Doc-vs-code contract for KS-9's label-based forced reap.
 *
 * docs/MIDDLEWARE_ARCHITECTURE.md line 264 (verification/threat table):
 *   "KS-9 Kill switch + breaker | cancel() per Agent | global latch +
 *   per-Agent circuit breaker + forced reap + quarantine"
 * and lines 798-800 (boot reconciliation):
 *   "AEGIS extends that reconciliation: any `running` run found at boot is
 *   reaped, its container force-removed by label
 *   (`io.codejam.launchpad=agent-runtime`), and the vault re-attested."
 *
 * `reapAllRuntimeContainers` in ./reap.ts is that label-based reaper. It is
 * called from src/index.ts's kill-switch route and (per its own header
 * comment) "at boot" - never per-run.
 *
 * IMPORTANT SCOPING NOTE, established by reading the doc carefully rather
 * than trusting the task brief's shorthand: §4.5 (line 429-430) also says
 * "The reaper (`removeContainer`) already exists and already escalates
 * `docker rm --force` -> `SIGTERM` -> `SIGKILL`." That sentence is about a
 * DIFFERENT function - `ContainerCodexRunner.removeContainer` in
 * ../container-codex-runner.ts (verified: it tries `rm --force` on the
 * tracked container name first, and only on that promise's rejection falls
 * back to `child.kill("SIGTERM")` then a 3s-later `child.kill("SIGKILL")`).
 * That is the per-run G3/cancel() kill path, not KS-9's reap-all-by-label
 * path. reap.ts's own module comment ("Reaps every container the platform
 * has ever labelled, by label rather than a tracked handle") and its single
 * `execFileAsync(..., ["rm", "--force", ...ids], ...)` call with no retry or
 * signal fallback confirm reap.ts never escalates - and nothing in the doc
 * claims it does; every doc sentence that actually names this path (lines
 * 264, 799-800, 953, 956) describes a plain force-remove-by-label, which is
 * exactly what the code does. There is no real finding to pin here: the
 * escalation claim and this file's target are, on inspection, about two
 * different functions in two different files, not a contradiction.
 *
 * What IS worth pinning as a contract, because it has real security
 * relevance and nothing in the existing suite exercises it: reap.ts's own
 * comment promises "Never throws" and wraps both execFileAsync calls in one
 * blanket `try/catch { return 0 }`. That means the number 0 is ambiguous by
 * construction - it means "no containers were running" AND "containers were
 * found but the forced removal itself failed" indistinguishably. A caller
 * (the kill-switch route, or boot reconciliation) cannot tell "already
 * clean" from "reap silently failed" from the return value alone. That is a
 * deliberate, documented tradeoff per the code's own comment ("A missing or
 * stopped engine is not a reason to fail the kill switch"), not a doc
 * contradiction, so it is pinned below as regression-guarded reality, not as
 * a failing test.
 *
 * `execFile` is imported by reap.ts at module scope (not dependency-injected
 * the way sandbox/network.ts's `ensureNetwork` is), so this file uses
 * `vi.mock("node:child_process", ...)` with a `[util.promisify.custom]`
 * hook, matching how Node's own `promisify(execFile)` special-cases that
 * symbol - confirmed against Node's documented `util.promisify.custom`
 * contract - so `promisify(execFile)` in reap.ts resolves to this mock
 * without reap.ts itself needing any changes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const promisifyCustomSymbol = Symbol.for("nodejs.util.promisify.custom");
  function execFile(..._args: unknown[]): void {
    throw new Error(
      "reap.ts is expected to call execFile only through util.promisify, never the callback form directly",
    );
  }
  Object.defineProperty(execFile, promisifyCustomSymbol, {
    value: (...args: unknown[]) => execFileMock(...args),
  });
  return { execFile };
});

const { reapAllRuntimeContainers } = await import("./reap.js");
type AppConfig = Parameters<typeof reapAllRuntimeContainers>[0];

const LABEL_FILTER = "label=io.codejam.launchpad=agent-runtime";

function makeConfig(): AppConfig {
  return { containerEngine: "docker" } as AppConfig;
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("reapAllRuntimeContainers: label-based reap-all (KS-9 kill switch + boot)", () => {
  it("reaps every container matching the runtime label", async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: "id1\nid2\nid3\n", stderr: "" }) // ps
      .mockResolvedValueOnce({ stdout: "id1\nid2\nid3\n", stderr: "" }); // rm

    const count = await reapAllRuntimeContainers(makeConfig());

    expect(count).toBe(3);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["ps", "--quiet", "--filter", LABEL_FILTER],
      expect.objectContaining({ timeout: 8_000 }),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["rm", "--force", "id1", "id2", "id3"],
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it("returns 0 without calling rm when no container matches the label", async () => {
    execFileMock.mockResolvedValueOnce({ stdout: "", stderr: "" }); // ps: nothing found

    const count = await reapAllRuntimeContainers(makeConfig());

    expect(count).toBe(0);
    expect(execFileMock).toHaveBeenCalledTimes(1); // rm never attempted
  });

  it("returns 0 and does not throw when the container engine binary is absent", async () => {
    execFileMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
    );

    await expect(reapAllRuntimeContainers(makeConfig())).resolves.toBe(0);
    expect(execFileMock).toHaveBeenCalledTimes(1); // ps failed, rm never attempted
  });

  it("swallows a failure from rm --force itself, returning 0 with no SIGTERM/SIGKILL fallback attempted", async () => {
    // ps finds containers, but the removal call itself rejects (e.g. engine
    // daemon dropped mid-call). Pin the real, documented-in-code behavior:
    // one shot at `rm --force`, no retry, no escalation, no exception -
    // indistinguishable from the "nothing to reap" case above by return
    // value alone. This is reap.ts's actual contract; see header comment for
    // why this is not the same code path the doc's SIGTERM/SIGKILL sentence
    // describes.
    execFileMock
      .mockResolvedValueOnce({ stdout: "id1\n", stderr: "" }) // ps
      .mockRejectedValueOnce(new Error("Error: No such container: id1")); // rm fails

    await expect(reapAllRuntimeContainers(makeConfig())).resolves.toBe(0);
    // Exactly two calls total: ps, then the single failed rm. No third call
    // of any kind (no signal-based fallback exists in this code path).
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
