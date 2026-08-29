/**
 * Per-subtask workspaces on disk.
 *
 * Closing limitation L2: until now `ws:sub_x` was only a string the PDP reasoned
 * about, so a cross-owner denial was a decision and nothing more. Each subtask
 * now owns a real directory, and only the directory a warrant names is ever
 * bound into that Agent's container - so a sibling's files are not present at
 * ANY path inside the namespace, not merely refused when asked for.
 *
 *   logical  WB-6.cross-owner-denied   the request is refused
 *   physical the sibling is unmounted  there is nothing to request
 *
 * The two are independent: the logical check would still hold if the mount were
 * misconfigured, and the mount would still hold if the PDP had a bug.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Subtask } from "./types.js";

export class SubtaskWorkspaceManager {
  constructor(private readonly root: string) {}

  /** Sibling workspaces live here. This directory is NEVER bind-mounted. */
  get parent(): string {
    return this.root;
  }

  pathFor(subtaskId: string): string {
    return path.join(this.root, subtaskId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".archived"), { recursive: true });
  }

  /**
   * Creates the directory and writes the Agent-facing brief. The brief states
   * the owner and the granted paths, so the model is told the same boundary the
   * kernel enforces - agreement between the two is what makes a violation a
   * clear signal rather than a misunderstanding.
   */
  async create(subtask: Subtask, ownerDisplayName: string): Promise<string> {
    const workspacePath = this.pathFor(subtask.id);
    await mkdir(workspacePath, { recursive: true });

    await writeFile(
      path.join(workspacePath, "AGENTS.md"),
      [
        "# Subtask brief",
        "",
        "You are the Agent for subtask `" + subtask.id + "`.",
        "",
        "## Accountable human",
        "",
        ownerDisplayName + " (`" + subtask.ownerId + "`) owns this subtask and this",
        "workspace. You act under their delegated warrant and nothing more.",
        "",
        "## Task",
        "",
        "**" + subtask.title + "**",
        "",
        subtask.description,
        "",
        "## Files you may change",
        "",
        ...subtask.paths.map((p) => "- `" + p + "`"),
        "",
        "## Boundary",
        "",
        "- This workspace is the only one bound into your runtime. Other subtasks",
        "  do not exist at any path you can reach.",
        "- Requests for another owner's workspace are refused by the backend and",
        "  recorded against your warrant.",
        "- Your authority expires, and the human who granted it can revoke it at",
        "  any time. Neither is an error: stop and report.",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(workspacePath, ".gitignore"),
      ["node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );

    return workspacePath;
  }

  async archive(subtaskId: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(this.root, ".archived", subtaskId + "-" + stamp);
    await rename(this.pathFor(subtaskId), destination);
    return destination;
  }

  /** Sibling paths that must never appear in this Agent's container argv. */
  siblingsOf(subtaskId: string, allSubtaskIds: readonly string[]): string[] {
    return allSubtaskIds
      .filter((id) => id !== subtaskId)
      .map((id) => this.pathFor(id));
  }
}
