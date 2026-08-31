/**
 * Does `npm run dev -w @launchpad/server` start on a stock Mac?
 *
 * Both of this workspace's entry scripts are `scripts/run-server.sh`, so its
 * portability is the server's start-up contract, not a shell detail.
 *
 * The script opens `set -euo pipefail` and then expands an array that is empty
 * whenever the repo has no credentials file:
 *
 *     env_flag=()
 *     ...
 *     exec node "${env_flag[@]}" dist/index.js
 *
 * Under `set -u`, bash 3.2 treats expanding an empty array as an unbound
 * variable and aborts. bash 4.4 fixed this. macOS still ships 3.2.57 - Apple
 * froze it at the last GPLv2 release - so `/usr/bin/env bash` on the machine
 * this branch is named for is the one interpreter where the script dies:
 *
 *     $ /bin/bash -c 'set -euo pipefail; arr=(); node --version "${arr[@]}"'
 *     bash: arr[@]: unbound variable
 *
 * It only stays hidden because a developer who already wrote a credentials
 * file makes the array non-empty. A fresh clone - a new teammate, a CI runner,
 * a reviewer checking the branch out - takes the empty path and gets an error
 * naming an internal variable instead of a server.
 *
 * Two tests, because each covers the other's blind spot. The behavioural one
 * runs the real script and is the proof, but it passes anywhere bash >= 4.4 is
 * the default interpreter, which includes most Linux CI. The textual one is the
 * portable statement of the same defect and fails everywhere until the
 * expansion is guarded as `${env_flag[@]+"${env_flag[@]}"}`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptPath = path.join(repoRoot, "scripts", "run-server.sh");
const script = readFileSync(scriptPath, "utf8");

/** Enough for the script's own tools - dirname, pwd, mkdir - and nothing else. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway repo holding nothing but the script under test, so it takes the
 * no-credentials-file branch without reading - or needing - the real repo's.
 * `node` and `npx` are stubbed, so the script's `exec` lands on a marker
 * instead of booting a server.
 */
function sandbox(): { dir: string; bin: string; marker: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "run-server-"));
  sandboxes.push(dir);

  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "apps", "server"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "run-server.sh"), script, "utf8");
  chmodSync(path.join(dir, "scripts", "run-server.sh"), 0o755);

  const bin = path.join(dir, "bin");
  const marker = path.join(dir, "exec-reached");
  mkdirSync(bin);
  for (const name of ["node", "npx"]) {
    const stub = path.join(bin, name);
    writeFileSync(stub, `#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\n`, "utf8");
    chmodSync(stub, 0o755);
  }
  return { dir, bin, marker };
}

describe("scripts/run-server.sh starts the server on the bash macOS ships", () => {
  it("runs to its exec when the repo has no credentials file", () => {
    const { dir, bin } = sandbox();

    const result = spawnSync(
      "/usr/bin/env",
      ["bash", path.join(dir, "scripts", "run-server.sh"), "start"],
      {
        encoding: "utf8",
        // Deliberately minimal and inherited from nothing: the stubs come
        // first so `exec` cannot reach a real node, and the sandbox stays a
        // sandbox.
        env: { PATH: bin + ":" + SYSTEM_PATH, HOME: dir },
      },
    );

    const stderr = (result.stderr ?? "").trim();
    expect(
      stderr,
      "run-server.sh aborted before starting anything. This is the bash 3.2 " +
        "empty-array expansion under `set -u`, and macOS bash is 3.2:\n  " + stderr,
    ).not.toMatch(/unbound variable/);
    expect(result.status, "run-server.sh exited " + result.status + ": " + stderr).toBe(0);
  });

  it("guards every array it expands under `set -u`", () => {
    // Only meaningful because the script asks for -u; without it bash 3.2 is
    // happy and there is nothing to guard.
    expect(script, "run-server.sh no longer sets -u").toMatch(/set -[a-z]*u[a-z]* /);

    /**
     * Comments are not code, and this test could not tell the difference.
     *
     * The fix for this very finding added a line explaining itself:
     *
     *   # Expanded below as ${env_flag[@]+"${env_flag[@]}"} rather than "${env_flag[@]}".
     *
     * That sentence contains one more bare form than guarded form, so the
     * arithmetic below counted it as an unguarded expansion and the finding
     * survived its own fix. The assertion is unchanged - no bare expansion in
     * the script's CODE - it simply now reads only the code.
     */
    const code = script
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    const emptyArrays = [...code.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=\(\s*\)\s*$/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(emptyArrays.length, "expected run-server.sh to declare an empty array").toBeGreaterThan(
      0,
    );

    for (const name of emptyArrays) {
      // `${arr[@]+"${arr[@]}"}` is the portable form: the +-expansion is
      // skipped entirely when the array is unset, so -u never sees it.
      const bare = new RegExp('"\\$\\{' + name + '\\[@\\]\\}"', "g");
      const guarded = new RegExp("\\$\\{" + name + "\\[@\\]\\+", "g");
      const bareUses = [...code.matchAll(bare)].length;
      const guardedUses = [...code.matchAll(guarded)].length;

      expect(
        bareUses - guardedUses,
        "run-server.sh expands `" +
          name +
          '` as "${' +
          name +
          '[@]}" under `set -u`, which bash 3.2 - the bash macOS ships - rejects ' +
          "as an unbound variable whenever the array is empty. Write it as ${" +
          name +
          '[@]+"${' +
          name +
          '[@]}"}.',
      ).toBe(0);
    }
  });
});
