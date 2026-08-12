import { releaseResolvedAgentBackendLeases, type ResolvedAgentBackend } from '../agent-framework'
import type { DelegateExecutionBackendClaim, DelegateExecutionBackendLease } from './execution-port'

// The underlying bridge/transport leases have one owner regardless of batch width. Child runtimes
// receive a lease-free backend view and keep the owner alive through explicit in-memory claims.
// Secrets remain in this process-local object and can never enter a durable Attempt record.
const createDelegateExecutionBackendLease = (
  backend: ResolvedAgentBackend
): DelegateExecutionBackendLease => {
  const runtimeBackend: ResolvedAgentBackend = Object.freeze({
    ...backend,
    responsesBridgeLease: undefined,
    anthropicBridgeLease: undefined,
    providerTransportLease: undefined
  })
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
      let released = false
      return Object.freeze({
        backend: runtimeBackend,
        async release(): Promise<void> {
          if (released) return
          released = true
          await releaseReference()
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
