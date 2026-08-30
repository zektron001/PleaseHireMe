/**
 * Task splitting. Orchestration scaffolding, NOT the judged Track B surface.
 *
 * Two implementations behind one interface:
 *
 *   RuleSplitter - deterministic. Used by every test and whenever Ark is not
 *                  configured, so the suite never needs a network or a key.
 *   ArkSplitter  - calls the Volcengine Ark Responses API, the same endpoint the
 *                  Codex runtime uses. Falls back to RuleSplitter on any failure,
 *                  because a planner outage must not take the platform down.
 *
 * The split is only ever a PROPOSAL. Ownership is assigned by a human, and a
 * warrant is what turns an assignment into authority - see orchestrator.ts.
 */

import type { AppConfig } from "../config.js";
import { isArkConfigured } from "../config.js";
import { normalisePath } from "./resources.js";

export interface SubtaskProposal {
  readonly title: string;
  readonly description: string;
  readonly paths: readonly string[];
}

export interface TaskSplitter {
  readonly name: string;
  /**
   * What produced the LAST split, which is not always `name`. The Ark splitter
   * falls back silently by design, and reporting "ark" for a decomposition the
   * rule splitter actually produced is a claim about a live model call that
   * did not happen. Anyone reading a plan should be able to tell the two apart.
   */
  readonly lastSource?: string;
  split(title: string, max: number): Promise<SubtaskProposal[]>;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "work"
  );
}

/** Deterministic decomposition into the three phases most tasks actually have. */
export class RuleSplitter implements TaskSplitter {
  readonly name = "rule";

  async split(title: string, max: number): Promise<SubtaskProposal[]> {
    const base = slug(title);
    const proposals: SubtaskProposal[] = [
      {
        title: "Implement: " + title,
        description:
          "Write the core implementation for " + title + " in the source tree.",
        paths: ["src/" + base + ".ts"],
      },
      {
        title: "Configure and validate: " + title,
        description:
          "Add configuration, environment validation and defaults for " + title + ".",
        paths: ["src/config/" + base + ".ts"],
      },
      {
        title: "Test: " + title,
        description:
          "Cover " + title + " with positive and negative automated tests.",
        paths: ["tests/" + base + ".test.ts"],
      },
      {
        title: "Document: " + title,
        description: "Update the README and changelog for " + title + ".",
        paths: ["docs/" + base + ".md"],
      },
    ];
    return proposals.slice(0, Math.max(1, max));
  }
}

interface ArkItem {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly paths?: unknown;
}

/** Calls Ark's Responses API to propose a decomposition. */
export class ArkSplitter implements TaskSplitter {
  readonly name = "ark";
  /** "ark" only when the model actually answered. See TaskSplitter.lastSource. */
  lastSource = "ark";
  private readonly fallback = new RuleSplitter();

  constructor(
    private readonly config: AppConfig,
    private readonly timeoutMs = 20_000,
  ) {}

  private async fell(
    reason: string,
    title: string,
    max: number,
  ): Promise<SubtaskProposal[]> {
    this.lastSource = "rule (ark " + reason + ")";
    return this.fallback.split(title, max);
  }

  async split(title: string, max: number): Promise<SubtaskProposal[]> {
    this.lastSource = "ark";
    if (!isArkConfigured(this.config)) return this.fell("not configured", title, max);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.config.arkBaseUrl + "/responses", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + this.config.arkApiKey,
        },
        body: JSON.stringify({
          model: this.config.arkModel,
          input: [
            {
              role: "system",
              content:
                "You split one engineering task into independent subtasks that " +
                "different people can own in parallel without touching the same " +
                "files. Reply with ONLY a JSON array, no prose, no code fence. " +
                'Each element: {"title": string, "description": string, ' +
                '"paths": string[]}. Paths must be repo-relative and must not ' +
                "overlap between subtasks. Produce at most " + String(max) + ".",
            },
            { role: "user", content: title },
          ],
        }),
      });
      if (!response.ok) return this.fell("HTTP " + response.status, title, max);

      const parsed = parseArkProposals(await response.json(), max);
      return parsed.length > 0 ? parsed : this.fell("unparseable reply", title, max);
    } catch (error) {
      // Planner outage, bad key, malformed reply: never take the platform down.
      const reason =
        (error as Error).name === "AbortError"
          ? "timed out after " + this.timeoutMs + "ms"
          : ((error as Error).message ?? "unreachable");
      return this.fell(reason, title, max);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exported for tests: pulls the JSON array out of an Ark Responses payload. */
export function parseArkProposals(payload: unknown, max: number): SubtaskProposal[] {
  const text = collectText(payload);
  if (!text) return [];

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let items: unknown;
  try {
    items = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];

  const seen = new Set<string>();
  const out: SubtaskProposal[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as ArkItem;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue;

    const paths = Array.isArray(item.paths)
      ? item.paths
          .filter((p): p is string => typeof p === "string")
          .map(normalisePath)
          .filter((p) => p.length > 0)
      : [];

    // Overlapping paths would put two owners on one file, which is exactly the
    // merge conflict the fan-out is meant to avoid. Drop the later claim.
    const unique = paths.filter((p) => !seen.has(p));
    if (unique.length === 0) continue;
    for (const p of unique) seen.add(p);

    out.push({
      title,
      description:
        typeof item.description === "string" ? item.description.trim() : "",
      paths: unique,
    });
    if (out.length >= max) break;
  }
  return out;
}

function collectText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return payload.map(collectText).join("");
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (typeof record["output_text"] === "string") return record["output_text"];
    const parts: string[] = [];
    for (const key of ["output", "content", "text", "message"]) {
      if (key in record) parts.push(collectText(record[key]));
    }
    return parts.join("");
  }
  return "";
}

export function createSplitter(config: AppConfig): TaskSplitter {
  return isArkConfigured(config) ? new ArkSplitter(config) : new RuleSplitter();
}
