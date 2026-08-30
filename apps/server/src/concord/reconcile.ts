/**
 * The runtime seam - closing C6.
 *
 * CONCORD was a working concurrency plane that the Agents themselves did not
 * use: the store was driven by the API and the demo, while the sandboxed Codex
 * process wrote straight into its own workspace. Everything CONCORD guarantees
 * was therefore true of documents nobody's Agent actually edited.
 *
 * This closes that gap at turn granularity, in two moves around each run:
 *
 *   materialize  before the turn, every shared document the Agent may read is
 *                written into its workspace at the committed version, and that
 *                version is remembered. The Agent starts from what everyone
 *                else has already agreed on rather than from its own stale copy.
 *   reconcile    after the turn, anything the Agent changed is submitted through
 *                store.write() at the remembered version. Authority, ordering,
 *                merge and conflict are then exactly the same machinery the API
 *                path uses - there is no second, weaker write path.
 *
 * What this is NOT: an interception of individual file writes. Codex writes to
 * the workspace during the turn and CONCORD sees the result at the end of it, so
 * two Agents in the same turn window still resolve by merge rather than by
 * blocking each other mid-edit. That is the honest description, and it is why
 * `materialize` matters: it is what stops a long-lived Agent from rebasing onto
 * a version it read an hour ago.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SharedDocStore, WriteOutcome } from "./store.js";

export interface ReconcileResult {
  readonly docId: string;
  readonly status: WriteOutcome["status"] | "unchanged" | "unreadable";
  readonly version?: number;
  readonly conflictId?: string;
  readonly detail?: string;
}

export interface MaterializeResult {
  readonly docId: string;
  readonly status: "materialized" | "denied";
  readonly version?: number;
  readonly reason?: string;
}

/** What the Agent was handed, so a later write can state the version it read. */
interface Checkout {
  readonly version: number;
  readonly content: string;
}

export class WorkspaceReconciler {
  /** agentId + docId -> what materialize handed over. */
  private readonly checkouts = new Map<string, Checkout>();

  constructor(private readonly store: SharedDocStore) {}

  private key(agentId: string, docId: string): string {
    return agentId + "::" + docId;
  }

  /**
   * A document id is a repo-relative path, and it is about to become a real
   * filesystem path inside a workspace. `docs/../../etc/passwd` would otherwise
   * escape the very directory the warrant confines this Agent to, so the
   * resolved path must still be inside the workspace or it is not written.
   */
  private safeJoin(workspacePath: string, docId: string): string | null {
    if (path.isAbsolute(docId)) return null;
    const root = path.resolve(workspacePath);
    const target = path.resolve(root, docId);
    const inside = target === root || target.startsWith(root + path.sep);
    return inside ? target : null;
  }

  async materialize(
    workspacePath: string,
    agentId: string,
    sharedPaths: readonly string[],
  ): Promise<MaterializeResult[]> {
    const results: MaterializeResult[] = [];
    for (const docId of sharedPaths) {
      const target = this.safeJoin(workspacePath, docId);
      if (!target) {
        results.push({ docId, status: "denied", reason: "Path escapes the workspace" });
        continue;
      }
      const read = await this.store.read(docId, agentId);
      if (read.status === "denied") {
        results.push({ docId, status: "denied", reason: read.reason ?? "Denied" });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, read.content, "utf8");
      this.checkouts.set(this.key(agentId, docId), {
        version: read.version,
        content: read.content,
      });
      results.push({ docId, status: "materialized", version: read.version });
    }
    return results;
  }

  async reconcile(
    workspacePath: string,
    agentId: string,
    sharedPaths: readonly string[],
    /** The Agent's own checkpoint message and Run id for this turn. */
    checkpoint?: { message?: string | null; runId?: string | null },
  ): Promise<ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    for (const docId of sharedPaths) {
      const target = this.safeJoin(workspacePath, docId);
      const checkout = this.checkouts.get(this.key(agentId, docId));
      if (!target || !checkout) {
        results.push({
          docId,
          status: "unreadable",
          detail: target ? "Never materialized for this Agent" : "Path escapes the workspace",
        });
        continue;
      }

      let content: string;
      try {
        content = await readFile(target, "utf8");
      } catch (error) {
        // A deleted shared file is not treated as "delete the document". An
        // Agent that removes a file it shares with three other people has
        // almost certainly made a mistake, and CONCORD has no delete outcome
        // that a human could review, so it is reported and left alone.
        results.push({
          docId,
          status: "unreadable",
          detail: (error as NodeJS.ErrnoException).code ?? "read failed",
        });
        continue;
      }

      if (content === checkout.content) {
        results.push({ docId, status: "unchanged", version: checkout.version });
        continue;
      }

      const outcome = await this.store.write(docId, agentId, checkout.version, content, {
        ...(checkpoint?.message ? { message: checkpoint.message } : {}),
        runId: checkpoint?.runId ?? null,
      });
      if (outcome.status === "written" || outcome.status === "merged") {
        // The merged text is what actually landed, so the workspace is brought
        // up to it. Leaving the Agent's own version on disk would make its next
        // turn start from text nobody agreed on.
        await writeFile(target, outcome.content, "utf8");
        this.checkouts.set(this.key(agentId, docId), {
          version: outcome.version,
          content: outcome.content,
        });
        results.push({ docId, status: outcome.status, version: outcome.version });
      } else if (outcome.status === "conflict") {
        results.push({
          docId,
          status: "conflict",
          version: outcome.version,
          conflictId: outcome.conflictId,
          detail: outcome.conflicts.length + " contested line range(s)",
        });
      } else if (outcome.status === "denied") {
        results.push({ docId, status: "denied", detail: outcome.reason });
      } else {
        results.push({ docId, status: "leased", detail: "Held by " + outcome.holder });
      }
    }
    return results;
  }

  /** Forgets an Agent's checkouts. Called when its subtask workspace is archived. */
  forget(agentId: string): void {
    for (const key of this.checkouts.keys()) {
      if (key.startsWith(agentId + "::")) this.checkouts.delete(key);
    }
  }
}
