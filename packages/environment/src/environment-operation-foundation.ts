import type { NotebookLanguage } from './contracts'
import type { RuntimeProvisioner } from './provisioner'

const SERIALIZED = Symbol('serializedProvisioner')

// RuntimeProvisioner has one shared provisioning flag for Python and R. This wrapper owns the single
// mutation queue used by startup, renderer commands, and lazy default-environment materialization.
const serializeProvisioner = (provisioner: RuntimeProvisioner): RuntimeProvisioner => {
  if ((provisioner as { [SERIALIZED]?: true })[SERIALIZED]) return provisioner

  let inFlight: Promise<void> = Promise.resolve()
  // Counts include running and queued operations. A Set would release a language too early when two
  // requests for the same language overlap.
  const pending = new Map<NotebookLanguage, number>()
  const retain = (language: NotebookLanguage): void => {
    pending.set(language, (pending.get(language) ?? 0) + 1)
  }
  const release = (language: NotebookLanguage): void => {
    const next = (pending.get(language) ?? 0) - 1
    if (next <= 0) pending.delete(language)
    else pending.set(language, next)
  }

  const serialize = (run: () => Promise<void>): Promise<void> => {
    const next = inFlight.then(run, run)
    // The caller still receives `next` and its original rejection. Only the internal chain tracker
    // swallows it so a failed operation cannot poison every later request.
    inFlight = next.catch(() => undefined)
    return next
  }
  const serializeLanguage = (
    language: NotebookLanguage,
    run: () => Promise<void>
  ): Promise<void> => {
    retain(language)
    return serialize(async () => {
      try {
        await run()
      } finally {
        release(language)
      }
    })
  }

  const wrapped: RuntimeProvisioner = {
    status: () => provisioner.status(),
    provisionPython: (onProgress) =>
      serializeLanguage('python', () => provisioner.provisionPython(onProgress)),
    provisionR: (onProgress) => serializeLanguage('r', () => provisioner.provisionR(onProgress)),
    upgradeIfNeeded: (onProgress) => serialize(() => provisioner.upgradeIfNeeded(onProgress)),
    repair: (language, onProgress, options) =>
      serializeLanguage(language, () => provisioner.repair(language, onProgress, options)),
    restoreRelocatedEnvs: (onProgress) =>
      serialize(() => provisioner.restoreRelocatedEnvs(onProgress)),
    // Cancellation must interrupt immediately rather than wait behind the operation it is aborting.
    // A language-specific idle cancel remains a no-op so it cannot arm an unrelated future operation.
    cancel: (language) => {
      if (language !== undefined && (pending.get(language) ?? 0) === 0) return
      provisioner.cancel(language)
    }
  }
  ;(wrapped as { [SERIALIZED]?: true })[SERIALIZED] = true
  return wrapped
}

export { serializeProvisioner }
