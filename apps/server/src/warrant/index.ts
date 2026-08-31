/**
 * WARRANT facade - the single object the routes talk to.
 *
 * Track B (The Bouncer). Every authorization decision made anywhere in the
 * platform flows through `check()`, is decided by the pure PDP, and is written
 * to the same hash-chained audit log AEGIS uses - so one verifiable chain holds
 * both the safety and the authorization record.
 */

import path from "node:path";
import type { AppConfig } from "../config.js";
import { AuditLog } from "../aegis/audit.js";
import { Redactor } from "../aegis/redact.js";
import type { Verdict } from "../aegis/types.js";
import { authorize, type AuthzFacts } from "./policy.js";
import { Orchestrator, ORCHESTRATOR_ID } from "./orchestrator.js";
import { Registry } from "./registry.js";
import { ShareRegistry } from "./sharing.js";
import { createSplitter } from "./splitter.js";
import { tiersFrom } from "./model-policy.js";
import { SubtaskWorkspaceManager } from "./workspaces.js";
import { WarrantBinder } from "./binding.js";
import { docResource, SharedDocStore, type ConcordEvent } from "../concord/store.js";
import { WorkspaceReconciler } from "../concord/reconcile.js";
import { warrantAuthzCheck } from "../concord/routes.js";
import type { AuthzDecision, HumanPrincipal, WarrantAction } from "./types.js";

export const POLICY_VERSION = "warrant-1.0.0";

export interface CheckInput {
  /** Session token, when a human is the caller. Never a client-supplied id. */
  readonly token?: string | undefined;
  /** Agent acting under a warrant, when an Agent is the caller. */
  readonly agentId?: string | undefined;
  readonly action: WarrantAction;
  readonly resource: string;
  /** For merge.integrate. */
  readonly taskId?: string | undefined;
}

export class WarrantPlane {
  /** CONCORD - shared concurrent documents, guarded by this same PDP. */
  readonly docs: SharedDocStore;
  /** The runtime seam: shared files in and out of a workspace around each turn. */
  readonly reconciler: WorkspaceReconciler;
  /** Document sharing - the ACL that mints warrants. See sharing.ts. */
  readonly shares: ShareRegistry;

  private constructor(
    readonly registry: Registry,
    readonly orchestrator: Orchestrator,
    readonly audit: AuditLog,
    readonly workspaces: SubtaskWorkspaceManager,
    readonly binder: WarrantBinder,
    documentPath?: string,
  ) {
    this.docs = new SharedDocStore(warrantAuthzCheck(this), Date.now, {
      persistPath: documentPath,
      // Concurrency outcomes join the authorization decisions already in the
      // chain, so "both edits survived" is evidence rather than an assertion.
      onEvent: (event) => this.recordConcord(event),
    });
    this.reconciler = new WorkspaceReconciler(this.docs);
    this.shares = new ShareRegistry(registry);
  }

  /**
   * `sharedAudit` is AEGIS's chain. The module header claims authorization and
   * safety records share one verifiable chain, and until now they did not: each
   * plane built its own AuditLog over its own file, so an egress crossing and
   * the authorization behind it landed in different chains and no single view
   * could show both. Passing AEGIS's log in makes the claim true. Tests that
   * build a plane on its own still get their own chain.
   */
  static async bootstrap(
    config: AppConfig,
    sharedAudit?: AuditLog,
  ): Promise<WarrantPlane> {
    const registry = new Registry();
    const workspaces = new SubtaskWorkspaceManager(
      path.join(config.workspaceRoot, "subtasks"),
    );
    await workspaces.initialize();

    const orchestrator = new Orchestrator(
      registry,
      createSplitter(config),
      tiersFrom(config.arkModel || "ep-not-configured"),
      Date.now,
      workspaces,
    );
    const audit =
      sharedAudit ??
      new AuditLog(
      path.join(config.dataDirectory, "warrant-audit.jsonl"),
      new Redactor([config.arkApiKey, config.authToken]),
      config.aegisCaptureLevel,
      {
        maxEvents: config.aegisRetentionMaxEvents,
        maxAgeMs: config.aegisRetentionMaxAgeMs,
      },
    );
    if (!sharedAudit) await audit.initialize();

    // Two mock humans, as Track B requires. Section 8 blesses mock users.
    registry.addHuman("alice", "Alice Chen");
    registry.addHuman("bob", "Bob Okafor");
    registry.addHuman("orchestrator", "Task Orchestrator");

    const plane = new WarrantPlane(
      registry,
      orchestrator,
      audit,
      workspaces,
      new WarrantBinder(registry, orchestrator, workspaces),
      path.join(config.dataDirectory, "concord-docs.json"),
    );
    await plane.docs.initialize();
    return plane;
  }

  /** The only way to learn who is calling. See registry.resolveSession. */
  whoami(token: string | undefined): HumanPrincipal | null {
    return this.registry.resolveSession(token);
  }

  /**
   * The single enforcement entry point. Resolves facts, calls the pure PDP,
   * writes the five-tuple to the audit chain, and returns the decision.
   */
  check(input: CheckInput): AuthzDecision {
    const human = this.registry.resolveSession(input.token);
    const warrant = input.agentId
      ? // Deliberately looks up by AGENT, not by a client-supplied warrant id:
        // a caller cannot nominate which warrant authorises it.
        (this.registry.warrantForAgent(input.agentId) ??
          this.lastWarrantForAgent(input.agentId))
      : null;
    const agent = warrant ? this.registry.principalFor(warrant) : null;

    const taskId =
      input.taskId ??
      (input.agentId
        ? (this.orchestrator.subtaskByAgent(input.agentId)?.taskId ?? "")
        : "");

    const facts: AuthzFacts = {
      now: Date.now(),
      resourceOwnerId: this.orchestrator.ownerOfResource(input.resource),
      isOrchestrator: human?.id === ORCHESTRATOR_ID,
      allSubtasksApproved: taskId ? this.orchestrator.allApproved(taskId) : false,
      pendingSubtaskIds: taskId ? this.orchestrator.pendingApprovals(taskId) : [],
    };

    const decision = authorize({
      human,
      agent,
      warrant,
      action: input.action,
      resource: input.resource,
      facts,
    });

    this.record(decision);
    return decision;
  }

  /**
   * A revoked or expired warrant must still be FOUND, so the denial can say
   * "revoked" rather than the much less useful "no warrant".
   */
  private lastWarrantForAgent(agentId: string) {
    const candidates = this.registry
      .listWarrants()
      .filter((w) => w.agentId === agentId)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    return candidates[0] ?? null;
  }

  /** Writes the Track B five-tuple into the shared hash chain. */
  record(decision: AuthzDecision): void {
    const verdict: Verdict = {
      decision: decision.decision,
      ruleId: decision.ruleId,
      reason: decision.reason,
      gate: "B.authz",
      policyVersion: POLICY_VERSION,
      policyHash: POLICY_VERSION,
      severity: decision.decision === "Deny" ? "warn" : "info",
    };
    this.audit.append({
      runId: decision.warrantId ?? "no-warrant",
      agentId: decision.agentId ?? "-",
      gate: "B.authz",
      verdict,
      evidence: {
        human: decision.humanId ?? "anonymous",
        agent: decision.agentId ?? "-",
        action: decision.action,
        resource: decision.resource,
        decision: decision.decision,
        warrant: decision.warrantId ?? "-",
      },
    });
  }

  /**
   * A CONCORD outcome in the same hash chain as every authorization decision.
   *
   * The gate differs (`C.concord`, not `B.authz`) because it answers a
   * different question: not whether the Agent was allowed to write, but what
   * happened when it did while someone else was writing too.
   */
  recordConcord(event: ConcordEvent): void {
    const denied = event.outcome === "denied";
    const contested = event.outcome === "conflict" || event.outcome === "leased";
    this.audit.append({
      runId: "concord",
      agentId: event.actorId,
      gate: "C.concord",
      verdict: {
        decision: denied ? "Deny" : "Allow",
        ruleId: "CD-" + event.outcome,
        reason: String(event.detail["reason"] ?? "Shared document " + event.outcome),
        gate: "C.concord",
        policyVersion: POLICY_VERSION,
        policyHash: POLICY_VERSION,
        severity: denied ? "warn" : contested ? "warn" : "info",
      },
      evidence: {
        human: event.humanId ?? "anonymous",
        agent: event.actorId,
        action: "document." + event.outcome,
        resource: docResource(event.docId),
        decision: denied ? "Deny" : "Allow",
        version: event.version,
      },
    });
  }

  status(): Record<string, unknown> {
    const warrants = this.registry.listWarrants();
    return {
      policyVersion: POLICY_VERSION,
      humans: this.registry.listHumans(),
      warrants: warrants.map((w) => ({
        id: w.id,
        human: w.humanId,
        agent: w.agentId,
        subtask: w.subtaskId,
        live: this.registry.isLive(w),
        revokedAt: w.revokedAt,
        expiresAt: w.expiresAt,
      })),
      tasks: this.orchestrator.listTasks(),
      chainHead: this.audit.chainHead.slice(0, 12),
      chainValid: this.audit.verify() === -1,
    };
  }
}

export { ORCHESTRATOR_ID };
