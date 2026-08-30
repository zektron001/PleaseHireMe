/**
 * G2 - confinement. Turns the baseline container argv into a hardened profile.
 *
 * This is a PURE transform over the argv that `buildContainerRunArgs` already
 * produces, which is what lets the entire control be asserted in a unit test
 * with no container engine present:
 *
 *   KS-1  --network bridge      ->  --network none
 *   KS-3  codex-home config     ->  readonly (the directory stays writable)
 *   KS-4  + --read-only rootfs, --tmpfs /tmp (noexec,nosuid), seccomp profile
 *   KS-7  - --env ARK_API_KEY   ->  broker endpoint + single-run token
 *
 * G2 is the PREVENTIVE boundary. Unlike G3 it cannot be talked around by the
 * model, because it is enforced by the kernel before any Agent code runs.
 */

export interface HardenOptions {
  /**
   * KS-1 network topology. Two supported values:
   *
   *   "none"           - no interface at all. Total isolation, but the Agent
   *                      cannot reach the model either, so this is only correct
   *                      for runs that must not call Ark.
   *   "<network-name>" - a user-defined bridge created with `--internal`, on
   *                      which the ONLY reachable peer is the broker sidecar.
   *                      The broker is additionally attached to a routable
   *                      network, so it - and only it - can reach Ark.
   *
   * An `--internal` network has no route off the host, so exfiltration to an
   * arbitrary destination is prevented by TOPOLOGY rather than by a blocklist
   * that would have to enumerate every bad address.
   */
  readonly networkMode: string;
  /** Absolute path to the seccomp profile, or null to skip KS-4 seccomp. */
  readonly seccompProfilePath: string | null;
  /** URL of the egress broker, resolvable only on the internal network. */
  readonly brokerUrl: string;
  /** Single-run capability token, scoped to one Agent and one run. */
  readonly runToken: string;
  /** Absolute host path of the codex home directory, to re-mount readonly. */
  readonly codexHome: string;
  /** Host paths that must never appear in the argv (the protected vault). */
  readonly forbiddenMounts: readonly string[];
  /** tmpfs size for /tmp. */
  readonly tmpfsSize?: string;
}

export class SandboxProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxProfileError";
  }
}

/** Removes `flag` and its value wherever they occur. */
function dropFlagWithValue(args: string[], flag: string, value?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length) {
      if (value === undefined || args[i + 1] === value) {
        i += 1;
        continue;
      }
    }
    const current = args[i];
    if (current !== undefined) out.push(current);
  }
  return out;
}

/** Index of the image argument: the first token after the last recognised flag. */
function imageIndex(args: string[]): number {
  const index = args.findIndex((arg) => arg === "codex");
  if (index < 1) {
    throw new SandboxProfileError(
      "Cannot locate the runtime image in the container argv",
    );
  }
  return index - 1;
}

export function hardenContainerArgs(
  baseline: readonly string[],
  options: HardenOptions,
): string[] {
  let args = [...baseline];

  // KS-2 - defence in depth: refuse to build argv that names a protected path,
  // even if a future edit to the baseline accidentally mounts one.
  for (const forbidden of options.forbiddenMounts) {
    if (args.some((arg) => arg.includes(forbidden))) {
      throw new SandboxProfileError(
        "Refusing to start a container whose argv references the protected path " +
          forbidden,
      );
    }
  }

  // KS-1 - remove all outbound routing. The broker is reached over loopback.
  args = dropFlagWithValue(args, "--network");

  // KS-7 - the raw Ark key never enters the container environment.
  //
  // It is REPLACED rather than removed. Deleting it left Codex with no
  // credential at all and no broker to get one from, so it died on
  // "Missing environment variable: ARK_API_KEY" - a hardened profile that could
  // not run. The container now holds a per-run capability in the same variable:
  // the client puts whatever ARK_API_KEY contains into the Authorization
  // header, the broker recognises the capability there, and attaches the real
  // key on the far side. What sits inside the namespace is a token that buys
  // one run's calls to one endpoint and dies with the run.
  args = dropFlagWithValue(args, "--env", "ARK_API_KEY");

  // KS-3 - pin the Codex CONFIGURATION read-only, not the whole home.
  //
  // The blanket read-only remount was wrong, and provably so: Codex writes its
  // sessions, sqlite state, shell snapshots and skills into CODEX_HOME, so a
  // read-only home means no turn can run at all. A control that makes the thing
  // it guards unusable is not a control; it is an outage that has never been
  // tested. The asset is `config.toml` - it names the model provider, the base
  // URL and the key's env var, so an Agent that can rewrite it can repoint its
  // own model at an endpoint of its choosing and exfiltrate every prompt. That
  // file is pinned; the session state around it stays writable.
  const configMount =
    "type=bind,src=" +
    options.codexHome +
    "/config.toml,dst=/codex-home/config.toml,readonly";
  if (!args.includes(configMount)) {
    const homeMountIndex = args.findIndex((arg) =>
      arg.startsWith("type=bind,src=" + options.codexHome + ",dst="),
    );
    if (homeMountIndex !== -1) {
      // Must come AFTER the directory mount: a file bind-mount lands on top of
      // the directory it sits in, and the order of --mount flags is the order
      // the engine applies them.
      args.splice(homeMountIndex + 1, 0, "--mount", configMount);
    }
  }

  const insertAt = imageIndex(args);
  const injected: string[] = [
    "--network",
    options.networkMode,
    // The broker runs on the host. Without this the container cannot resolve
    // host.docker.internal on Docker Engine, only on Docker Desktop.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--env",
    "ARK_API_KEY=" + options.runToken,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=" + (options.tmpfsSize ?? "64m"),
    "--env",
    "AEGIS_BROKER=" + options.brokerUrl,
    "--env",
    "AEGIS_RUN_TOKEN=" + options.runToken,
  ];
  if (options.seccompProfilePath) {
    injected.push("--security-opt", "seccomp=" + options.seccompProfilePath);
  }

  args.splice(insertAt, 0, ...injected);
  return args;
}

/** Human-readable summary for the G2 audit event. */
export function profileEvidence(args: readonly string[]): Record<string, string | boolean> {
  const networkIndex = args.indexOf("--network");
  const network = networkIndex === -1 ? "unconfined" : (args[networkIndex + 1] ?? "unconfined");
  return {
    network,
    egressConfined: network !== "bridge" && network !== "host" && network !== "unconfined",
    rootfs: args.includes("--read-only") ? "read-only" : "writable",
    seccomp: args.some((a) => a.startsWith("seccomp=")) ? "aegis-strict-v1" : "engine-default",
    tmpfsNoexec: args.some((a) => a.includes("/tmp:") && a.includes("noexec")),
    codexConfigPinned: args.some(
      (a) => a.includes("dst=/codex-home/config.toml") && a.includes("readonly"),
    ),
    // True only when the value in the namespace is a capability, not the key.
    keyReplacedByCapability:
      !args.includes("ARK_API_KEY") &&
      args.some((a) => a.startsWith("ARK_API_KEY=")),
    arkKeyInEnv: args.includes("ARK_API_KEY"),
  };
}

// ---------------------------------------------------------------------------
// Physical workspace isolation (closes limitation L2 of the Track B design).
// ---------------------------------------------------------------------------

export interface MountSpec {
  readonly src: string;
  readonly dst: string;
  readonly readonly: boolean;
}

/** Parses every `--mount type=bind,...` pair out of a container argv. */
export function bindMountsIn(args: readonly string[]): MountSpec[] {
  const mounts: MountSpec[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== "--mount") continue;
    const spec = args[i + 1] ?? "";
    if (!spec.startsWith("type=bind")) continue;

    const fields = new Map<string, string>();
    for (const part of spec.split(",")) {
      const eq = part.indexOf("=");
      if (eq === -1) {
        fields.set(part.trim(), "true");
      } else {
        fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
    }
    const src = fields.get("src") ?? fields.get("source");
    const dst = fields.get("dst") ?? fields.get("destination") ?? fields.get("target");
    if (!src || !dst) continue;
    mounts.push({ src, dst, readonly: fields.has("readonly") || fields.has("ro") });
  }
  return mounts;
}

function isAncestorOf(ancestor: string, descendant: string): boolean {
  const a = ancestor.replace(/\/+$/, "");
  const d = descendant.replace(/\/+$/, "");
  return d === a || d.startsWith(a + "/");
}

export interface WorkspaceIsolationOptions {
  /** The single Agent workspace this run is permitted to bind. */
  readonly allowedWorkspace: string;
  /** Sibling workspaces that must not be reachable. */
  readonly siblingWorkspaces: readonly string[];
  /**
   * The directory holding all sibling workspaces. Binding it would expose every
   * sibling through one mount, so it is refused even though no sibling `src`
   * appears literally in the argv.
   */
  readonly workspaceParent: string;
}

/**
 * Refuses any argv that could give this Agent a path to another owner's work.
 *
 * Three distinct escapes are checked, because blocking only the obvious one is
 * how this control quietly stops working:
 *
 *   1. a sibling workspace bound directly
 *   2. the shared parent bound, which exposes every sibling at once
 *   3. the workspace mount pointing somewhere other than the warranted path
 */
export function assertWorkspaceIsolation(
  args: readonly string[],
  options: WorkspaceIsolationOptions,
): void {
  const mounts = bindMountsIn(args);
  const workspaceMounts = mounts.filter((m) => m.dst === "/workspace");

  if (workspaceMounts.length !== 1) {
    throw new SandboxProfileError(
      "Expected exactly one /workspace bind mount, found " +
        String(workspaceMounts.length),
    );
  }
  const bound = workspaceMounts[0] as MountSpec;
  if (bound.src.replace(/\/+$/, "") !== options.allowedWorkspace.replace(/\/+$/, "")) {
    throw new SandboxProfileError(
      "Workspace mount points at " +
        bound.src +
        " but the warrant names " +
        options.allowedWorkspace,
    );
  }

  for (const mount of mounts) {
    for (const sibling of options.siblingWorkspaces) {
      if (isAncestorOf(mount.src, sibling)) {
        throw new SandboxProfileError(
          "Mount " + mount.src + " would expose another owner's workspace " + sibling,
        );
      }
    }
    // Binding the shared parent reaches every sibling, present and future.
    if (
      isAncestorOf(mount.src, options.workspaceParent) &&
      !isAncestorOf(options.allowedWorkspace, mount.src)
    ) {
      throw new SandboxProfileError(
        "Mount " +
          mount.src +
          " would expose the shared workspace directory " +
          options.workspaceParent,
      );
    }
  }
}

/** Evidence for the audit event: what this run could physically reach. */
export function isolationEvidence(
  args: readonly string[],
): Record<string, string | number> {
  const mounts = bindMountsIn(args);
  return {
    bindMounts: mounts.length,
    writableMounts: mounts.filter((m) => !m.readonly).length,
    workspace: mounts.find((m) => m.dst === "/workspace")?.src ?? "none",
  };
}
