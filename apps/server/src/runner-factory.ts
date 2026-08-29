import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import type { AgentRunner } from "./types.js";
import type { Aegis } from "./aegis/index.js";
import { GuardedAgentRunner } from "./aegis/guarded-runner.js";

/**
 * The entire AEGIS integration seam. Without `aegis` this returns exactly the
 * runner the starter kit shipped, so the middleware can be disabled with one
 * environment variable and the baseline journey is provably unchanged.
 */
export function createRunner(config: AppConfig, aegis?: Aegis): AgentRunner {
  const inner: AgentRunner =
    config.runtimeProvider === "container"
      ? new ContainerCodexRunner(config)
      : new CodexRunner(config);

  if (!aegis) return inner;
  return new GuardedAgentRunner(inner, aegis, config.codexHome);
}
