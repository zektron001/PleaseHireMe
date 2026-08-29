import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attest, compare, ABSENT_ROOT } from "./attest.js";
import { AuditLog, GENESIS } from "./audit.js";
import { Redactor } from "./redact.js";
import { BreakerRegistry } from "./state/breaker.js";
import { BudgetLedger, DEFAULT_LEDGER, realisedCost } from "./state/ledger.js";
import { KillLatch } from "./state/latch.js";
import {
  hardenContainerArgs,
  profileEvidence,
  SandboxProfileError,
} from "./sandbox/args.js";
import type { SafetyEvent, Verdict } from "./types.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aegis-test-"));
});
afterEach(async () => {
  // AuditLog.append queues its disk write on purpose so enforcement never
  // blocks on I/O, which means a write can still be in flight here.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

// ---------------------------------------------------------------- KS-1/3/4/7
describe("G2 hardened sandbox profile", () => {
  const baseline = [
    "run",
    "--rm",
    "--init",
    "--name",
    "launchpad-default-agent",
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    "2",
    "--env",
    "ARK_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--mount",
    "type=bind,src=/ws/agent,dst=/workspace",
    "--mount",
    "type=bind,src=/home/u/codex-home,dst=/codex-home",
    "--workdir",
    "/workspace",
    "volc-agent-runtime:local",
    "codex",
    "exec",
    "--json",
  ];

  const options = {
    networkMode: "aegis-egress",
    seccompProfilePath: "/data/aegis-seccomp.json",
    brokerUrl: "http://aegis-broker:8080",
    runToken: "token-123",
    codexHome: "/home/u/codex-home",
    forbiddenMounts: ["/srv/vault"],
  };

  it("removes the bridge network (KS-1)", () => {
    const args = hardenContainerArgs(baseline, options);
    expect(args).not.toContain("bridge");
    expect(args[args.indexOf("--network") + 1]).toBe("aegis-egress");
    expect(args.filter((a) => a === "--network")).toHaveLength(1);
  });

  it("removes the raw Ark key from the container env (KS-7)", () => {
    const args = hardenContainerArgs(baseline, options);
    expect(args).not.toContain("ARK_API_KEY");
    expect(args).toContain("AEGIS_BROKER=http://aegis-broker:8080");
    expect(args).toContain("AEGIS_RUN_TOKEN=token-123");
  });

  it("re-mounts the Codex home read-only (KS-3)", () => {
    const args = hardenContainerArgs(baseline, options);
    const mount = args.find((a) => a.includes("dst=/codex-home"));
    expect(mount).toBe(
      "type=bind,src=/home/u/codex-home,dst=/codex-home,readonly",
    );
  });

  it("leaves the workspace mount writable", () => {
    const args = hardenContainerArgs(baseline, options);
    expect(args).toContain("type=bind,src=/ws/agent,dst=/workspace");
  });

  it("adds read-only rootfs, noexec tmpfs and the seccomp profile (KS-4)", () => {
    const args = hardenContainerArgs(baseline, options);
    expect(args).toContain("--read-only");
    expect(args).toContain("/tmp:rw,noexec,nosuid,size=64m");
    expect(args).toContain("seccomp=/data/aegis-seccomp.json");
  });

  it("keeps every baseline limit intact", () => {
    const args = hardenContainerArgs(baseline, options);
    for (const flag of ["--cap-drop", "ALL", "--cpus", "no-new-privileges"]) {
      expect(args).toContain(flag);
    }
  });

  it("injects flags before the image, never after it", () => {
    const args = hardenContainerArgs(baseline, options);
    const image = args.indexOf("volc-agent-runtime:local");
    expect(args.indexOf("--read-only")).toBeLessThan(image);
    expect(args.indexOf("--network")).toBeLessThan(image);
    expect(args[image + 1]).toBe("codex");
  });

  it("refuses to build argv that names the protected vault (KS-2)", () => {
    const leaky = [...baseline];
    leaky.splice(2, 0, "--mount", "type=bind,src=/srv/vault,dst=/vault");
    expect(() => hardenContainerArgs(leaky, options)).toThrow(SandboxProfileError);
  });

  it("summarises the profile for the audit event", () => {
    const evidence = profileEvidence(hardenContainerArgs(baseline, options));
    expect(evidence).toMatchObject({
      network: "aegis-egress",
      egressConfined: true,
      rootfs: "read-only",
      seccomp: "aegis-strict-v1",
      tmpfsNoexec: true,
      arkKeyInEnv: false,
    });
  });

  it("reports the baseline as unconfined, so the diff is visible", () => {
    const evidence = profileEvidence(baseline);
    expect(evidence).toMatchObject({
      network: "bridge",
      egressConfined: false,
      rootfs: "writable",
      arkKeyInEnv: true,
    });
  });
});

// ---------------------------------------------------------------------- KS-8
describe("KS-8 redaction", () => {
  const SENTINEL = "ark-supersecretkey-abcdef123456";
  const redactor = new Redactor([SENTINEL, "a-very-long-auth-token-value"]);

  it("masks an exact known secret", () => {
    const out = redactor.text("export ARK_API_KEY=" + SENTINEL + " && run");
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("[REDACTED:secret]");
  });

  it("masks structural secrets it was never told about", () => {
    expect(redactor.text("Authorization: Bearer abcdef1234567890")).not.toContain(
      "abcdef1234567890",
    );
    expect(
      redactor.text("curl https://user:hunter2@example.com/x"),
    ).not.toContain("hunter2");
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
      ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const masked = redactor.text("token " + jwt);
    expect(masked).toContain("[REDACTED:jwt]");
    expect(masked).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
  });

  it("recurses through objects and arrays, preserving shape", () => {
    const input = {
      a: SENTINEL,
      b: [1, { c: "prefix " + SENTINEL }],
      d: true,
      e: null,
    };
    const out = redactor.value(input);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(out.b[1]).toHaveProperty("c");
    expect(out.d).toBe(true);
    expect(out.e).toBeNull();
  });

  it("ignores short or empty configured secrets", () => {
    const loose = new Redactor(["", "  ", "abc"]);
    expect(loose.text("abc def")).toBe("abc def");
  });
});

// ---------------------------------------------------------------------- KS-5
describe("KS-5 attestation", () => {
  it("returns a sentinel for a path that does not exist", async () => {
    expect(await attest(path.join(dir, "nope"))).toBe(ABSENT_ROOT);
  });

  it("is stable across repeated measurement", async () => {
    const vault = path.join(dir, "vault");
    await mkdir(vault);
    await writeFile(path.join(vault, "customers.db"), "id,name\n1,ada\n");
    const first = await attest(vault);
    const second = await attest(vault);
    expect(first).toBe(second);
    expect(compare(first, second).intact).toBe(true);
  });

  it("detects a single mutated byte", async () => {
    const vault = path.join(dir, "vault");
    await mkdir(vault);
    const file = path.join(vault, "customers.db");
    await writeFile(file, "id,name\n1,ada\n");
    const pre = await attest(vault);

    await writeFile(file, "id,name\n1,adb\n");
    const post = await attest(vault);

    expect(post).not.toBe(pre);
    expect(compare(pre, post).intact).toBe(false);
  });

  it("detects an added file", async () => {
    const vault = path.join(dir, "vault");
    await mkdir(vault);
    await writeFile(path.join(vault, "a"), "1");
    const pre = await attest(vault);
    await writeFile(path.join(vault, "b"), "2");
    expect(await attest(vault)).not.toBe(pre);
  });

  it("detects a deleted file", async () => {
    const vault = path.join(dir, "vault");
    await mkdir(vault);
    await writeFile(path.join(vault, "a"), "1");
    await writeFile(path.join(vault, "b"), "2");
    const pre = await attest(vault);
    await rm(path.join(vault, "b"));
    expect(await attest(vault)).not.toBe(pre);
  });
});

// ------------------------------------------------------------------ audit L6
describe("hash-chained audit log", () => {
  const verdict: Verdict = {
    decision: "Deny",
    ruleId: "KS-1.egress.deny-non-allowlisted",
    reason: "Destination is not allowlisted",
    gate: "G3.interception",
    policyVersion: "1.0.0",
    policyHash: "f".repeat(64),
    severity: "critical",
  };

  it("chains records and verifies clean", async () => {
    const log = new AuditLog(path.join(dir, "audit.jsonl"), new Redactor([]));
    await log.initialize();
    const first = log.append({ runId: "r1", agentId: "a1", gate: "G1.preflight", verdict });
    const second = log.append({ runId: "r1", agentId: "a1", gate: "G3.interception", verdict });

    expect(first.prevHash).toBe(GENESIS);
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBe(1);
    expect(log.verify()).toBe(-1);
  });

  it("detects a tampered record at its index", async () => {
    const log = new AuditLog(path.join(dir, "audit.jsonl"), new Redactor([]));
    await log.initialize();
    log.append({ runId: "r1", agentId: "a1", gate: "G1.preflight", verdict });
    log.append({ runId: "r1", agentId: "a1", gate: "G3.interception", verdict });
    const events = log.byRun("r1");

    const forged = events.map((event, index): SafetyEvent =>
      index === 1
        ? { ...event, verdict: { ...event.verdict, decision: "Allow" } }
        : event,
    );
    expect(log.verify(forged)).toBe(1);
  });

  it("redacts a secret before it reaches the file", async () => {
    const SENTINEL = "ark-verysecret-000111222";
    const file = path.join(dir, "audit.jsonl");
    const log = new AuditLog(file, new Redactor([SENTINEL]));
    await log.initialize();
    log.append({
      runId: "r1",
      agentId: "a1",
      gate: "G3.interception",
      verdict: { ...verdict, reason: "leaked " + SENTINEL },
      evidence: { command: "echo " + SENTINEL },
    });
    await log.flush();

    const onDisk = await readFile(file, "utf8");
    expect(onDisk).not.toContain(SENTINEL);
    expect(onDisk).toContain("[REDACTED:secret]");
  });

  it("reloads an existing chain and keeps appending validly", async () => {
    const file = path.join(dir, "audit.jsonl");
    const first = new AuditLog(file, new Redactor([]));
    await first.initialize();
    first.append({ runId: "r1", agentId: "a1", gate: "G1.preflight", verdict });
    await first.flush();

    const reopened = new AuditLog(file, new Redactor([]));
    await reopened.initialize();
    reopened.append({ runId: "r1", agentId: "a1", gate: "G4.postflight", verdict });
    expect(reopened.verify()).toBe(-1);
  });
});

// ------------------------------------------------------------------ KS-9 / 6
describe("KS-9 kill latch", () => {
  it("arms, reports a reason, and disarms", () => {
    const latch = new KillLatch();
    expect(latch.isArmed).toBe(false);
    const armed = latch.arm("attestation failed");
    expect(armed.armed).toBe(true);
    expect(armed.reason).toBe("attestation failed");
    expect(armed.since).not.toBeNull();
    expect(latch.disarm().armed).toBe(false);
  });
});

describe("KS-9 circuit breaker", () => {
  it("opens on the first violation and refuses the next run", () => {
    const breakers = new BreakerRegistry();
    expect(breakers.admits("a")).toBe(true);
    expect(breakers.recordViolation("a")).toBe("Open");
    expect(breakers.admits("a")).toBe(false);
  });

  it("half-opens after the cooldown and admits exactly one probe", () => {
    let clock = 1_000;
    const breakers = new BreakerRegistry(
      { threshold: 1, windowMs: 600_000, cooldownMs: 60_000, maxCooldownMs: 900_000 },
      () => clock,
    );
    breakers.recordViolation("a");
    expect(breakers.state("a")).toBe("Open");

    clock += 61_000;
    expect(breakers.state("a")).toBe("HalfOpen");
    expect(breakers.admits("a")).toBe(true);
    expect(breakers.admits("a")).toBe(false); // only one probe
  });

  it("closes again after a successful probe", () => {
    const breakers = new BreakerRegistry();
    breakers.recordViolation("a");
    expect(breakers.recordSuccess("a")).toBe("Closed");
    expect(breakers.admits("a")).toBe(true);
  });

  it("isolates Agents from one another", () => {
    const breakers = new BreakerRegistry();
    breakers.recordViolation("a");
    expect(breakers.admits("a")).toBe(false);
    expect(breakers.admits("b")).toBe(true);
  });
});

describe("budget ledger", () => {
  it("computes realised cost from Ark usage", () => {
    const cost = realisedCost(
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 },
      DEFAULT_LEDGER.pricing,
    );
    expect(cost).toBeCloseTo(0.6 + 2.4, 6);
  });

  it("prices cached input at the cheaper rate", () => {
    const cost = realisedCost(
      { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 },
      DEFAULT_LEDGER.pricing,
    );
    expect(cost).toBeCloseTo(0.15, 6);
  });

  it("reserves then settles, so concurrent runs cannot overshoot", () => {
    const ledger = new BudgetLedger({ ...DEFAULT_LEDGER, agentBudgetUsd: 0.02 });
    expect(ledger.reserve("a", 0.01)).toBe(true);
    expect(ledger.reserve("a", 0.01)).toBe(true);
    // Third concurrent reservation does not fit.
    expect(ledger.reserve("a", 0.01)).toBe(false);
  });

  it("frees the reservation when a run spends nothing", () => {
    const ledger = new BudgetLedger({ ...DEFAULT_LEDGER, agentBudgetUsd: 0.02 });
    ledger.reserve("a", 0.02);
    expect(ledger.remainingUsd("a")).toBe(0);
    ledger.release("a", 0.02);
    expect(ledger.remainingUsd("a")).toBeCloseTo(0.02, 6);
  });

  it("respects the tenant ceiling across Agents", () => {
    const ledger = new BudgetLedger({
      ...DEFAULT_LEDGER,
      agentBudgetUsd: 10,
      tenantBudgetUsd: 0.03,
    });
    expect(ledger.reserve("a", 0.02)).toBe(true);
    expect(ledger.reserve("b", 0.02)).toBe(false);
  });
});

// ---------------------------------------------------------------------- T7
describe("T7 capture level and retention", () => {
  const verdict: Verdict = {
    decision: "Deny",
    ruleId: "KS-1.egress.deny-non-allowlisted",
    reason: "not allowlisted",
    gate: "G3.interception",
    policyVersion: "1.0.0",
    policyHash: "f".repeat(64),
    severity: "critical",
  };
  const entry = (runId = "r1") => ({
    runId,
    agentId: "a1",
    gate: "G3.interception" as const,
    verdict,
    evidence: { command: "curl https://attacker.example", bytes: 42 },
  });

  it('writes no evidence payload at all on "minimal"', async () => {
    const log = new AuditLog(
      path.join(dir, "a.jsonl"),
      new Redactor([]),
      "minimal",
    );
    await log.initialize();
    const event = log.append(entry());
    expect(event.evidence).toEqual({});

    await log.flush();
    const onDisk = await readFile(path.join(dir, "a.jsonl"), "utf8");
    expect(onDisk).not.toContain("attacker.example");
  });

  it('keeps redacted evidence on "standard"', async () => {
    const log = new AuditLog(path.join(dir, "b.jsonl"), new Redactor([]), "standard");
    await log.initialize();
    expect(log.append(entry()).evidence).toMatchObject({ bytes: 42 });
  });

  it("prunes to the retained maximum and counts what it dropped", async () => {
    const log = new AuditLog(path.join(dir, "c.jsonl"), new Redactor([]), "standard", {
      maxEvents: 3,
      maxAgeMs: 60_000,
    });
    await log.initialize();
    for (let i = 0; i < 10; i += 1) log.append(entry("r" + i));

    expect(log.retained).toBe(3);
    expect(log.pruned).toBe(7);
  });

  it("still verifies exactly after pruning, via the anchor", async () => {
    const log = new AuditLog(path.join(dir, "d.jsonl"), new Redactor([]), "standard", {
      maxEvents: 3,
      maxAgeMs: 60_000,
    });
    await log.initialize();
    for (let i = 0; i < 10; i += 1) log.append(entry("r" + i));

    // Pruning is a real discontinuity; the anchor is what keeps verification
    // meaningful over the window that survives.
    expect(log.chainAnchor).not.toBe(GENESIS);
    expect(log.verify()).toBe(-1);
  });

  it("prunes records older than the age limit", async () => {
    let clock = 1_000_000;
    const log = new AuditLog(
      path.join(dir, "e.jsonl"),
      new Redactor([]),
      "standard",
      { maxEvents: 1000, maxAgeMs: 5_000 },
      () => clock,
    );
    await log.initialize();
    log.append(entry("old"));
    expect(log.retained).toBe(1);

    clock += 10_000;
    log.append(entry("new"));
    expect(log.retained).toBe(1);
    expect(log.pruned).toBe(1);
    expect(log.verify()).toBe(-1);
  });
});
