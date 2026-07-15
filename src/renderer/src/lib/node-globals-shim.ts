// Ketcher's dependencies (util / assert polyfills, indigo helpers) reference the Node globals
// `process` and `global`, which don't exist in the sandboxed Electron renderer. Provide a minimal
// shim so those modules load in the browser context. Imported first in the renderer entry so the
// globals exist before any lazy Ketcher chunk is fetched.
const globalScope = globalThis as unknown as Record<string, unknown>

if (typeof globalScope.global === 'undefined') {
  globalScope.global = globalThis
}

if (typeof globalScope.process === 'undefined') {
  globalScope.process = {
    env: {},
    argv: [],
    version: '',
    versions: {},
    platform: 'browser',
    browser: true,
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      queueMicrotask(() => callback(...args)),
    cwd: () => '/',
    stderr: {},
    stdout: {}
  }
}
