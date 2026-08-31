/**
 * Doc-vs-code contract for the KS-1 network topology.
 *
 * docs/MIDDLEWARE_ARCHITECTURE.md §4.4:
 *   "AEGIS instead attaches the runtime to a user-defined bridge created with
 *   `--internal`, which has no route off the host."
 *
 * docs/MIDDLEWARE_ARCHITECTURE.md §3.6 (KS-1 Egress row):
 *   "`--internal` bridge with no route off the host; the broker is the only
 *   reachable peer and holds the domain allowlist"
 *
 * `ensureNetwork` in ./network.ts creates the network with a plain
 * `docker network create <name>` - no `--internal` anywhere in the argv. That
 * omission is not an oversight: network.ts's own header comment says so
 * explicitly ("It is created WITHOUT `--internal`, and that is a deliberate,
 * documented limitation... Do not upgrade the claim in the docs until this
 * passes `--internal`."), and gives the reason - an internal network would
 * strand the container with no path to Ark until the egress broker exists to
 * be its one permitted peer.
 *
 * That justification is itself now stale: aegis/egress/broker.ts is 235 lines
 * of a working single-upstream forwarding proxy, and Aegis.bootstrap() in
 * ./index.ts already constructs and starts it. The precondition the comment
 * names as blocking `--internal` has been met; §4.4's claim has not been
 * implemented anyway. (docs §10.4's "the one honest gap" callout, which says
 * broker.ts "is designed... but not written", is consequently out of date
 * too - it is not one of the five files this test suite covers, but it is
 * the same drift, one layer up.)
 *
 * Both tests below mock `execFile` the way sandbox/network.test.ts does: the
 * injectable `exec` parameter, never a real container engine.
 */

import { describe, expect, it, vi } from "vitest";
import { ensureNetwork } from "./network.js";

describe("§4.4 doc claim: the bridge is created with --internal", () => {
  it('creates the network with "--internal" in the docker network create argv', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("Error: No such network: aegis-egress"))
      .mockResolvedValueOnce({ stdout: "id\n", stderr: "" });

    const result = await ensureNetwork("docker", "aegis-egress", exec as never);

    // §4.4's own words: "created with `--internal`". If the flag is absent
    // from the create call, the runtime is not on the topology the doc
    // describes - it is on an ordinary bridge with a route off the host.
    expect(exec).toHaveBeenLastCalledWith("docker", [
      "network",
      "create",
      "--internal",
      "aegis-egress",
    ]);
    expect(result.internal).toBe(true);
  });
});

describe("current reality (regression guard, not the documented promise)", () => {
  it("creates the network WITHOUT --internal, and reports it as not internal", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("Error: No such network: aegis-egress"))
      .mockResolvedValueOnce({ stdout: "id\n", stderr: "" });

    const result = await ensureNetwork("docker", "aegis-egress", exec as never);

    // This is what the code actually does today, pinned so it cannot regress
    // silently in either direction: if this test ever starts failing because
    // `--internal` shows up, that is progress - go update the test above (it
    // is the one that should then start passing) and the doc's honesty about
    // when KS-1 stopped being "enforced by G3 detection rather than by
    // topology" (§10.4).
    expect(exec).toHaveBeenLastCalledWith("docker", [
      "network",
      "create",
      "aegis-egress",
    ]);
    expect(result.status).toBe("created");
    expect(result.internal).toBe(false);
  });

  it("also reports an already-present network's real --internal state honestly", async () => {
    // Round-trips through `docker network inspect`, independent of creation.
    // Included so this file makes both of ensureNetwork's return paths
    // explicit, not just the create path §4.4 talks about.
    const exec = vi.fn().mockResolvedValue({ stdout: "false\n", stderr: "" });
    const result = await ensureNetwork("docker", "aegis-egress", exec as never);
    expect(result.status).toBe("present");
    expect(result.internal).toBe(false);
  });
});
