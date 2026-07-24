// jsdom doesn't implement ResizeObserver, but react-zoom-pan-pinch constructs one on mount — so any
// test that renders an image preview (directly or via the Files dialog) would throw without this.
// Registering it once here keeps the shim out of every individual suite. Harmless under the node
// environment, where nothing references it.
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
