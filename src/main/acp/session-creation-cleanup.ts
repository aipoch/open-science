// Creation failures can return before cleanup, while the enclosing workspace writer still needs
// to hold its lease until capability writes settle. This association never crosses IPC.
const creationCleanup = new WeakMap<object, Promise<void>>()

export const retainSessionCreationCleanup = (error: unknown, cleanup: Promise<void>): void => {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    const previous = creationCleanup.get(error)
    const settlement = previous ? Promise.all([previous, cleanup]).then(() => undefined) : cleanup
    creationCleanup.set(error, settlement)
    void settlement
      .finally(() => {
        if (creationCleanup.get(error) === settlement) creationCleanup.delete(error)
      })
      .catch(() => undefined)
  }
}

export const waitForSessionCreationCleanup = (error: unknown): Promise<void> | undefined =>
  (typeof error === 'object' && error !== null) || typeof error === 'function'
    ? creationCleanup.get(error)
    : undefined
