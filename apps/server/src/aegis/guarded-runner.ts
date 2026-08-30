/**
 * PEP - Policy Enforcement Point.
 *
 * Implements AgentRunner and decorates the concrete runner, so AgentService is
 * unchanged except for the object handed to its constructor. This is the entire
 * seam described in the architecture document.
 *
 *   G1 admit    -> refuse before a container exists (zero Ark spend)
 *   G2 confine  -> rewrite argv into the hardened profile
 *   G3 inspect  -> deny mid-stream and reap the container
 *   G4 settle   -> re-attest the protected asset, settle the ledger
 */

import { randomUUID } from "node:crypto";
import { PolicyAbortError } from "../errors.js";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
  RunUsage,
} from "../types.js";
import type { RunSafety, Verdict } from "./types.js";
import { Aegis, ContainmentError, type AdmissionTicket } from "./index.js";
import { hardenContainerArgs, profileEvidence } from "./sandbox/args.js";

interface Live {
  ticket: AdmissionTicket;
  violation: Verdict | null;
  violatedAt: number | null;
  runToken: string;
  /** T6 - Codex items seen so far in this run. */
  steps: number;
}

/** Anything exposing the G2 argv seam. Duck-typed so CodexRunner stays valid. */
interface SupportsArgvTransform {
  setArgvTransform(
    transform: (args: string[], agentId: string) => string[],
  ): void;
}

function supportsArgvTransform(value: unknown): value is SupportsArgvTransform {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SupportsArgvTransform).setArgvTransform === "function"
  );
}

export class GuardedAgentRunner implements AgentRunner {
  private readonly live = new Map<string, Live>();
  /** Safety summary of the most recent run per Agent, read by AgentService. */
  private readonly lastSafety = new Map<string, RunSafety>();

  constructor(
    private readonly inner: AgentRunner,
    private readonly aegis: Aegis,
    private readonly codexHome: string,
  ) {
    if (supportsArgvTransform(inner)) {
      inner.setArgvTransform((args, agentId) => this.harden(args, agentId));
    }
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  cancel(agentId: string): Promise<boolean> {
    return this.inner.cancel(agentId);
  }

  safetyFor(agentId: string): RunSafety | null {
    return this.lastSafety.get(agentId) ?? null;
  }

  /** G2 - the hardened profile. Pure apart from the token it mints. */
  private harden(args: string[], agentId: string): string[] {
    const live = this.live.get(agentId);
    const runToken = live?.runToken ?? randomUUID();
    const hardened = hardenContainerArgs(args, {
      networkMode: this.aegis.networkMode,
      seccompProfilePath: this.aegis.seccompProfilePath,
      brokerUrl: this.aegis.brokerUrl,
      runToken,
      codexHome: this.codexHome,
      forbiddenMounts: [this.aegis.vaultPath],
    });

    if (live) {
      this.aegis.audit.append({
        runId: live.ticket.runId,
        agentId,
        gate: "G2.confinement",
        verdict: {
          decision: "Allow",
          ruleId: "KS-4.profile.strict",
          reason: "Container constructed with the hardened sandbox profile",
          gate: "G2.confinement",
          policyVersion: this.aegis.engine.policyVersion,
          policyHash: this.aegis.engine.policyHash,
          severity: "info",
        },
        evidence: profileEvidence(hardened),
      });
    }
    return hardened;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    // ---- G1 : admission. Throws ContainmentError("blocked") when refused. ----
    const ticket = await this.aegis.admit(request.agentId, request.prompt);
    const live: Live = {
      ticket,
      violation: null,
      violatedAt: null,
      runToken: randomUUID(),
      steps: 0,
    };
    this.live.set(request.agentId, live);
    // The capability exists only while this run does. See EgressBroker.
    this.aegis.grantCapability(live.runToken, request.agentId, ticket.runId);

    // T6 - concurrency limit. Refused before a container exists, so a burst
    // cannot exhaust the host even when every individual run is well behaved.
    if (!this.aegis.acquireSlot(request.agentId)) {
      this.aegis.ledger.release(ticket.agentId, ticket.reservedUsd);
      this.forgetRun(request.agentId, live);
      throw new ContainmentError(
        {
          decision: "Deny",
          ruleId: "KS-6.concurrency.exhausted",
          reason: "Too many runs are already active",
          gate: "G1.preflight",
          policyVersion: this.aegis.engine.policyVersion,
          policyHash: this.aegis.engine.policyHash,
          severity: "warn",
        },
        "blocked",
      );
    }

    // Re-check the latch immediately before spawn, closing the TOCTOU window
    // between admission and execution.
    if (this.aegis.latch.isArmed) {
      this.aegis.ledger.release(ticket.agentId, ticket.reservedUsd);
      this.forgetRun(request.agentId, live);
      throw new ContainmentError(
        {
          decision: "Deny",
          ruleId: "KS-9.killswitch.armed",
          reason: "Kill switch armed between admission and execution",
          gate: "G1.preflight",
          policyVersion: this.aegis.engine.policyVersion,
          policyHash: this.aegis.engine.policyHash,
          severity: "critical",
        },
        "blocked",
      );
    }

    // ---- G3 : interception over the Codex event stream. ----
    const guarded: RunnerRequest = {
      ...request,
      inspect: (line: string): boolean => {
        if (live.violation) return false;

        // T6 - maximum steps. A run that will not stop is contained the same
        // way a malicious one is, because from the outside they look identical.
        live.steps += 1;
        if (this.aegis.maxSteps > 0 && live.steps > this.aegis.maxSteps) {
          live.violation = {
            decision: "Deny",
            ruleId: "KS-6.max-steps.exceeded",
            reason:
              "Run exceeded the maximum of " + this.aegis.maxSteps + " steps",
            gate: "G3.interception",
            policyVersion: this.aegis.engine.policyVersion,
            policyHash: this.aegis.engine.policyHash,
            severity: "warn",
          };
          live.violatedAt = Date.now();
          return false;
        }

        const verdict = this.aegis.inspect(ticket, line);
        if (!verdict) return true;
        live.violation = verdict;
        live.violatedAt = Date.now();
        return false;
      },
    };

    let usage: RunUsage | null = null;
    try {
      const result = await this.inner.run(guarded);
      usage = result.usage;
      await this.finish(live, usage, null);
      return result;
    } catch (error) {
      const violation = live.violation;
      if (violation || error instanceof PolicyAbortError) {
        const verdict: Verdict = violation ?? {
          decision: "Deny",
          ruleId: "AEGIS.aborted",
          reason: "Run aborted by policy",
          gate: "G3.interception",
          policyVersion: this.aegis.engine.policyVersion,
          policyHash: this.aegis.engine.policyHash,
          severity: "critical",
        };
        const containmentMs = live.violatedAt ? Date.now() - live.violatedAt : null;

        this.aegis.audit.append({
          runId: ticket.runId,
          agentId: ticket.agentId,
          gate: "G3.interception",
          verdict,
          evidence: {
            containmentMs: containmentMs ?? -1,
            outcome: "container force-removed",
          },
        });
        this.aegis.breakers.recordViolation(ticket.agentId);
        await this.finish(live, null, { verdict, containmentMs });
        throw new ContainmentError(verdict, "killed");
      }

      // An ordinary failure: settle the ledger so a crashed run does not leak a
      // reservation, then let the original error propagate untouched.
      await this.finish(live, null, null);
      throw error;
    } finally {
      this.aegis.releaseSlot(request.agentId);
      this.forgetRun(request.agentId, live);
    }
  }

  /**
   * Drops the run AND the capability it minted. These have to happen together:
   * a token that outlives its run is an API key with extra steps, and the
   * "dies with the run" property is the entire argument for handing the
   * container a capability instead of the credential.
   */
  private forgetRun(agentId: string, live: Live): void {
    this.live.delete(agentId);
    this.aegis.revokeCapability(live.runToken);
  }

  /** G4 - attestation and ledger settlement. Runs on every exit path. */
  private async finish(
    live: Live,
    usage: RunUsage | null,
    contained: { verdict: Verdict; containmentMs: number | null } | null,
  ): Promise<void> {
    const { attestation, costUsd } = await this.aegis.settle(live.ticket, usage);
    if (!contained && attestation.intact) {
      this.aegis.breakers.recordSuccess(live.ticket.agentId);
    }
    this.lastSafety.set(live.ticket.agentId, {
      verdict: contained?.verdict ?? live.ticket.verdict,
      attestation,
      containmentMs: contained?.containmentMs ?? null,
      costUsd,
      eventCount: this.aegis.audit.byRun(live.ticket.runId).length,
    });
  }
}
