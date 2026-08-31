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
    return { ...lane, broken: true, total: 0, passed: 0, failed: 0, failures: [] };
  }

  const failures = [];
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      if (test.status !== "failed") continue;
      failures.push({
        file: (file.name ?? "").replace(ROOT + "/", ""),
        name: [...(test.ancestorTitles ?? []), test.title].filter(Boolean).join(" › "),
        // First line only. The full assertion diff is in the JSON next to
        // this file; what a reader needs here is which claim broke.
        message: (test.failureMessages ?? [])
          .join("\n")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? "(no message)",
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
  };
  process.stderr.write(lastRun.passed + "/" + lastRun.total + " passed\n");
  return lastRun;
}

function verdict(lane) {
  if (lane.broken) return "**could not run**";
  if (lane.gate === "green") return lane.failed === 0 ? "green" : "**REGRESSION**";
  return lane.failed === 0 ? "no findings" : lane.failed + " findings";
}

function markdown(lanes) {
  const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = sh("git", ["rev-parse", "--short", "HEAD"]);
  const findings = lanes
    .filter((lane) => lane.gate === "findings")
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
  out.push("");
  out.push("## Lanes");
  out.push("");
  out.push("| Lane | Question | Tests | Passed | Failed | Verdict |");
  out.push("| --- | --- | ---: | ---: | ---: | --- |");
  for (const lane of lanes) {
    out.push(
      "| " + lane.title + " | " + lane.blurb + " | " + lane.total + " | " +
      lane.passed + " | " + lane.failed + " | " + verdict(lane) + " |",
    );
  }
  out.push("");

  for (const lane of lanes) {
    if (lane.failures.length === 0) continue;
    out.push("## " + lane.title + " - " + lane.failures.length +
      (lane.gate === "green" ? " regression(s)" : " finding(s)"));
    out.push("");
    if (lane.gate === "findings") {
      out.push("Red on purpose. Each assertion quotes a line in `docs/` that the");
      out.push("code contradicts, so do not resolve one by weakening the assertion.");
      out.push("");
    }
    let currentFile = null;
    for (const failure of lane.failures) {
      if (failure.file !== currentFile) {
        currentFile = failure.file;
        out.push("### `" + currentFile + "`");
        out.push("");
      }
      out.push("- **" + failure.name + "**");
      out.push("  <br>`" + failure.message.replace(/`/g, "'") + "`");
    }
    out.push("");
  }

  out.push("## Not covered");
  out.push("");
  out.push("Stated so the totals above are not read as coverage they are not.");
  out.push("");
  out.push("- The onboarding tour has no automated test. Verified by hand only.");
  out.push("- The share UI has no automated test; the server half of sharing does.");
  out.push("- `npm run test:fuzz` is on demand and is not one of the lanes above.");
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
// Audit red is the audit working. Only a baseline failure fails this command.
const regressed = results.filter((lane) => lane.gate === "green" && lane.failed > 0);
process.exit(regressed.length > 0 ? 1 : 0);
