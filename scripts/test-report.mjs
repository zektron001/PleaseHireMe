#!/usr/bin/env node
/**
 * Runs every test lane and writes the result down.
 *
 * The suite already told us what it found; the problem was that it only ever
 * said so to a terminal. A run whose output scrolls past is a run nobody can
 * cite in a review, diff against last week, or hand to someone who was not
 * watching. So each lane runs under vitest's JSON reporter, the raw report is
 * kept, and the three are folded into one Markdown file that names every
 * failing test and the message it failed with.
 *
 * The exit code follows the lane semantics in docs/TESTING.md rather than the
 * raw pass/fail count: baseline red is a regression and fails the run, audit
 * red is the audit doing its job and does not. That is the whole reason this
 * cannot just be `vitest run` with a reporter flag - `npm test` at the root
 * runs both lanes together and is therefore always red, which is why nobody
 * could use its exit code for anything.
 *
 *   node scripts/test-report.mjs           # all lanes
 *   node scripts/test-report.mjs baseline  # one lane, by name
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "artifacts", "tests");

/**
 * `gate` is the lane's contract, not a description of today's result:
 * "green" means a failure here is a regression someone just introduced,
 * "findings" means failures are the expected output and each one quotes a
 * docs/ line the code contradicts.
 */
const LANES = [
  {
    key: "baseline",
    title: "Baseline",
    gate: "green",
    blurb: "Did I break something that used to work?",
    args: ["run", "test:baseline", "-w", "@launchpad/server"],
  },
  {
    key: "audit-server",
    title: "Audit · server",
    gate: "findings",
    blurb: "What does the control plane do that its docs deny?",
    args: ["run", "test:audit", "-w", "@launchpad/server"],
  },
  {
    key: "audit-web",
    title: "Audit · web",
    gate: "findings",
    blurb: "What does the browser client do that its docs deny?",
    // The web workspace has no test:audit script, so the root `test:audit`
    // (which is --workspaces --if-present) silently skips it. Naming the
    // workspace directly is what keeps these 7 findings in the report.
    args: ["test", "-w", "@launchpad/web"],
  },
  {
    key: "fuzz",
    title: "Fuzz campaign",
    gate: "findings",
    blurb: "What survives 200 cases but not 20,000?",
    /**
     * The same properties the audit lane runs, at 100x the case count with the
     * seed dropped. It is in here because the cost is six seconds and the
     * measured yield is not zero: at the pinned count these properties report
     * 8 failures, and at 20,000 they report 9.
     *
     * `seedless` says this lane is deliberately not reproducible, so its
     * failures are not summed into the audit total and its section is written
     * as "this run found", not "the code contains". A campaign finding is a
     * lead: fast-check prints the seed and the shrunk counterexample, and the
     * fix is to pin that seed as a property in the audit lane, where a
     * reviewer re-running it gets the same answer.
     */
    seedless: true,
    // FUZZ_RUNS and FUZZ_TIME_MS are set by the npm script itself, so this
    // needs no environment of its own.
    args: ["run", "test:fuzz", "-w", "@launchpad/server"],
  },
];

function sh(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  return (result.stdout ?? "").trim();
}

function runLane(lane) {
  const reportPath = join(OUT_DIR, lane.key + ".json");
  rmSync(reportPath, { force: true });

  process.stderr.write("· " + lane.title + " ... ");
  spawnSync(
    "npm",
    [...lane.args, "--", "--reporter=json", "--outputFile=" + reportPath],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
  );

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    // No JSON means the runner itself died - a config error, a missing
    // dependency, a syntax error in a test file. That is a broken lane, not a
    // lane with findings, and the two must not be reported the same way.
    process.stderr.write("could not run\n");
    return { ...lane, broken: true, total: 0, passed: 0, failed: 0, failures: [], unrunnable: [] };
  }

  const failures = [];
  /**
   * A file that never loaded - a bad import, a syntax error - is recorded as a
   * failed suite carrying a message and zero assertions. Counting only
   * assertions makes it vanish: the totals shrink by however many tests it
   * held and nothing says so, which is the most dangerous shape a test report
   * can take. It is not a finding either; a finding is a test that ran and
   * disagreed with the docs. It gets its own section and always fails the run.
   */
  const unrunnable = [];
  for (const file of report.testResults ?? []) {
    const tests = file.assertionResults ?? [];
    if (file.status === "failed" && tests.length === 0) {
      unrunnable.push({
        file: (file.name ?? "").replace(ROOT + "/", ""),
        message: (file.message ?? "(no message)").split("\n")[0].trim(),
      });
      continue;
    }
    for (const test of tests) {
      if (test.status !== "failed") continue;
      const lines = (test.failureMessages ?? [])
        .join("\n")
        .split("\n")
        .map((line) => line.trim());
      failures.push({
        file: (file.name ?? "").replace(ROOT + "/", ""),
        name: [...(test.ancestorTitles ?? []), test.title].filter(Boolean).join(" › "),
        // First line only. The full assertion diff is in the JSON next to
        // this file; what a reader needs here is which claim broke.
        message: lines.find((line) => line.length > 0) ?? "(no message)",
        /**
         * The seed and the shrunk counterexample, when fast-check printed
         * them. Without these a campaign finding is unusable - the lane is
         * seedless, so "it failed once on someone's laptop" is all a reader
         * would have. With them the finding can be pinned into the audit lane.
         */
        reproduce: lines.filter((line) => /^(\{ seed:|Counterexample:)/.test(line)),
      });
    }
  }

  const lastRun = {
    ...lane,
    broken: false,
    total: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    files: (report.testResults ?? []).length,
    failures,
    unrunnable,
  };
  process.stderr.write(
    lastRun.passed + "/" + lastRun.total + " passed" +
    (unrunnable.length > 0 ? "  (" + unrunnable.length + " file(s) never loaded)" : "") + "\n",
  );
  return lastRun;
}

function verdict(lane) {
  if (lane.broken) return "**could not run**";
  if (lane.unrunnable.length > 0) {
    return "**" + lane.unrunnable.length + " file(s) never loaded**";
  }
  if (lane.gate === "green") return lane.failed === 0 ? "green" : "**REGRESSION**";
  return lane.failed === 0 ? "no findings" : lane.failed + " findings";
}

function markdown(lanes) {
  const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = sh("git", ["rev-parse", "--short", "HEAD"]);
  // Seedless lanes are excluded: the fuzz campaign re-runs the audit lane's
  // own properties, so adding its failures here would count most of them
  // twice and make the headline number depend on the day's random sample.
  const findings = lanes
    .filter((lane) => lane.gate === "findings" && !lane.seedless)
    .reduce((sum, lane) => sum + lane.failed, 0);
  const regressions = lanes
    .filter((lane) => lane.gate === "green")
    .reduce((sum, lane) => sum + lane.failed, 0);

  const out = [];
  out.push("# Test report");
  out.push("");
  out.push("Generated by `npm run test:report`. Do not edit by hand - rerun it.");
  out.push("");
  out.push("| | |");
  out.push("| --- | --- |");
  out.push("| Run | " + when + " |");
  out.push("| Branch | `" + branch + "` at `" + commit + "` |");
  out.push("| Node | `" + process.version + "` |");
  out.push("| Regressions | " + (regressions === 0 ? "none" : "**" + regressions + "**") + " |");
  out.push("| Audit findings | " + findings + " |");
  const stranded = lanes.reduce((sum, lane) => sum + lane.unrunnable.length, 0);
  out.push("| Suites that never loaded | " +
    (stranded === 0 ? "none" : "**" + stranded + "**") + " |");
  // What the extra 19,800 cases per property actually bought on this run.
  const seeded = new Set(
    lanes.filter((lane) => !lane.seedless).flatMap((lane) => lane.failures.map((f) => f.name)),
  );
  const fuzzOnly = lanes
    .filter((lane) => lane.seedless)
    .flatMap((lane) => lane.failures.filter((failure) => !seeded.has(failure.name)));
  if (lanes.some((lane) => lane.seedless)) {
    out.push("| Fuzz-only findings | " +
      (fuzzOnly.length === 0 ? "none this run" : "**" + fuzzOnly.length + "**") + " |");
  }
  out.push("");
  out.push("## Lanes");
  out.push("");
  out.push("| Lane | Question | Tests | Passed | Failed | Verdict |");
  out.push("| --- | --- | ---: | ---: | ---: | --- |");
  for (const lane of lanes) {
    // The campaign's raw count is mostly the audit lane's own properties
    // failing again, so the table reports what is new alongside it.
    const cell = lane.seedless && !lane.broken
      ? lane.failed + " red, " + fuzzOnly.length + " new"
      : verdict(lane);
    out.push(
      "| " + lane.title + " | " + lane.blurb + " | " + lane.total + " | " +
      lane.passed + " | " + lane.failed + " | " + cell + " |",
    );
  }
  out.push("");

  for (const lane of lanes) {
    // A seedless lane lists only what the deterministic lanes did not already
    // report. The rest are the same properties failing the same way at a
    // higher case count, and repeating them here would bury the new ones.
    const listed = lane.seedless
      ? lane.failures.filter((failure) => !seeded.has(failure.name))
      : lane.failures;
    if (listed.length === 0) continue;
    out.push("## " + lane.title + " - " + listed.length +
      (lane.gate === "green" ? " regression(s)" : " finding(s)"));
    out.push("");
    if (lane.seedless) {
      out.push("Found by the campaign and NOT by the pinned lane, so each of these");
      out.push("is a lead rather than a reproducible finding: " +
        (lane.failed - listed.length) + " other failure(s) here are the audit");
      out.push("lane's, at a higher case count. Pin the seed fast-check printed as a");
      out.push("property in the audit lane before treating one as fixed.");
      out.push("");
    } else if (lane.gate === "findings") {
      out.push("Red on purpose. Each assertion quotes a line in `docs/` that the");
      out.push("code contradicts, so do not resolve one by weakening the assertion.");
      out.push("");
    }
    let currentFile = null;
    for (const failure of listed) {
      if (failure.file !== currentFile) {
        currentFile = failure.file;
        out.push("### `" + currentFile + "`");
        out.push("");
      }
      out.push("- **" + failure.name + "**");
      out.push("  <br>`" + failure.message.replace(/`/g, "'") + "`");
      for (const line of lane.seedless ? failure.reproduce ?? [] : []) {
        out.push("  <br>`" + line.replace(/`/g, "'") + "`");
      }
    }
    out.push("");
  }

  for (const lane of lanes) {
    if (lane.unrunnable.length === 0) continue;
    out.push("## " + lane.title + " - " + lane.unrunnable.length + " suite(s) that never loaded");
    out.push("");
    out.push("These files did not run at all, so the totals above understate what");
    out.push("is untested by however many tests they hold. This is a broken suite,");
    out.push("not a finding, and it fails the run in either lane.");
    out.push("");
    for (const entry of lane.unrunnable) {
      out.push("- `" + entry.file + "`");
      out.push("  <br>`" + entry.message.replace(/`/g, "'") + "`");
    }
    out.push("");
  }

  out.push("## Not covered");
  out.push("");
  out.push("Stated so the totals above are not read as coverage they are not.");
  out.push("");
  out.push("- The onboarding tour has no automated test. Verified by hand only.");
  out.push("- The share UI has no automated test; the server half of sharing does.");
  out.push("- The fuzz lane is seedless, so its result is this run's sample and");
  out.push("  will not reproduce. Only the audit lane's pinned properties will.");
  out.push("");
  return out.join("\n");
}

const wanted = process.argv.slice(2);
const selected = wanted.length === 0 ? LANES : LANES.filter((lane) => wanted.includes(lane.key));
if (selected.length === 0) {
  console.error("Unknown lane. Known lanes: " + LANES.map((lane) => lane.key).join(", "));
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });
const results = selected.map(runLane);
// REPORT.md is the committed record of a whole run, so only a whole run may
// write it. A single-lane run is for iterating on one lane and must not leave
// a file that looks like the full picture with two thirds of it missing.
const partial = selected.length !== LANES.length;
const reportPath = join(OUT_DIR, partial ? "REPORT.partial.md" : "REPORT.md");
writeFileSync(reportPath, markdown(results), "utf8");

process.stderr.write("\n" + reportPath.replace(ROOT + "/", "") + "\n");

const broken = results.filter((lane) => lane.broken);
if (broken.length > 0) {
  console.error("Lane could not run: " + broken.map((lane) => lane.key).join(", "));
  process.exit(2);
}
// Audit red is the audit working. A baseline failure is not, and neither is a
// suite that never loaded - that one hides tests rather than reporting them.
const regressed = results.filter((lane) => lane.gate === "green" && lane.failed > 0);
const stranded = results.filter((lane) => lane.unrunnable.length > 0);
process.exit(regressed.length > 0 || stranded.length > 0 ? 1 : 0);
