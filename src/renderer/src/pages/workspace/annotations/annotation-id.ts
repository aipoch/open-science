const createAnnotationId = (): string =>
  globalThis.crypto?.randomUUID
    ? `annotation-${globalThis.crypto.randomUUID()}`
    : `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`

export { createAnnotationId }
