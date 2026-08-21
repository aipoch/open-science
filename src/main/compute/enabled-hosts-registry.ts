import type { SessionComputeHostAccess } from './session-compute-host-access'

// Derived runtime projection mapping Session id to enabled and selected Compute Host ids. Durable
// Session JSON is the authority; this cache serves synchronous Agent SDK admission and discovery.
export class EnabledComputeHostsRegistry {
  private readonly map = new Map<
    string,
    { enabledProviderIds: Set<string>; selectedProviderIds: Set<string> }
  >()

  get(sessionId: string): string[] {
    return this.getEnabled(sessionId)
  }

  getEnabled(sessionId: string): string[] {
    return [...(this.map.get(sessionId)?.enabledProviderIds ?? [])]
  }

  getSelected(sessionId: string): string[] {
    return [...(this.map.get(sessionId)?.selectedProviderIds ?? [])]
  }

  set(sessionId: string, providerIds: string[]): void {
    this.setAccess(sessionId, {
      enabledProviderIds: providerIds,
      selectedProviderIds: providerIds
    })
  }

  setAccess(sessionId: string, access: SessionComputeHostAccess): void {
    const enabledProviderIds = access.enabledProviderIds.filter(
      (id) => typeof id === 'string' && id.startsWith('ssh:') && id.length > 4
    )
    const enabledProviderIdSet = new Set(enabledProviderIds)
    const selectedProviderIds = access.selectedProviderIds.filter((id) =>
      enabledProviderIdSet.has(id)
    )
    if (enabledProviderIds.length > 0 || selectedProviderIds.length > 0) {
      this.map.set(sessionId, {
        enabledProviderIds: enabledProviderIdSet,
        selectedProviderIds: new Set(selectedProviderIds)
      })
    } else {
      this.map.delete(sessionId)
    }
  }

  clear(sessionId: string): void {
    this.map.delete(sessionId)
  }

  removeProvider(providerId: string): void {
    for (const [sessionId, access] of this.map) {
      access.enabledProviderIds.delete(providerId)
      access.selectedProviderIds.delete(providerId)
      if (access.enabledProviderIds.size === 0) this.map.delete(sessionId)
    }
  }

  reconcile(
    entries: Iterable<readonly [sessionId: string, providerIds: readonly string[]]>,
    isComplete: boolean
  ): void {
    if (isComplete) this.map.clear()
    for (const [sessionId, providerIds] of entries) this.set(sessionId, [...providerIds])
  }

  reconcileAccess(
    entries: Iterable<readonly [sessionId: string, access: SessionComputeHostAccess]>,
    isComplete: boolean
  ): void {
    if (isComplete) this.map.clear()
    for (const [sessionId, access] of entries) this.setAccess(sessionId, access)
  }
}

export const enabledComputeHostsRegistry = new EnabledComputeHostsRegistry()

// Augments a ComputeService instance with a getEnabledComputeHosts method so the notebook RPC server
// can serve the list_compute/list_preferred ops. ComputeService is a class whose methods live on the prototype, so a
// naive object spread ({...service}) would copy only own enumerable properties and silently drop every
// prototype method — leaving list_compute working but list/details/submit_job as "not a function".
// We layer the added method onto a fresh object that shares the service's prototype, preserving the
// full method surface without mutating the original instance.
export function attachEnabledComputeHosts<T extends object>(
  service: T,
  registry: EnabledComputeHostsRegistry
): T & {
  getEnabledComputeHosts(sessionId: string): string[]
  getSelectedComputeHosts(sessionId: string): string[]
} {
  return Object.assign(Object.create(Object.getPrototypeOf(service)), service, {
    getEnabledComputeHosts: (sessionId: string): string[] => registry.getEnabled(sessionId),
    getSelectedComputeHosts: (sessionId: string): string[] => registry.getSelected(sessionId)
  })
}
