/**
 * AEGIS — Agent Execution Guard and Isolation Subsystem.
 *
 * Track C (Kill Switch) middleware contracts. Everything in this file is data:
 * the decision logic that consumes it lives in ./policy/engine.ts and is pure,
 * so a denial can be reproduced in a unit test without Docker, Ark, or a network.
 */

export type Decision = "Allow" | "Deny";

export type GateId =
  | "G1.preflight"
  | "G2.confinement"
  | "G3.interception"
  | "G4.postflight"
  /** Track B (WARRANT) authorization decisions share this audit chain. */
  | "B.authz"
  /** CONCORD concurrency outcomes: written, merged, conflict, resolved. */
  | "C.concord";

export type Severity = "info" | "warn" | "critical";

export type Scope = "workspace:rw" | "model:invoke" | "net:egress";

export type PolicyAction =
  | "run.start"
  | "fs.read"
  | "fs.write"
  | "net.connect"
  | "proc.exec";

/** A non-human principal derived from an Agent. Always narrower than its owner. */
export interface AgentPrincipal {
  readonly kind: "agent";
  readonly agentId: string;
  readonly ownerId: string;
  readonly scopes: readonly Scope[];
}

export interface PolicyContext {
  readonly runId: string;
  readonly gate: GateId;
  /** A-priori cost estimate in USD. Zero for gates that cannot spend. */
  readonly estimatedCostUsd: number;
  /** Hash only. The prompt itself never enters a policy request or an event. */
  readonly promptSha256: string;
  /**
   * The directory this run's Agent actually works in, IN THE NAMESPACE IT RUNS
   * IN. Under the container runtime that is the bind mount; under
   * `local-process` it is a host path under the workspace root.
   *
   * KS-3 needs this because the two are not the same string. The rule used to
   * compare every path against the container mount unconditionally, so with
   * `RUNTIME_PROVIDER=local-process` an Agent naming its OWN workspace by
   * absolute path was refused - and Codex names its cwd by absolute path
   * constantly. Every local turn died on its first `find`.
   *
   * Per-run rather than per-process also makes the confinement tighter than it
   * was: an Agent is now held to its own directory rather than to whichever
   * mount point the bundle was built with.
   */
  readonly workspacePath?: string | undefined;
}

export interface PolicyRequest {
  readonly principal: AgentPrincipal;
  readonly action: PolicyAction;
  /** Canonical form: "file:/workspace/a.ts", "net:example.com:443", "run:start". */
  readonly resource: string;
  readonly context: PolicyContext;
}

export interface Verdict {
  readonly decision: Decision;
  readonly ruleId: string;
  readonly reason: string;
  readonly gate: GateId;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly severity: Severity;
}

export type Evidence = Readonly<Record<string, string | number | boolean>>;

export interface SafetyEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly seq: number;
  readonly ts: string;
  readonly gate: GateId;
  readonly verdict: Verdict;
  readonly evidence: Evidence;
  readonly prevHash: string;
  readonly hash: string;
}

export interface PolicyRule {
  readonly id: string;
  readonly effect: Decision;
  readonly gate: GateId;
  readonly severity: Severity;
  readonly reason: string;
  readonly when: (request: PolicyRequest) => boolean;
}

export interface PolicyBundle {
  readonly version: string;
  readonly rules: readonly PolicyRule[];
}

/** Result of measuring a protected asset before and after a run. */
export interface Attestation {
  readonly pre: string;
  readonly post: string;
  readonly intact: boolean;
}

export interface RunSafety {
  readonly verdict: Verdict | null;
  readonly attestation: Attestation | null;
  readonly containmentMs: number | null;
  readonly costUsd: number | null;
  readonly eventCount: number;
}

export type BreakerState = "Closed" | "Open" | "HalfOpen";
