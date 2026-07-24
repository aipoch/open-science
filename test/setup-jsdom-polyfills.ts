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
