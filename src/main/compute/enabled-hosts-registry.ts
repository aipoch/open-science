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
