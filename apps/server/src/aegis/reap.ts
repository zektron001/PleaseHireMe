/**
 * KS-9 - forced cleanup.
 *
 * Reaps every container the platform has ever labelled, by label rather than by
 * a tracked handle, so a container that outlived its parent process (a crash
 * mid-run) is still removed. Called by the kill switch and at boot.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";

const execFileAsync = promisify(execFile);

const LABEL = "io.codejam.launchpad=agent-runtime";

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Returns the number of containers removed. Never throws. */
export async function reapAllRuntimeContainers(
  config: AppConfig,
): Promise<number> {
  const env = childEnvironment();
  try {
    const { stdout } = await execFileAsync(
      config.containerEngine,
      ["ps", "--quiet", "--filter", "label=" + LABEL],
      { timeout: 8_000, env },
    );
    const ids = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (ids.length === 0) return 0;

    await execFileAsync(config.containerEngine, ["rm", "--force", ...ids], {
      timeout: 15_000,
      env,
    });
    return ids.length;
  } catch {
    // A missing or stopped engine is not a reason to fail the kill switch: the
    // latch is already armed, and armed-with-zero-reaped is the safe outcome.
    return 0;
  }
}
