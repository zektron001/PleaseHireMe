/**
 * Canonical resource identifiers.
 *
 * Authorization is decided over these strings and nothing else. Keeping them
 * canonical and total is what stops "did you mean ws:sub-1 or ws:sub-01?" from
 * becoming a security bug.
 */

export const WS_PREFIX = "ws:";
export const REPO_PREFIX = "repo:";
export const BRANCH_PREFIX = "branch:";

/** The shared integration branch. Only the orchestrator may write it. */
export const INTEGRATION_BRANCH = BRANCH_PREFIX + "integration";

export function workspaceResource(subtaskId: string): string {
  return WS_PREFIX + subtaskId;
}

export function repoFileResource(repoPath: string): string {
  return REPO_PREFIX + normalisePath(repoPath);
}

/** Strips leading slashes and resolves `..`, so no path can escape sideways. */
export function normalisePath(input: string): string {
  const parts = input.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

export function subtaskIdOf(resource: string): string | null {
  return resource.startsWith(WS_PREFIX) ? resource.slice(WS_PREFIX.length) : null;
}

export function isWorkspace(resource: string): boolean {
  return resource.startsWith(WS_PREFIX);
}

export function isIntegrationBranch(resource: string): boolean {
  return resource === INTEGRATION_BRANCH;
}

/**
 * True when `resource` is covered by one of the warrant's granted resources.
 * A repo-file grant covers everything beneath it; a workspace grant is exact.
 */
export function covers(granted: string, resource: string): boolean {
  if (granted === resource) return true;
  if (granted.startsWith(REPO_PREFIX) && resource.startsWith(REPO_PREFIX)) {
    const g = granted.slice(REPO_PREFIX.length);
    const r = resource.slice(REPO_PREFIX.length);
    return g === "" || r === g || r.startsWith(g.endsWith("/") ? g : g + "/");
  }
  return false;
}
