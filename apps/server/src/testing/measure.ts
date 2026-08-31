/**
 * Measurement for the performance lane.
 *
 * Three rules, because a number nobody can defend is worse than no number.
 *
 *   WARM UP FIRST. V8 interprets before it optimises, so the first calls are
 *   several times slower than the steady state. Reporting them as "latency"
 *   measures the JIT, not the code.
 *
 *   REPORT PERCENTILES, NOT A MEAN. A mean hides exactly what matters: one
 *   150ms pause in a thousand 2ms calls barely moves the mean and is the whole
 *   story. p50 says what it usually costs; p95 says what a user actually waits
 *   for; max says what the garbage collector did to somebody.
 *
 *   ASSERT A BUDGET, NOT A BEST TIME. A test that pins the current number
 *   fails on a slower laptop and teaches nothing. These budgets have real
 *   headroom over the measured value and are chosen against what the
 *   surrounding system does - a CONCORD write sits inside a turn that takes
 *   fifteen seconds, so a millisecond either way is not the point; the point
 *   is that it does not become a second.
 *
 * These numbers are single-machine, single-process, and taken on whatever
 * hardware ran them. They are useful for "did this get an order of magnitude
 * worse" and for "is this algorithm the shape we think it is". They are not a
 * production SLO, and the report says so.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo root, derived from this module rather than from cwd.
 *
 * `npm run test:perf -w @launchpad/server` runs with cwd = apps/server, while
 * `vitest --root apps/server` from the repo root does not - so a relative path
 * landed in two different places depending on how the lane was invoked. The
 * report then found nothing and rendered no numbers while every test passed,
 * which is the quietest possible failure.
 */
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../../..");

export interface Measurement {
  readonly name: string;
  /** What claim this number is evidence for. Rendered in the report. */
  readonly claim: string;
  readonly runs: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly budgetMs: number;
  /** Why the budget is what it is. Rendered in the report, verbatim. */
  readonly justification: string;
}

const collected: Measurement[] = [];

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] as number;
}

export interface MeasureOptions {
  readonly name: string;
  readonly claim: string;
  readonly budgetMs: number;
  readonly justification: string;
  readonly runs?: number;
  readonly warmup?: number;
}

/** Times a synchronous or async operation and records it for the report. */
export async function measure(
  options: MeasureOptions,
  operation: (iteration: number) => unknown | Promise<unknown>,
): Promise<Measurement> {
  const runs = options.runs ?? 200;
  const warmup = options.warmup ?? Math.min(30, Math.ceil(runs / 10));

  for (let i = 0; i < warmup; i += 1) await operation(-1 - i);

  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await operation(i);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);

  const result: Measurement = {
    name: options.name,
    claim: options.claim,
    runs,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples[samples.length - 1] as number,
    budgetMs: options.budgetMs,
    justification: options.justification,
  };
  collected.push(result);
  return result;
}

/**
 * Writes what was measured, for the report to render.
 *
 * Appends rather than replaces: each perf file is its own vitest worker with
 * its own module registry, so `collected` is per-file and a plain write would
 * leave only whichever finished last.
 */
export async function flushMeasurements(file: string): Promise<void> {
  if (collected.length === 0) return;
  const target = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
  await mkdir(path.dirname(target), { recursive: true });
  const { readFile } = await import("node:fs/promises");
  let existing: Measurement[] = [];
  try {
    const raw = await readFile(target, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed as Measurement[];
  } catch {
    // No prior file, or an unreadable one. Start clean rather than fail a run.
  }
  const byName = new Map(existing.map((entry) => [entry.name, entry]));
  for (const entry of collected) byName.set(entry.name, entry);
  await writeFile(target, JSON.stringify([...byName.values()], null, 2) + "\n", "utf8");
}

/**
 * NOT `perf.json`. The report writes each lane's raw vitest output to
 * `artifacts/tests/<lane key>.json`, and the performance lane's key is `perf` -
 * so the lane silently overwrote its own measurements with vitest's summary,
 * and the report rendered no numbers while every test passed.
 */
export const MEASUREMENT_FILE = "artifacts/tests/perf-measurements.json";
