// jsdom doesn't implement ResizeObserver, but react-zoom-pan-pinch constructs one on mount.
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {
      /* no-op: layout measurement isn't meaningful in jsdom */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
}

// Node 26 exposes an unusable experimental localStorage getter unless --localstorage-file is set.
// Install a consistent browser-compatible surface without reading that warning-producing getter.
const values = new Map<string, string>()
const localStorage: Storage = {
  get length() {
    return values.size
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(String(key)) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => values.delete(String(key)),
  setItem: (key, value) => values.set(String(key), String(value))
}
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorage
})
