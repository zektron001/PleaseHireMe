/**
 * Root config so that `npx vitest` at the repo root does the right thing.
 *
 * Without this, vitest run from the root finds every `*.test.ts(x)` in the
 * monorepo and applies ONE config to all of them - which means the React
 * component tests under apps/web run without `environment: "jsdom"` and fail
 * with "document is not defined". Eleven tests that pass under `npm test`
 * appear broken, and the failure looks like a product bug rather than a
 * missing DOM.
 *
 * `projects` delegates to each workspace's own config instead, so the server
 * tests get node and the web tests get jsdom no matter where vitest is
 * invoked from. `npm test` was already correct (it runs each workspace's
 * script with that workspace as cwd); this makes the bare command match it.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/server", "apps/web"],
  },
});
