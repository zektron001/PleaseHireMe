/**
 * KS-1's network, made to exist.
 *
 * `AEGIS_NETWORK_MODE` defaults to `aegis-egress`, and nothing in the repository
 * ever created a network by that name. Every hardened container therefore died
 * before it started:
 *
 *   docker: Error response from daemon: failed to set up container networking:
 *   network aegis-egress not found          (exit 125)
 *
 * Which is why no live turn had ever run under the profile. The isolation tests
 * assert over generated argv, and argv containing `--network aegis-egress` looks
 * identical whether or not that network exists.
 *
 * So the network is created at bootstrap if it is missing.
 *
 * It is created WITHOUT `--internal`, and that is a deliberate, documented
 * limitation rather than an oversight. `--internal` is the end state, and it
 * only works once the egress broker (RR-2) exists to be the container's one
 * permitted peer. Until then an internal network means Codex cannot reach Ark,
 * so every turn fails - see RR-5, "Ark must stay reachable". What the dedicated
 * network buys today is real but smaller than the eventual claim: containers on
 * it cannot reach containers on the default bridge, and `docker network inspect`
 * lists exactly which containers are attached.
 *
 * Do not upgrade the claim in the docs until this passes `--internal`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Docker/Podman network names: the engines accept only these characters. */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Modes that name a built-in, which the engine always provides. */
const BUILT_IN = new Set(["none", "host", "bridge", "default"]);

export interface NetworkReadiness {
  readonly name: string;
  readonly status: "built-in" | "present" | "created" | "unavailable";
  readonly internal: boolean;
  readonly detail?: string;
}

/**
 * Ensures the configured network exists. Never throws: a container engine that
 * is absent or unreachable is the caller's problem to report, not a reason to
 * refuse to boot the control plane.
 */
export async function ensureNetwork(
  engine: string,
  mode: string,
  exec: typeof run = run,
): Promise<NetworkReadiness> {
  const name = mode.trim();
  if (BUILT_IN.has(name) || name.startsWith("container:")) {
    return { name, status: "built-in", internal: false };
  }
  if (!SAFE_NAME.test(name)) {
    return {
      name,
      status: "unavailable",
      internal: false,
      detail: "Not a valid network name",
    };
  }

  try {
    const { stdout } = await exec(engine, [
      "network",
      "inspect",
      name,
      "--format",
      "{{.Internal}}",
    ]);
    return { name, status: "present", internal: stdout.trim() === "true" };
  } catch {
    // Not there. Fall through and create it.
  }

  try {
    await exec(engine, ["network", "create", name]);
    return { name, status: "created", internal: false };
  } catch (error) {
    return {
      name,
      status: "unavailable",
      internal: false,
      detail: (error instanceof Error ? error.message.split("\n")[0] : String(error)) ?? "create failed",
    };
  }
}

export interface BrokerReadiness {
  readonly url: string;
  readonly reachable: boolean;
  readonly detail: string;
}

/**
 * Is anything listening where the profile says the broker is?
 *
 * This matters more than it looks. KS-7 strips `ARK_API_KEY` from the container
 * on purpose - the container is supposed to reach the model THROUGH the broker,
 * which holds the key. With the broker absent the Agent has no key and no proxy,
 * and Codex fails with:
 *
 *   Missing environment variable: `ARK_API_KEY`
 *
 * which reads like a configuration mistake and is nothing of the sort. It is
 * RR-2 - the broker was never built - surfacing three layers away from its
 * cause. Probing at bootstrap lets the operator be told the truth once, instead
 * of debugging their own .env.
 */
export async function probeBroker(
  url: string,
  timeoutMs = 1500,
): Promise<BrokerReadiness> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal });
    return { url, reachable: true, detail: "responding" };
  } catch (error) {
    return {
      url,
      reachable: false,
      detail:
        (error as Error).name === "AbortError"
          ? "no response within " + timeoutMs + "ms"
          : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}
