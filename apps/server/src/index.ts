import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { Aegis } from "./aegis/index.js";
import { reapAllRuntimeContainers } from "./aegis/reap.js";
import { WarrantPlane } from "./warrant/index.js";

const config = loadConfig();

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const aegis = config.aegisEnabled ? await Aegis.bootstrap(config) : undefined;

// Written after AEGIS, because where Codex sends its requests depends on
// whether the broker is up. With it, the container is told about the broker and
// never learns the real upstream; without it, nothing changes from the baseline.
await writeCodexConfig(
  config,
  // Two conditions, not one. The broker being up says the egress plane exists;
  // `runtimeProvider` says whether the process that will dial it is inside the
  // container network where AEGIS_BROKER_URL resolves AND where the per-run
  // capability gets injected in place of the API key. Under `local-process`
  // neither holds: the name does not resolve, so the turn hangs until the
  // Codex timeout, and even pointed at loopback the broker refuses it as
  // "Run capability is unknown". So a local turn talks to Ark directly.
  aegis?.egress && config.runtimeProvider === "container"
    ? config.aegisBrokerUrl
    : undefined,
);
const runner = createRunner(config, aegis);
// One chain for both planes, so an egress crossing and the authorization that
// permitted it are neighbours in the same verifiable record.
const warrantPlane = await WarrantPlane.bootstrap(config, aegis?.audit);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const app = await createApp(
  config,
  service,
  aegis
    ? { aegis, reapAll: () => reapAllRuntimeContainers(config) }
    : undefined,
  warrantPlane,
  runner,
);

// One line, at startup, about whether a hardened run can actually complete.
// The alternative is finding out at the end of a turn, from an error that names
// the wrong cause.
if (aegis) {
  const ready = aegis.liveRunPossible;
  app.log[ready.ok ? "info" : "warn"](
    { network: aegis.network, broker: aegis.broker },
    "AEGIS: " + ready.reason,
  );
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
