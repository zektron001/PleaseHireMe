/**
 * PAP - Policy Administration Point.
 *
 * The bundle is data plus total predicates. Its hash is surfaced in every
 * Verdict, so an audit record proves exactly which rules produced the decision.
 */

import { createHash } from "node:crypto";
import type { PolicyBundle, PolicyRule } from "../types.js";
import {
  destinationsIn,
  hostOf,
  isInside,
  isPrivateOrLinkLocal,
  pathOf,
} from "./resource.js";

export interface BundleOptions {
  /** Hosts the runtime may reach. Derived from the configured Ark base URL. */
  readonly egressAllowlist: readonly string[];
  /** Mount point of the Agent workspace inside the container. */
  readonly workspaceMount: string;
  /** Path segments that identify the protected asset in any namespace. */
  readonly vaultMarkers: readonly string[];
  /** Remaining budget lookup, in USD. Pure from the engine's point of view. */
  readonly remainingBudgetUsd: (agentId: string) => number;
  /** Read-only system paths a normal toolchain touches. Defaults below. */
  readonly systemReadAllowlist?: readonly string[];
}

export const BUNDLE_VERSION = "1.0.0";

/**
 * Ordinary execution reads interpreters, shared libraries and CA bundles. Left
 * out, every real run trips KS-3 and the control is useless in practice - so the
 * allowlist is deliberately narrow and read-only, and it excludes the paths that
 * actually carry secrets (/etc/passwd, /etc/shadow, /root, /home, the vault).
 */
export const DEFAULT_SYSTEM_READS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
  "/tmp",
  "/codex-home",
  "/dev/null",
  "/dev/urandom",
  "/dev/stdout",
  "/dev/stderr",
  "/proc/self",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/localtime",
];

export function createBundle(options: BundleOptions): PolicyBundle {
  const allowlist = new Set(options.egressAllowlist.map((h) => h.toLowerCase()));
  const systemReads = options.systemReadAllowlist ?? DEFAULT_SYSTEM_READS;

  const namesVault = (target: string): boolean =>
    options.vaultMarkers.some(
      (marker) => target === marker || target.includes(marker),
    );

  const isSystemRead = (target: string): boolean =>
    systemReads.some((prefix) => isInside(prefix, target));

  const rules: PolicyRule[] = [
    {
      id: "KS-0.default-workspace-task",
      effect: "Allow",
      gate: "G1.preflight",
      severity: "info",
      reason: "Agent holds workspace:rw and the platform is accepting runs",
      when: (r) =>
        r.action === "run.start" && r.principal.scopes.includes("workspace:rw"),
    },
    {
      id: "KS-6.budget.exhausted",
      effect: "Deny",
      gate: "G1.preflight",
      severity: "warn",
      reason: "Estimated cost exceeds the remaining budget for this Agent",
      when: (r) =>
        r.action === "run.start" &&
        r.context.estimatedCostUsd >
          options.remainingBudgetUsd(r.principal.agentId),
    },

    {
      id: "KS-1.egress.deny-non-allowlisted",
      effect: "Deny",
      gate: "G3.interception",
      severity: "critical",
      reason: "Destination is not in the egress allowlist",
      when: (r) => {
        if (r.action !== "net.connect") return false;
        const host = hostOf(r.resource);
        return host !== null && !allowlist.has(host);
      },
    },
    {
      id: "KS-1.egress.deny-private-ranges",
      effect: "Deny",
      gate: "G3.interception",
      severity: "critical",
      reason:
        "Destination resolves to a private, loopback, or link-local address " +
        "(cloud metadata SSRF)",
      when: (r) => {
        if (r.action !== "net.connect") return false;
        const host = hostOf(r.resource);
        return host !== null && isPrivateOrLinkLocal(host);
      },
    },

    {
      id: "KS-2.vault.deny-any-access",
      effect: "Deny",
      gate: "G3.interception",
      severity: "critical",
      reason: "The protected vault is not accessible to any Agent",
      when: (r) => {
        const target = pathOf(r.resource);
        return target !== null && namesVault(target);
      },
    },
    {
      id: "KS-3.fs.deny-outside-workspace",
      effect: "Deny",
      gate: "G3.interception",
      severity: "critical",
      reason: "Filesystem access outside the Agent workspace is not permitted",
      when: (r) => {
        const target = pathOf(r.resource);
        if (target === null) return false;
        if (r.action !== "fs.read" && r.action !== "fs.write") return false;
        if (isInside(options.workspaceMount, target)) return false;
        // A write anywhere outside the workspace is always refused; a read is
        // refused unless it is one of the read-only system paths a toolchain
        // legitimately needs.
        if (r.action === "fs.write") return true;
        return !isSystemRead(target);
      },
    },

    // ---- Explicit permits. Deny-overrides means these can never rescue a
    // denied action; without them, every benign action would hit default-deny
    // and the middleware would kill legitimate runs.
    {
      id: "KS-0.fs.workspace-io",
      effect: "Allow",
      gate: "G3.interception",
      severity: "info",
      reason: "Read or write inside the Agent workspace",
      when: (r) => {
        const target = pathOf(r.resource);
        if (target === null) return false;
        if (r.action !== "fs.read" && r.action !== "fs.write") return false;
        return isInside(options.workspaceMount, target) && !namesVault(target);
      },
    },
    {
      id: "KS-0.fs.system-read",
      effect: "Allow",
      gate: "G3.interception",
      severity: "info",
      reason: "Read of a read-only system path required by the toolchain",
      when: (r) => {
        const target = pathOf(r.resource);
        if (target === null || r.action !== "fs.read") return false;
        return isSystemRead(target) && !namesVault(target);
      },
    },
    {
      id: "KS-0.net.allowlisted",
      effect: "Allow",
      gate: "G3.interception",
      severity: "info",
      reason: "Destination is the allowlisted model endpoint",
      when: (r) => {
        if (r.action !== "net.connect") return false;
        const host = hostOf(r.resource);
        return host !== null && allowlist.has(host) && !isPrivateOrLinkLocal(host);
      },
    },
    {
      id: "KS-0.proc.exec",
      effect: "Allow",
      gate: "G3.interception",
      severity: "info",
      reason: "Command names no forbidden destination",
      when: (r) => r.action === "proc.exec",
    },
    {
      id: "KS-1.proc.deny-egress-tool-outside-allowlist",
      effect: "Deny",
      gate: "G3.interception",
      severity: "critical",
      reason: "Command names a network destination that is not allowlisted",
      when: (r) => {
        if (r.action !== "proc.exec") return false;
        return destinationsIn(r.resource).some(
          ({ host }) => !allowlist.has(host) || isPrivateOrLinkLocal(host),
        );
      },
    },
  ];

  return { version: BUNDLE_VERSION, rules };
}

/**
 * Hash covers rule identity, effect, gate and severity - the parts that decide
 * attribution. Predicate bodies are not hashable, so the version string is what
 * distinguishes two bundles with the same rule ids but different logic.
 */
export function bundleHash(bundle: PolicyBundle): string {
  const canonical = JSON.stringify({
    version: bundle.version,
    rules: bundle.rules.map((rule) => ({
      id: rule.id,
      effect: rule.effect,
      gate: rule.gate,
      severity: rule.severity,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
