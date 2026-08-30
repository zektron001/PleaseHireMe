/**
 * The gap these tests exist for: `--network aegis-egress` in a generated argv
 * looks exactly the same whether or not that network exists, so thirteen
 * passing isolation tests coexisted with a profile that could not start a
 * single container.
 */

import { describe, expect, it, vi } from "vitest";
import { ensureNetwork } from "./network.js";

const ok = (stdout: string) => vi.fn().mockResolvedValue({ stdout, stderr: "" });

describe("ensureNetwork", () => {
  it("does not touch the engine for a built-in mode", async () => {
    const exec = ok("");
    for (const mode of ["none", "host", "bridge", "default"]) {
      const result = await ensureNetwork("docker", mode, exec as never);
      expect(result.status).toBe("built-in");
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports a network that already exists, and whether it is internal", async () => {
    const exec = ok("true\n");
    const result = await ensureNetwork("docker", "aegis-egress", exec as never);
    expect(result).toMatchObject({ status: "present", internal: true });
  });

  it("creates the network when the engine says it is missing", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("Error: No such network: aegis-egress"))
      .mockResolvedValueOnce({ stdout: "id\n", stderr: "" });

    const result = await ensureNetwork("docker", "aegis-egress", exec as never);
    expect(result.status).toBe("created");
    expect(exec).toHaveBeenLastCalledWith("docker", [
      "network",
      "create",
      "aegis-egress",
    ]);
  });

  it("reports created networks as NOT internal, because they are not", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    // The claim in the docs is an internal network with a broker as the only
    // peer. Until the broker exists, saying so here would be the overclaim.
    expect((await ensureNetwork("docker", "aegis-egress", exec as never)).internal).toBe(
      false,
    );
  });

  it("never throws when the engine is missing entirely", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("docker: command not found"));
    const result = await ensureNetwork("docker", "aegis-egress", exec as never);
    expect(result.status).toBe("unavailable");
    expect(result.detail).toContain("command not found");
  });

  it("refuses a network name the engine would not accept", async () => {
    const exec = ok("");
    const result = await ensureNetwork("docker", "; rm -rf /", exec as never);
    expect(result.status).toBe("unavailable");
    expect(exec).not.toHaveBeenCalled();
  });
});
