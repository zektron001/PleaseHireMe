/**
 * AEGIS facade. Owns the policy plane and is the only object AgentService and
 * the routes need to know about.
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type {
  AgentPrincipal,
  Attestation,
  GateId,
  PolicyContext,
  PolicyRequest,
  Verdict,
} from "./types.js";
import type { RunUsage } from "../types.js";
import { attest, compare, shortRoot } from "./attest.js";
import { AuditLog } from "./audit.js";
import { extractRequests } from "./policy/extract.js";
import { PolicyEngine } from "./policy/engine.js";
import { bundleHash, createBundle } from "./policy/bundle.js";
import { Redactor } from "./redact.js";
import { BreakerRegistry, DEFAULT_BREAKER } from "./state/breaker.js";
import { BudgetLedger, DEFAULT_LEDGER } from "./state/ledger.js";
import { KillLatch } from "./state/latch.js";
import { SECCOMP_STRICT } from "./sandbox/seccomp.js";
import { mkdir, writeFile } from "node:fs/promises";

export const OPERATOR_ID = "operator:local";
export const WORKSPACE_MOUNT = "/workspace";

/** Raised when a gate refuses or terminates a run. */
export class ContainmentError extends Error {
  constructor(
    readonly verdict: Verdict,
    readonly outcome: "blocked" | "killed",
  ) {
    super(verdict.reason);
    this.name = "ContainmentError";
  }
}

export interface AdmissionTicket {
  readonly runId: string;
  readonly agentId: string;
  readonly principal: AgentPrincipal;
  readonly reservedUsd: number;
  readonly preRoot: string;
  readonly verdict: Verdict;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function principalFor(agentId: string): AgentPrincipal {
  return {
    kind: "agent",
    agentId,
    ownerId: OPERATOR_ID,
    // Deliberately narrower than the operator: no net:egress scope, because the
    // Agent never reaches the network directly - the broker does.
    scopes: ["workspace:rw", "model:invoke"],
  };
}

export class Aegis {
  private constructor(
    readonly engine: PolicyEngine,
    readonly audit: AuditLog,
    readonly ledger: BudgetLedger,
    readonly breakers: BreakerRegistry,
    readonly latch: KillLatch,
    readonly redactor: Redactor,
    readonly vaultPath: string,
    readonly seccompProfilePath: string,
    readonly networkMode: string,
    readonly brokerUrl: string,
    /** T6 - Codex items a single run may produce. 0 disables the cap. */
    readonly maxSteps: number,
    private readonly maxConcurrentRuns: number,
  ) {}

  /** T6 - concurrency limit. Held for the life of a run. */
  private readonly liveRuns = new Set<string>();

  acquireSlot(agentId: string): boolean {
    if (this.liveRuns.size >= this.maxConcurrentRuns) return false;
    this.liveRuns.add(agentId);
    return true;
  }

  releaseSlot(agentId: string): void {
    this.liveRuns.delete(agentId);
  }

  get activeRuns(): number {
    return this.liveRuns.size;
  }

  static async bootstrap(config: AppConfig): Promise<Aegis> {
    const vaultPath = path.resolve(config.aegisVaultPath);
    const redactor = new Redactor([config.arkApiKey, config.authToken]);

    const ledger = new BudgetLedger({
      ...DEFAULT_LEDGER,
      agentBudgetUsd: config.aegisAgentBudgetUsd,
      tenantBudgetUsd: config.aegisTenantBudgetUsd,
    });

    const arkHost = (() => {
      try {
        return new URL(config.arkBaseUrl).hostname.toLowerCase();
      } catch {
        return "ark.cn-beijing.volces.com";
      }
    })();

    const bundle = createBundle({
      egressAllowlist: [arkHost],
      workspaceMount: WORKSPACE_MOUNT,
      // Any path containing these segments is refused, in every namespace.
      vaultMarkers: ["/vault", path.basename(vaultPath)],
      remainingBudgetUsd: (agentId) => ledger.remainingUsd(agentId),
    });

    // KS-4 - materialise the seccomp profile where the engine can read it.
    await mkdir(config.dataDirectory, { recursive: true });
    const seccompPath = config.aegisSeccompProfile
      ? path.resolve(config.aegisSeccompProfile)
      : path.join(config.dataDirectory, "aegis-seccomp.json");
    if (!config.aegisSeccompProfile) {
      await writeFile(seccompPath, JSON.stringify(SECCOMP_STRICT, null, 2), {
        encoding: "utf8",
        mode: 0o644,
      });
    }

    const engine = new PolicyEngine(bundle);
    const audit = new AuditLog(
      path.join(config.dataDirectory, "aegis-audit.jsonl"),
      redactor,
      config.aegisCaptureLevel,
      {
        maxEvents: config.aegisRetentionMaxEvents,
        maxAgeMs: config.aegisRetentionMaxAgeMs,
      },
    );
    await audit.initialize();

    return new Aegis(
      engine,
      audit,
      ledger,
      new BreakerRegistry(DEFAULT_BREAKER),
      new KillLatch(),
      redactor,
      vaultPath,
      seccompPath,
      config.aegisNetworkMode,
      config.aegisBrokerUrl,
      config.aegisMaxSteps,
      config.aegisMaxConcurrentRuns,
    );
  }

  context(runId: string, gate: GateId, prompt: string, estimate = 0): PolicyContext {
    return {
      runId,
      gate,
      estimatedCostUsd: estimate,
      promptSha256: sha256(prompt),
    };
  }

  /** G1 - admission. Throws ContainmentError("blocked") when refused. */
  async admit(agentId: string, prompt: string): Promise<AdmissionTicket> {
    const runId = randomUUID();
    const principal = principalFor(agentId);
    const estimate = this.ledger.estimate(agentId);
    const context = this.context(runId, "G1.preflight", prompt, estimate);

    const refuse = (
      ruleId: string,
      reason: string,
      severity: Verdict["severity"],
    ): never => {
      const verdict: Verdict = {
        decision: "Deny",
        ruleId,
        reason,
        gate: "G1.preflight",
        policyVersion: this.engine.policyVersion,
        policyHash: this.engine.policyHash,
        severity,
      };
      this.audit.append({ runId, agentId, gate: "G1.preflight", verdict });
      throw new ContainmentError(verdict, "blocked");
    };

    if (this.latch.isArmed) {
      refuse(
        "KS-9.killswitch.armed",
        "The global kill switch is armed: " + this.latch.state().reason,
        "critical",
      );
    }
    if (!this.breakers.admits(agentId)) {
      refuse(
        "KS-9.breaker.open",
        "This Agent's circuit breaker is open after a policy violation",
        "warn",
      );
    }

    const request: PolicyRequest = {
      principal,
      action: "run.start",
      resource: "run:start",
      context,
    };
    const verdict = this.engine.evaluate(request);
    if (verdict.decision === "Deny") {
      this.audit.append({
        runId,
        agentId,
        gate: "G1.preflight",
        verdict,
        evidence: { estimatedCostUsd: estimate },
      });
      throw new ContainmentError(verdict, "blocked");
    }

    if (!this.ledger.reserve(agentId, estimate)) {
      refuse(
        "KS-6.budget.exhausted",
        "Estimated cost exceeds the remaining budget for this Agent",
        "warn",
      );
    }

    const preRoot = await attest(this.vaultPath);
    this.audit.append({
      runId,
      agentId,
      gate: "G1.preflight",
      verdict,
      evidence: {
        estimatedCostUsd: estimate,
        remainingUsd: this.ledger.remainingUsd(agentId),
        vaultPreRoot: shortRoot(preRoot),
      },
    });

    return { runId, agentId, principal, reservedUsd: estimate, preRoot, verdict };
  }

  /**
   * G3 - inspects one Codex event line. Returns a denial Verdict, or null to
   * continue. Detective only: see the note in policy/extract.ts.
   */
  inspect(ticket: AdmissionTicket, line: string): Verdict | null {
    const context = this.context(ticket.runId, "G3.interception", "");
    const requests = extractRequests(line, {
      principal: ticket.principal,
      context,
    });
    if (requests.length === 0) return null;
    return this.engine.firstDenial(requests);
  }

  /** G4 - re-measures the protected asset and settles the ledger. */
  async settle(
    ticket: AdmissionTicket,
    usage: RunUsage | null,
  ): Promise<{ attestation: Attestation; costUsd: number }> {
    const postRoot = await attest(this.vaultPath);
    const attestation = compare(ticket.preRoot, postRoot);
    const costUsd = this.ledger.settle(ticket.agentId, ticket.reservedUsd, usage);

    const verdict: Verdict = {
      decision: attestation.intact ? "Allow" : "Deny",
      ruleId: attestation.intact
        ? "KS-5.attestation.intact"
        : "KS-5.attestation.violated",
      reason: attestation.intact
        ? "Protected asset is byte-identical to the pre-run measurement"
        : "Protected asset changed during this run",
      gate: "G4.postflight",
      policyVersion: this.engine.policyVersion,
      policyHash: this.engine.policyHash,
      severity: attestation.intact ? "info" : "critical",
    };

    this.audit.append({
      runId: ticket.runId,
      agentId: ticket.agentId,
      gate: "G4.postflight",
      verdict,
      evidence: {
        preRoot: shortRoot(attestation.pre),
        postRoot: shortRoot(attestation.post),
        intact: attestation.intact,
        costUsd,
      },
    });

    if (!attestation.intact) {
      // A protected asset changed. Nothing about this run is trustworthy, so the
      // platform stops accepting work until an operator has looked at it.
      this.latch.arm(
        "Attestation failed for run " + ticket.runId + " - vault integrity lost",
      );
    }
    return { attestation, costUsd };
  }

  status(): Record<string, unknown> {
    return {
      policyVersion: this.engine.policyVersion,
      policyHash: this.engine.policyHash.slice(0, 12),
      latch: this.latch.state(),
      breakers: this.breakers.snapshot(),
      budget: this.ledger.snapshot(),
      chainHead: this.audit.chainHead.slice(0, 12),
      networkMode: this.networkMode,
      vaultPath: this.vaultPath,
      maxSteps: this.maxSteps,
      activeRuns: this.activeRuns,
      maxConcurrentRuns: this.maxConcurrentRuns,
      captureLevel: this.audit.level,
      retained: this.audit.retained,
      pruned: this.audit.pruned,
    };
  }

  policyDigest(): Record<string, unknown> {
    return {
      version: this.engine.policyVersion,
      hash: this.engine.policyHash,
      rules: this.engine.summary(),
    };
  }
}

export { bundleHash, createBundle, PolicyEngine, attest, compare, shortRoot };
