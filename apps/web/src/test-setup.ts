/**
 * jsdom is missing a handful of DOM APIs that Monaco touches at import time,
 * which is early enough to take a whole suite down before a single test runs:
 * `console.test.tsx` failed as "0 tests" with `document.queryCommandSupported
 * is not a function`, thrown from monaco's clipboard contribution while
 * `monacoSetup.ts` was still being imported.
 *
 * These are stubs, not implementations. Nothing here asserts anything or
 * changes what a test observes about our own code - it only gives Monaco the
 * shape of a browser it expects to exist, so the failure a test reports is
 * about the product rather than about the environment.
 */

if (typeof document !== "undefined" && !("queryCommandSupported" in document)) {
  // Monaco asks whether paste is available before registering its command.
  // Answering "no" is honest in jsdom and keeps the contribution inert.
  Object.defineProperty(document, "queryCommandSupported", {
    value: () => false,
    configurable: true,
  });
  Object.defineProperty(document, "execCommand", {
    value: () => false,
    configurable: true,
  });
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    configurable: true,
  });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
