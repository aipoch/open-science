// In-memory registry mapping sessionId → enabled compute providerIds (set semantics, array storage).
// Populated when the renderer calls the set IPC after loading a session, and updated on each toggle.
// The registry is the authoritative source for `list_compute` RPC ops — the renderer is the
// persistent source (session JSON), the main process is the runtime cache.
export class EnabledComputeHostsRegistry {
  private readonly map = new Map<string, Set<string>>()

  get(sessionId: string): string[] {
    return [...(this.map.get(sessionId) ?? [])]
  }

  set(sessionId: string, providerIds: string[]): void {
    const validated = providerIds.filter(
      (id) => typeof id === 'string' && id.startsWith('ssh:') && id.length > 4
    )
    if (validated.length > 0) {
      this.map.set(sessionId, new Set(validated))
    } else {
      this.map.delete(sessionId)
    }
  }

  clear(sessionId: string): void {
    this.map.delete(sessionId)
  }
}

export const enabledComputeHostsRegistry = new EnabledComputeHostsRegistry()

// Augments a ComputeService instance with a getEnabledComputeHosts method so the notebook RPC server
// can serve the list_compute op. ComputeService is a class whose methods live on the prototype, so a
// naive object spread ({...service}) would copy only own enumerable properties and silently drop every
// prototype method — leaving list_compute working but list/details/submit_job as "not a function".
// We layer the added method onto a fresh object that shares the service's prototype, preserving the
// full method surface without mutating the original instance.
export function attachEnabledComputeHosts<T extends object>(
  service: T,
  registry: EnabledComputeHostsRegistry
): T & { getEnabledComputeHosts(sessionId: string): string[] } {
  return Object.assign(Object.create(Object.getPrototypeOf(service)), service, {
    getEnabledComputeHosts: (sessionId: string): string[] => registry.get(sessionId)
  })
}
