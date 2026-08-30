/**
 * Line provenance - which Agent last changed each line of a shared document.
 *
 * Two features rest on this. Version control needs to answer "who last touched
 * this part of the file" when several Agents commit to one file concurrently.
 * The review loop needs to route a human's comment on a line range to the Agent
 * responsible for that code.
 *
 * Named to distinguish it from reconcile.ts, which reconciles an Agent's
 * WORKSPACE back into CONCORD after a turn. This module reconciles line
 * ATTRIBUTION after a commit.
 *
 * Reconciliation reuses CONCORD's existing line diff rather than adding a diff
 * dependency: a line the Agent did not touch keeps its previous lineId and its
 * previous attribution, so provenance survives other Agents' edits instead of
 * being reset on every write.
 *
 * The claim is deliberately narrow. This is *last modifier*, not authorship and
 * not ownership - a later Agent rewriting a line takes attribution for it.
 */

import { randomUUID } from "node:crypto";
import { diffLines, splitLines } from "./merge.js";

export interface LineProvenance {
  readonly lineId: string;
  /** null for seeded or human-authored content that predates any Agent write. */
  readonly lastModifiedByAgentId: string | null;
  readonly contributionId: string | null;
  readonly resultingDocumentVersion: number;
  readonly updatedAt: string;
}

export interface DocumentLineProvenance {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly lines: readonly LineProvenance[];
}

export type ContributionOutcome = "written" | "merged";

export interface AgentContribution {
  readonly id: string;
  readonly documentId: string;
  readonly agentId: string;
  readonly humanId: string | null;
  readonly runId: string | null;
  readonly baseVersion: number;
  readonly resultingVersion: number;
  readonly outcome: ContributionOutcome;
  readonly changedLineIds: readonly string[];
  /** Short, safe. Never the compiled prompt or the whole file. */
  readonly summary: string;
  readonly createdAt: string;
}

export interface ProvenanceInput {
  readonly previous: readonly LineProvenance[];
  readonly previousContent: string;
  readonly nextContent: string;
  readonly agentId: string;
  readonly contributionId: string;
  readonly version: number;
  readonly at: string;
}

export interface ProvenanceUpdate {
  readonly lines: readonly LineProvenance[];
  readonly changedLineIds: readonly string[];
}

/** Provenance for content that exists before any Agent has written to it. */
export function seedProvenance(
  documentId: string,
  content: string,
  version: number,
  at: string,
): DocumentLineProvenance {
  return {
    documentId,
    documentVersion: version,
    lines: splitLines(content).map(() => ({
      lineId: randomUUID(),
      lastModifiedByAgentId: null,
      contributionId: null,
      resultingDocumentVersion: version,
      updatedAt: at,
    })),
  };
}

/**
 * Aligns the previous provenance against the newly committed content.
 *
 * Lines the diff leaves alone keep their identity and attribution. Lines the
 * diff inserts are new identities attributed to the writing Agent. Lines the
 * diff deletes simply disappear - their provenance is not carried forward onto
 * an unrelated line.
 */
export function reconcileProvenance(input: ProvenanceInput): ProvenanceUpdate {
  const oldLines = splitLines(input.previousContent);
  const newLines = splitLines(input.nextContent);
  const hunks = diffLines(oldLines, newLines);

  const lines: LineProvenance[] = [];
  const changedLineIds: string[] = [];
  let cursor = 0;

  const carry = (index: number): LineProvenance =>
    input.previous[index] ?? {
      // Defensive: a provenance array shorter than its content means an earlier
      // write bypassed reconciliation. Attribute the gap to nobody rather than
      // to whoever happens to be writing now.
      lineId: randomUUID(),
      lastModifiedByAgentId: null,
      contributionId: null,
      resultingDocumentVersion: input.version,
      updatedAt: input.at,
    };

  const attribute = (): LineProvenance => ({
    lineId: randomUUID(),
    lastModifiedByAgentId: input.agentId,
    contributionId: input.contributionId,
    resultingDocumentVersion: input.version,
    updatedAt: input.at,
  });

  for (const hunk of hunks) {
    for (; cursor < hunk.start; cursor += 1) lines.push(carry(cursor));
    cursor += hunk.deleted;
    for (let n = 0; n < hunk.inserted.length; n += 1) {
      const line = attribute();
      lines.push(line);
      changedLineIds.push(line.lineId);
    }
  }
  for (; cursor < oldLines.length; cursor += 1) lines.push(carry(cursor));

  // The invariant the whole feature depends on: one provenance entry per line
  // of canonical content. A mismatch means attribution is misaligned, which
  // would route review comments to the wrong Agent.
  if (lines.length !== newLines.length) {
    throw new Error(
      "Provenance invariant violated: " +
        lines.length +
        " entries for " +
        newLines.length +
        " lines",
    );
  }
  return { lines, changedLineIds };
}

export interface AgentRange {
  readonly agentId: string | null;
  readonly lineNumbers: readonly number[];
}

export interface ResponsibleAgents {
  /** Set when exactly one Agent accounts for the range. */
  readonly recommendedAgentId: string | null;
  readonly candidateAgentIds: readonly string[];
  readonly ambiguous: boolean;
}

/**
 * Which Agent should receive a comment on lines [startLine, endLine], 1-based
 * and inclusive. Several Agents in range is ambiguous on purpose: the caller
 * must choose rather than have the platform guess.
 */
export function responsibleAgents(
  lines: readonly LineProvenance[],
  startLine: number,
  endLine: number,
): ResponsibleAgents {
  const found = new Set<string>();
  for (let line = startLine; line <= endLine; line += 1) {
    const entry = lines[line - 1];
    if (entry?.lastModifiedByAgentId) found.add(entry.lastModifiedByAgentId);
  }
  const candidateAgentIds = [...found];
  return {
    recommendedAgentId: candidateAgentIds.length === 1 ? candidateAgentIds[0]! : null,
    candidateAgentIds,
    ambiguous: candidateAgentIds.length > 1,
  };
}
