/**
 * The orchestrator: splits a task, assigns each subtask to a human, issues one
 * warrant per Agent, and gates the final integration.
 *
 * SCOPE NOTE. Task splitting and model routing are orchestration scaffolding,
 * not the judged Track B surface - the challenge puts workflow engines out of
 * scope (section 8). They exist here because the fan-out is what makes the
 * authorization problem real: N Agents, N humans, one shared branch.
 *
 * The orchestrator is deliberately NOT omnipotent. It cannot read a subtask
 * workspace it holds no warrant for, and it cannot integrate work whose owner
 * has not approved it (WB-8). A "daddy agent" with ambient authority would
 * re-introduce exactly the confused-deputy problem this plane exists to remove.
 */

import { randomUUID } from "node:crypto";
import type { Registry } from "./registry.js";
import type { SubtaskWorkspaceManager } from "./workspaces.js";
import type { TaskSplitter } from "./splitter.js";
import {
  selectModel,
  tiersFrom,
  type ModelTiers,
  type SubtaskShape,
} from "./model-policy.js";
import { INTEGRATION_BRANCH, repoFileResource, workspaceResource } from "./resources.js";
import type { Subtask, Task, WarrantScope } from "./types.js";

export const ORCHESTRATOR_ID = "human:orchestrator";

const AGENT_SCOPES: readonly WarrantScope[] = [
  "workspace:read",
  "workspace:write",
  "model:invoke",
  "merge:propose",
  // A subtask Agent could always leave review comments; that only became a
  // named scope when sharing needed to hand it out without handing out write.
  "comment:write",
];

export interface PlanInput {
  readonly title: string;
  readonly createdBy: string;
  /** Round-robin pool of human ids to own the subtasks. */
  readonly owners: readonly string[];
  readonly maxSubtasks?: number;
  readonly warrantTtlMs?: number;
  /**
   * Files EVERY subtask may write - a changelog, a shared spec, an index. These
   * are deliberately outside the non-overlapping partition, which is why they
   * need CONCORD's concurrency control rather than static ownership.
   */
  readonly sharedPaths?: readonly string[];
}

export interface PlanResult {
  readonly task: Task;
  readonly subtasks: Subtask[];
  readonly splitter: string;
}

export class Orchestrator {
  private readonly tasks = new Map<string, Task>();
  private readonly subtasks = new Map<string, Subtask>();

  constructor(
    private readonly registry: Registry,
    private readonly splitter: TaskSplitter,
    private readonly tiers: ModelTiers = tiersFrom("ep-not-configured"),
    private readonly now: () => number = Date.now,
    /** When present, every subtask gets a real isolated directory (L2). */
    private readonly workspaces: SubtaskWorkspaceManager | null = null,
  ) {}

  async plan(input: PlanInput): Promise<PlanResult> {
    if (input.owners.length === 0) {
      throw new Error("A task needs at least one human owner");
    }
    const max = input.maxSubtasks ?? 3;
    const proposals = await this.splitter.split(input.title, max);

    const taskId = "task_" + randomUUID();
    const timestamp = new Date(this.now()).toISOString();
    const created: Subtask[] = [];

    proposals.forEach((proposal, index) => {
      const subtaskId = "sub_" + randomUUID();
      const ownerId = input.owners[index % input.owners.length] as string;
      const agentId = "agent_" + randomUUID();

      const shape: SubtaskShape = {
        title: proposal.title,
        description: proposal.description,
        pathCount: proposal.paths.length,
        dependencyCount: 0,
      };

      // The warrant grants exactly this subtask's workspace and its own files -
      // nothing else in the repo, and no sibling's workspace.
      const warrant = this.registry.issue({
        humanId: ownerId,
        agentId,
        subtaskId,
        scopes: AGENT_SCOPES,
        resources: [
          workspaceResource(subtaskId),
          ...proposal.paths.map(repoFileResource),
          ...(input.sharedPaths ?? []).map(repoFileResource),
        ],
        ...(input.warrantTtlMs === undefined ? {} : { ttlMs: input.warrantTtlMs }),
      });

      const subtask: Subtask = {
        id: subtaskId,
        taskId,
        title: proposal.title,
        description: proposal.description,
        ownerId,
        agentId,
        model: selectModel(shape, this.tiers),
        paths: proposal.paths,
        state: "assigned",
        warrantId: warrant.id,
        approvedBy: null,
        updatedAt: timestamp,
      };
      this.subtasks.set(subtaskId, subtask);
      created.push(subtask);
    });

    // Materialise one directory per subtask. Only the directory a warrant names
    // is ever bound into that Agent's container - see warrant/binding.ts.
    if (this.workspaces) {
      for (const subtask of created) {
        const owner = this.registry.human(subtask.ownerId);
        await this.workspaces.create(subtask, owner?.displayName ?? subtask.ownerId);
      }
    }

    const task: Task = {
      id: taskId,
      title: input.title,
      createdBy: input.createdBy,
      createdAt: timestamp,
      subtaskIds: created.map((s) => s.id),
      sharedPaths: [...(input.sharedPaths ?? [])],
      state: "planned",
    };
    this.tasks.set(taskId, task);
    // The source of THIS split, not the name of the splitter that was asked.
    return {
      task,
      subtasks: created,
      splitter: this.splitter.lastSource ?? this.splitter.name,
    };
  }

  task(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  subtask(id: string): Subtask | null {
    return this.subtasks.get(id) ?? null;
  }

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  subtasksOf(taskId: string): Subtask[] {
    return [...this.subtasks.values()].filter((s) => s.taskId === taskId);
  }

  /** Who owns the workspace behind a resource id, if it is an owned resource. */
  ownerOfResource(resource: string): string | null {
    for (const subtask of this.subtasks.values()) {
      if (workspaceResource(subtask.id) === resource) return subtask.ownerId;
    }
    return null;
  }

  subtaskByAgent(agentId: string): Subtask | null {
    for (const subtask of this.subtasks.values()) {
      if (subtask.agentId === agentId) return subtask;
    }
    return null;
  }

  setState(subtaskId: string, state: Subtask["state"]): Subtask | null {
    const subtask = this.subtasks.get(subtaskId);
    if (!subtask) return null;
    subtask.state = state;
    subtask.updatedAt = new Date(this.now()).toISOString();
    return subtask;
  }

  /**
   * Owner approval. Only the human who owns the subtask may approve it - an
   * Agent cannot approve its own work, and neither can another owner.
   */
  approve(subtaskId: string, humanId: string): { ok: boolean; reason: string } {
    const subtask = this.subtasks.get(subtaskId);
    if (!subtask) return { ok: false, reason: "Unknown subtask" };
    if (subtask.ownerId !== humanId) {
      return {
        ok: false,
        reason: "Only " + subtask.ownerId + " may approve this subtask",
      };
    }
    if (subtask.state !== "submitted") {
      return {
        ok: false,
        reason: "Subtask is " + subtask.state + ", not submitted",
      };
    }
    subtask.state = "approved";
    subtask.approvedBy = humanId;
    subtask.updatedAt = new Date(this.now()).toISOString();
    return { ok: true, reason: "Approved by " + humanId };
  }

  /** Subtasks that still block integration. Feeds the WB-8 denial reason. */
  pendingApprovals(taskId: string): string[] {
    return this.subtasksOf(taskId)
      .filter((s) => s.state !== "approved" && s.state !== "integrated")
      .map((s) => s.id);
  }

  allApproved(taskId: string): boolean {
    const subtasks = this.subtasksOf(taskId);
    return subtasks.length > 0 && this.pendingApprovals(taskId).length === 0;
  }

  /** Called only after the PDP has allowed merge.integrate. */
  markIntegrated(taskId: string): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    for (const subtask of this.subtasksOf(taskId)) {
      subtask.state = "integrated";
      subtask.updatedAt = new Date(this.now()).toISOString();
    }
    task.state = "integrated";
    return task;
  }

  get integrationBranch(): string {
    return INTEGRATION_BRANCH;
  }
}
