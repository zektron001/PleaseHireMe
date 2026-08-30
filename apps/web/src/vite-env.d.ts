/// <reference types="vite/client" />

/**
 * Vite's `?worker` suffix imports. Declared here rather than pulled in wholesale
 * because `vite/client` also widens `import.meta`, and this is the only part of
 * it the app actually uses.
 */
declare module "*?worker" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
