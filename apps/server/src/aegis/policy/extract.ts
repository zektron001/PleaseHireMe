/**
 * G3 - turns a Codex event line into zero or more typed policy requests.
 *
 * IMPORTANT (and stated in the architecture doc): this stream is SELF-REPORTED
 * by the model, so G3 is a DETECTIVE control, not a preventive one. A model that
 * has been prompt-injected can emit a benign-looking message while doing
 * something else, or emit nothing at all. Prevention lives in the kernel and
 * network namespace (KS-1 to KS-4), which the model cannot narrate its way past.
 *
 * G3 exists because it gives fast containment and precise attribution - it names
 * WHICH control fired, in ~300ms - not because it is trusted.
 */

import type { PolicyContext, PolicyRequest, AgentPrincipal } from "../types.js";
import {
  destinationsIn,
  fileResource,
  netResource,
  pathsIn,
  stripHeredocs,
} from "./resource.js";

interface ExtractOptions {
  readonly principal: AgentPrincipal;
  readonly context: PolicyContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parses one line of `codex exec --json` output. Unparseable lines and events
 * with no security-relevant content yield an empty list, never an error - the
 * stream must never be able to crash the enforcement path.
 */
export function extractRequests(
  line: string,
  options: ExtractOptions,
): PolicyRequest[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(event) || event["type"] !== "item.completed") return [];

  const item = event["item"];
  if (!isRecord(item)) return [];

  const { principal, context } = options;
  const requests: PolicyRequest[] = [];
  const push = (action: PolicyRequest["action"], resource: string): void => {
    requests.push({ principal, action, resource, context });
  };

  const itemType = item["type"];

  if (itemType === "command_execution") {
    const command = typeof item["command"] === "string" ? item["command"] : "";
    if (!command) return [];

    // The command text itself, so a rule can reason about the whole invocation.
    push("proc.exec", command);

    // Paths and hosts are read from the ACTING part of the command only. A
    // here-document body is the file being written, not an invocation - see
    // stripHeredocs. The redirect target survives the strip, so writing to a
    // forbidden path is refused exactly as before.
    const acting = stripHeredocs(command);
    for (const { host, port } of destinationsIn(acting)) {
      push("net.connect", netResource(host, port));
    }
    for (const target of pathsIn(acting)) {
      push("fs.read", fileResource(target));
    }
    return requests;
  }

  if (itemType === "file_change") {
    const changes = item["changes"];
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (!isRecord(change)) continue;
        const target = change["path"];
        if (typeof target !== "string" || !target.startsWith("/")) continue;
        const kind = change["kind"];
        push(kind === "read" ? "fs.read" : "fs.write", fileResource(target));
      }
    }
    return requests;
  }

  if (itemType === "web_search") {
    const query = item["query"];
    if (typeof query === "string") {
      for (const { host, port } of destinationsIn(query)) {
        push("net.connect", netResource(host, port));
      }
    }
    return requests;
  }

  if (itemType === "mcp_tool_call") {
    const server = item["server"];
    const tool = item["tool"];
    push(
      "proc.exec",
      "mcp:" +
        (typeof server === "string" ? server : "unknown") +
        "/" +
        (typeof tool === "string" ? tool : "unknown"),
    );
    return requests;
  }

  return requests;
}
