import type { ResolvedAgentBackend } from './types'

const releases = new WeakMap<ResolvedAgentBackend, Promise<void>>()

const releaseResolvedAgentBackendLeases = (backend: ResolvedAgentBackend): Promise<void> => {
  const existing = releases.get(backend)
  if (existing) return existing

  const owned: Array<{ release(): Promise<void> }> = []
  if (backend.responsesBridgeLease) owned.push(backend.responsesBridgeLease)
  if (backend.anthropicBridgeLease) owned.push(backend.anthropicBridgeLease)
  if (backend.providerTransportLease) owned.push(backend.providerTransportLease)
  if (backend.skillRuntimeLease) owned.push(backend.skillRuntimeLease)
  const release = Promise.allSettled(
    [...new Set(owned)].map((lease) => Promise.resolve().then(() => lease.release()))
  ).then(() => undefined)
  releases.set(backend, release)
  return release
}

export { releaseResolvedAgentBackendLeases }
