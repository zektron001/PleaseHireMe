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
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const aegis = config.aegisEnabled ? await Aegis.bootstrap(config) : undefined;
const runner = createRunner(config, aegis);
const warrantPlane = await WarrantPlane.bootstrap(config);
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

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
