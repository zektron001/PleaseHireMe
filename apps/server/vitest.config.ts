import { defineConfig } from "vitest/config";

/**
 * Test configuration for the control plane.
 *
 * Coverage is reported, never gated. A percentage threshold buys assertions on
 * getters; the useful output is the file list - which of the ~10k server lines
 * no test enters at all.
 */
export default defineConfig({
  test: {
    // Each suite that boots a WarrantPlane writes to its own mkdtemp directory,
    // so files are isolated. Within a file, tests share that directory, so the
    // default per-file isolation is what keeps them honest.
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // The demo is a narrated script; it is a test artefact already.
        "src/warrant/demo.ts",
        "src/**/types.ts",
      ],
    },
  },
});
