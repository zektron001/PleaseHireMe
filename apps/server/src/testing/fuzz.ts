/**
 * One knob, two lanes.
 *
 * Default (no FUZZ_RUNS): every property runs a small fixed number of cases
 * from a pinned seed. That is what makes the audit lane quotable - a failure
 * reproduces byte-identically on a reviewer's machine instead of depending on
 * which seed the day handed out. A property that only fails on someone else's
 * laptop is worse than no property at all.
 *
 * FUZZ_RUNS=N: the same properties, N cases each, seed dropped so every
 * invocation explores a different sample. This lane is deliberately NOT
 * reproducible. When it finds something, fast-check prints the failing seed
 * and the shrunk counterexample; that seed goes back into the property as a
 * pinned regression and the finding moves into the default lane, where a
 * reviewer can re-run it and get the same answer.
 *
 * FUZZ_TIME_MS=N caps each property's wall clock. fast-check stops that
 * property gracefully at the limit and keeps what it had already proven, so a
 * campaign has a predictable ceiling - properties x FUZZ_TIME_MS - instead of
 * "until it finishes".
 *
 * This file sits under src/ rather than beside the tests so that tsconfig's
 * `exclude: src/**\/*.test.ts` does not swallow it: every property file imports
 * it, and an untypechecked helper with a regex and a generic in it is exactly
 * the thing that fails silently. It emits an unused module into dist, which is
 * the cheaper of the two costs.
 */
import type { Parameters } from "fast-check";

/** The pinned lane's case count. Chosen to keep the whole lane under a second. */
export const DEFAULT_RUNS = 200;

/**
 * Why the campaign is 20,000 cases and not "run it overnight".
 *
 * Measured on 2026-08-31, same five property files, same machine:
 *
 *     200 cases/property (pinned)      0.5s      8 failures
 *     20,000 cases/property            6s        9 failures   (+1)
 *     ~3,000,000 cases/property        9m wall   9 failures   (+0)
 *
 * The third row is the point. Another 150x on top of the campaign found
 * nothing the campaign had not already found, because fast-check samples
 * blindly from the generators a property declares, and these generators -
 * short strings, small arrays, bounded records - are exhausted long before
 * the clock is. Hours are what COVERAGE-GUIDED fuzzing needs, because it is
 * learning the input grammar from branch instrumentation as it goes. That is
 * a different tool, and the honest target for it here is normalisePath, which
 * is where the one case the pinned lane misses already lives.
 *
 * So: raise FUZZ_RUNS if the generators get wider. Raising it on today's
 * generators buys CPU heat.
 */

/**
 * A positive integer from the environment, or null.
 *
 * Anything else - unset, empty, "abc", "0", "-1", "1e6" - is treated as unset
 * rather than allowed to become NaN. A NaN numRuns runs zero cases, and a
 * property that ran zero cases reports green while having tested nothing,
 * which is the one outcome this whole suite exists to prevent.
 */
function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const runsOverride = positiveInt(process.env["FUZZ_RUNS"]);
const timeLimitMs = positiveInt(process.env["FUZZ_TIME_MS"]);

/**
 * True when this process is a fuzz run. Exported so a property whose
 * generators are too expensive to fuzz at full width can scale itself down,
 * and so a report can say which lane produced it.
 */
export const fuzzing = runsOverride !== null;

/**
 * fast-check parameters for one property.
 *
 * @param seed the pinned seed, used only in the default lane. Give every
 *   property its own: a shared seed makes two properties explore correlated
 *   inputs, which narrows coverage without saying so.
 * @param runs the default lane's case count, when this property needs to
 *   differ from DEFAULT_RUNS - an expensive generator may want fewer.
 */
export function props<Ts = unknown>(seed: number, runs: number = DEFAULT_RUNS): Parameters<Ts> {
  if (runsOverride === null) return { numRuns: runs, seed };
  return {
    numRuns: runsOverride,
    // No seed: a different sample each invocation is the entire point here.
    ...(timeLimitMs === null ? {} : { interruptAfterTimeLimit: timeLimitMs }),
  };
}
