import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  test: {
    // Component tests need a DOM. The pure-function tests do not care, and
    // jsdom is cheap enough that splitting environments is not worth it.
    environment: "jsdom",
    // Monaco reaches for browser APIs jsdom does not implement, at import
    // time. Without these stubs a whole component suite reports "0 tests".
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
