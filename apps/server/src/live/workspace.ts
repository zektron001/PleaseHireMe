/**
 * Watching an Agent's workspace copy while it works.
 *
 * This is what the live screens render, and the reason they are not an
 * animation. During a turn the Agent runs real shell commands - `cat >> file`,
 * an editor, a patch - and its workspace copy really does change on disk. This
 * polls that file and publishes each new state.
 *
 * So the text that appears on screen appeared in the file, at that moment, for
 * that reason. What is still NOT available is keystrokes: the file changes when
 * the Agent's command completes, not character by character. A caret gliding
 * between those moments would be invented, so the screens show the changed
 * REGION instead - which is a fact the diff actually establishes.
 *
 * Polling rather than fs.watch on purpose: fs.watch is famously
 * platform-dependent, fires twice as often as it should on some systems and not
 * at all on others (including several WSL and container filesystems, which is
 * exactly where this runs). A 250ms stat is boring, portable, and cheap next to
 * the model call it is watching.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { diffLines, splitLines } from "../concord/merge.js";
import { activityBus, type ActivityBus, type WorkspaceFrame } from "./activity.js";

const POLL_MS = 250;
/** A workspace file larger than this is summarised rather than streamed. */
const MAX_STREAM_BYTES = 96_000;

export interface WorkspaceWatchInput {
  readonly workspacePath: string;
  readonly docId: string;
  readonly agentId: string;
  readonly subtaskId: string | null;
  readonly humanId: string | null;
  /** The heading this Agent is allocated, so the UI can frame its territory. */
  readonly section?: string;
}

export type { WorkspaceFrame };

/** Where the changed lines are, in the coordinates of the NEW content. */
function changedRange(
  before: string,
  after: string,
): { startLine: number; endLine: number } | null {
  const hunks = diffLines(splitLines(before), splitLines(after));
  if (hunks.length === 0) return null;

  // Walk the hunks, tracking the offset between base and new coordinates, so
  // the range reported is one the client can highlight directly.
  let offset = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const hunk of hunks) {
    const startInNew = hunk.start + offset;
    const endInNew = startInNew + Math.max(hunk.inserted.length, 1);
    first = Math.min(first, startInNew + 1);
    last = Math.max(last, endInNew);
    offset += hunk.inserted.length - hunk.deleted;
  }
  return { startLine: Math.max(1, first), endLine: Math.max(1, last) };
}

/**
 * Starts watching. Returns the stop function; call it in a `finally`, because
 * a watcher outliving its turn would keep publishing frames for a file nobody
 * is editing any more.
 */
export function watchWorkspaceFile(
  input: WorkspaceWatchInput,
  bus: ActivityBus = activityBus,
): () => void {
  const target = path.join(input.workspacePath, input.docId);
  let previous: string | null = null;
  let lastMtime = -1;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const info = await stat(target);
      // Cheap guard: no mtime change means no read at all.
      if (info.mtimeMs === lastMtime) return;
      lastMtime = info.mtimeMs;

      const truncated = info.size > MAX_STREAM_BYTES;
      const raw = await readFile(target, "utf8");
      const content = truncated ? raw.slice(0, MAX_STREAM_BYTES) : raw;
      if (content === previous) return;

      const changed = previous === null ? null : changedRange(previous, content);
      previous = content;
      bus.publishWorkspace({
        agentId: input.agentId,
        subtaskId: input.subtaskId,
        humanId: input.humanId,
        docId: input.docId,
        section: input.section ?? null,
        at: new Date().toISOString(),
        content,
        changed,
        truncated,
      });
    } catch {
      // The file may not exist yet - materialize creates it, and an Agent may
      // delete and rewrite it. Absence is not an error, it is just nothing to
      // report this tick.
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
