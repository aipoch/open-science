import {
  rebaseResolvedAgentBackendSkillRuntime,
  releaseResolvedAgentBackendLeases,
  type ResolvedAgentBackend
} from '../agent-framework'
import type { DelegateExecutionBackendClaim, DelegateExecutionBackendLease } from './execution-port'

const releaseAttemptRuntime = async (release: () => Promise<void>): Promise<void> => {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await release()
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

// The underlying bridge/transport leases have one owner regardless of batch width. Child runtimes
// receive a lease-free backend rebound to their private runtime through the framework seam and keep
// the owner alive through explicit in-memory claims.
// Secrets remain in this process-local object and can never enter a durable Attempt record.
const createDelegateExecutionBackendLease = (
  backend: ResolvedAgentBackend
): DelegateExecutionBackendLease => {
  let references = 1
  let underlyingRelease: Promise<void> | undefined
  let admissionReleased = false

  const releaseReference = (): Promise<void> => {
    if (references <= 0) return underlyingRelease ?? Promise.resolve()
    references -= 1
    if (references === 0) {
      underlyingRelease ??= releaseResolvedAgentBackendLeases(backend)
      return underlyingRelease
    }
    return Promise.resolve()
  }

  return Object.freeze({
    claim(): DelegateExecutionBackendClaim {
      if (references <= 0) throw new Error('Delegated execution backend admission has closed.')
      references += 1
      let attemptRuntime:
        Promise<Readonly<{ backend: ResolvedAgentBackend; release(): Promise<void> }>> | undefined
      let releasePromise: Promise<void> | undefined
      return Object.freeze({
        acquireAttemptBackend(request): Promise<ResolvedAgentBackend> {
          if (releasePromise) {
            return Promise.reject(new Error('Delegated execution backend claim has closed.'))
          }
          if (!backend.skillRuntime || !backend.skillRuntimeFork) {
            return Promise.reject(
              new Error('The admitted delegated backend has no forkable Skill runtime.')
            )
          }
          attemptRuntime ??= backend.skillRuntimeFork
            .acquire(request.lifecycle)
            .then(async (runtime) => {
              try {
                const rebound = rebaseResolvedAgentBackendSkillRuntime(backend, runtime.view)
                return Object.freeze({
                  backend: Object.freeze({
                    ...rebound,
                    skillRuntimeFork: undefined,
                    responsesBridgeLease: undefined,
                    anthropicBridgeLease: undefined,
                    providerTransportLease: undefined,
                    skillRuntimeLease: undefined
                  }),
                  release: () => runtime.lease.release()
                })
              } catch (error) {
                await releaseAttemptRuntime(() => runtime.lease.release())
                throw error
              }
            })
          return attemptRuntime.then((runtime) => runtime.backend)
        },
        release(): Promise<void> {
          releasePromise ??= (async () => {
            try {
              if (attemptRuntime) {
                const runtime = await attemptRuntime.catch(() => undefined)
                if (runtime) await releaseAttemptRuntime(runtime.release)
              }
            } finally {
              await releaseReference()
            }
          })()
          return releasePromise
        }
      })
    },
    async release(): Promise<void> {
      if (admissionReleased) return
      admissionReleased = true
      await releaseReference()
    }
  })
}

export { createDelegateExecutionBackendLease }
