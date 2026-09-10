import { AsyncLocalStorage } from 'node:async_hooks'

// Progress is scoped to one operation, including inventory helpers used by reference bundles.
// It never changes the durable journal or substitutes for an integrity check.
const current = new AsyncLocalStorage()
export const withMigrationProgress = (callback, operation) =>
  current.run({ callback, lastKey: '', lastAt: 0 }, operation)

export function reportProgress(event, force = false) {
  const context = current.getStore()
  if (!context) return
  const key = `${event.phase}:${event.path ?? ''}`
  const now = Date.now()
  if (
    !force &&
    event.completed !== undefined &&
    key === context.lastKey &&
    now - context.lastAt < 250
  )
    return
  context.lastKey = key
  context.lastAt = now
  // Database adapters call this synchronously inside their transaction. Preserve thrown errors.
  return context.callback(event)
}
