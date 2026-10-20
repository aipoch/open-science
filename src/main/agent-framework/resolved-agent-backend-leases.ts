import type { ResolvedAgentBackend } from './types'

const releases = new WeakMap<ResolvedAgentBackend, Promise<void>>()

const releaseResolvedAgentBackendLeases = (backend: ResolvedAgentBackend): Promise<void> => {
  const existing = releases.get(backend)
  if (existing) return existing

  const owned: Array<{ release(): Promise<void> }> = []
  if (backend.responsesTransportLease) owned.push(backend.responsesTransportLease)
  if (backend.messagesBridgeLease) owned.push(backend.messagesBridgeLease)
  if (backend.providerTransportLease) owned.push(backend.providerTransportLease)
  const release = Promise.allSettled(
    [...new Set(owned)].map((lease) => Promise.resolve().then(() => lease.release()))
  ).then(() => undefined)
  releases.set(backend, release)
  return release
}

export { releaseResolvedAgentBackendLeases }
