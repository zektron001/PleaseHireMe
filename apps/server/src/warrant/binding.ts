/**
 * Warrant -> runtime binding.
 *
 * This is where the Track B decision becomes a Track C boundary. A warrant does
 * not merely permit an Agent to ask for a workspace; it determines which single
 * directory is bound into that Agent's container. An Agent with no live warrant
 * gets no runner request at all, so there is nothing to sandbox.
 *
 *   no warrant   -> no RunnerRequest   -> no container
 *   live warrant -> exactly one mount  -> siblings absent from the namespace
 */

import type { RunnerRequest } from "../types.js";
import {
  assertWorkspaceIsolation,
  isolationEvidence,
  type WorkspaceIsolationOptions,
} from "../aegis/sandbox/args.js";
import type { Orchestrator } from "./orchestrator.js";
import type { Registry } from "./registry.js";
import type { SubtaskWorkspaceManager } from "./workspaces.js";
import type { AuthzDecision } from "./types.js";

export class WarrantBindingError extends Error {
  constructor(
    message: string,
    readonly decision: AuthzDecision,
  ) {
    super(message);
    this.name = "WarrantBindingError";
  }
}

export interface BoundRun {
  readonly request: RunnerRequest;
  readonly isolation: WorkspaceIsolationOptions;
  readonly subtaskId: string;
  readonly ownerId: string;
  readonly warrantId: string;
  readonly model: string;
}

export class WarrantBinder {
  constructor(
    private readonly registry: Registry,
    private readonly orchestrator: Orchestrator,
    private readonly workspaces: SubtaskWorkspaceManager,
  ) {}

  /**
   * Produces the runner request for an Agent, or throws. The refusal carries a
   * full AuthzDecision so the caller can audit it exactly like any other denial.
   */
  bind(agentId: string, prompt: string, threadId: string | null = null): BoundRun {
    const subtask = this.orchestrator.subtaskByAgent(agentId);
    const warrant = this.registry.warrantForAgent(agentId);

    // Explicitly typed: TypeScript only narrows control flow after a
    // never-returning call when the callee has an explicit type annotation.
    const refuse: (ruleId: string, reason: string) => never = (ruleId, reason) => {
      throw new WarrantBindingError(reason, {
        humanId: subtask?.ownerId ?? null,
        agentId,
        action: "workspace.write",
        resource: subtask ? "ws:" + subtask.id : "ws:unknown",
        decision: "Deny",
        ruleId,
        reason,
        warrantId: warrant?.id ?? null,
      });
    };

    if (!subtask) {
      refuse("WB-1.no-subtask", "This Agent is not assigned to any subtask");
    }
    if (!warrant) {
      // Covers "never issued", "revoked" and "expired" alike: warrantForAgent
      // returns only live warrants, and a dead warrant grants nothing.
      refuse(
        "WB-1.no-live-warrant",
        "No live warrant authorises this Agent; it gets no workspace at all",
      );
    }
    if (warrant.subtaskId !== subtask.id) {
      refuse(
        "WB-5.warrant-subtask-mismatch",
        "Warrant is for a different subtask",
      );
    }
    if (!warrant.scopes.includes("workspace:write")) {
      refuse(
        "WB-4.scope-not-granted",
        "Warrant does not carry the workspace:write scope",
      );
    }

    const workspacePath = this.workspaces.pathFor(subtask.id);
    const siblings = this.workspaces.siblingsOf(
      subtask.id,
      this.orchestrator.subtasksOf(subtask.taskId).map((s) => s.id),
    );

    return {
      request: { agentId, workspacePath, prompt, threadId },
      isolation: {
        allowedWorkspace: workspacePath,
        siblingWorkspaces: siblings,
        workspaceParent: this.workspaces.parent,
      },
      subtaskId: subtask.id,
      ownerId: subtask.ownerId,
      warrantId: warrant.id,
      model: subtask.model,
    };
  }

  /**
   * Verifies a generated container argv against the binding. Called by the PEP
   * immediately before spawn, so a misconfigured mount stops the run rather than
   * silently widening it.
   */
  verifyArgv(bound: BoundRun, args: readonly string[]): Record<string, string | number> {
    assertWorkspaceIsolation(args, bound.isolation);
    return isolationEvidence(args);
  }
}
