/**
 * Does a host-run Codex get an upstream it can actually reach?
 *
 * `writeCodexConfig` writes the `base_url` Codex will send every turn to. When
 * AEGIS runs, that becomes the egress broker's address so the agent never
 * learns the real Ark endpoint - correct, and the whole point of the broker.
 *
 * The bug is which question decides it. `index.ts` asks only whether the broker
 * came up:
 *
 *     await writeCodexConfig(config, aegis?.egress ? config.aegisBrokerUrl : undefined);
 *
 * It never asks where Codex is going to run. `AEGIS_BROKER_URL` names a host on
 * the container network - `http://aegis-broker:8080`, or the shipped default
 * `http://host.docker.internal:8788` - and neither resolves from a process on
 * the host. So with the shipped defaults (`AEGIS_ENABLED=true`,
 * `RUNTIME_PROVIDER=local-process`) every local turn is pointed at a hostname
 * that does not exist.
 *
 * Verified live on macOS on 2026-08-31: the server booted clean, the
 * orchestrator's own Ark call succeeded in 20s, and then
 * `POST /api/warrant/subtasks/:id/run` returned nothing for 300 seconds. It
 * does not fail - it hangs, because the route puts no timeout around the turn,
 * so the failure surfaces as a demo that freezes rather than an error anyone
 * can read. HANDOFF.md 5a listed this as "suspected to break local turns"; it
 * is not suspected.
 *
 * The decision lives inline in `index.ts`, which boots the whole server on
 * import and so cannot be called from a test. The source is therefore the
 * census - the same technique `client-contract.test.ts` and `security.test.ts`
 * already use for the route table.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSrc = fileURLToPath(new URL("..", import.meta.url));

/** Hostnames that only resolve inside the AEGIS container network. */
const CONTAINER_ONLY = ["aegis-broker", "host.docker.internal"];

async function read(relative: string): Promise<string> {
  return readFile(path.join(serverSrc, relative), "utf8");
}

/** The argument `index.ts` passes as `writeCodexConfig`'s base-url override. */
function baseUrlArgument(source: string): string {
  const call = source.indexOf("writeCodexConfig(");
  expect(call, "index.ts no longer calls writeCodexConfig").toBeGreaterThan(-1);
  const open = source.indexOf("(", call);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const args = source.slice(open + 1, end);
  // First argument is always `config`; the override is everything after it.
  return args.slice(args.indexOf(",") + 1).trim();
}

describe("Codex is pointed at an upstream it can reach (HANDOFF 5a, aegis/index.ts:21)", () => {
  it("decides the base_url from where Codex runs, not only from whether the broker started", async () => {
    const argument = baseUrlArgument(await read("index.ts"));

    // The broker being up is a necessary condition, never a sufficient one:
    // the runtime provider is what says whether the container network exists
    // around the process that will dial it.
    expect(
      argument,
      "index.ts picks Codex's base_url without consulting runtimeProvider, so a " +
        "local-process turn is sent to a container-only host:\n  " + argument,
    ).toMatch(/runtimeProvider|local-process|container/);
  });

  it("never hands a container-only broker host to a local-process runtime", async () => {
    const config = await read("config.ts");
    const shipped = /AEGIS_BROKER_URL:[^\n]*default\("([^"]+)"\)/.exec(config);
    expect(shipped, "AEGIS_BROKER_URL lost its default").not.toBeNull();

    const url = new URL(shipped?.[1] ?? "");
    const argument = baseUrlArgument(await read("index.ts"));
    const guarded = /runtimeProvider|local-process|container/.test(argument);

    // Either the default is a host the host can dial, or the call site checks
    // the runtime before using it. Today neither is true.
    expect(
      guarded || !CONTAINER_ONLY.includes(url.hostname),
      "AEGIS_BROKER_URL defaults to the container-only host " + url.hostname +
        " and index.ts uses it whenever the broker is up, so with the shipped " +
        "defaults (AEGIS_ENABLED=true, RUNTIME_PROVIDER=local-process) every " +
        "local turn is addressed to a name that does not resolve, and hangs.",
    ).toBe(true);
  });
});
