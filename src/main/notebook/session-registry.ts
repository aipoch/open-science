export type NotebookSessionRegistryMember = {
  readonly sessionId: string
  shutdownExecutor: () => Promise<{ reaped: boolean }>
  releaseMcpRpcConnection: () => void
}

type AdmissionGate = {
  promise: Promise<void>
  release: () => void
}

const admissionGate = (): AdmissionGate => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

export class NotebookSessionRegistry<Session extends NotebookSessionRegistryMember> {
  private readonly sessions = new Map<string, Session>()
  private readonly creations = new Map<string, Promise<Session>>()
  private readonly removalGates = new Map<string, AdmissionGate>()
  private readonly removals = new Map<string, Promise<{ reaped: boolean }>>()

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getOrCreate(sessionId: string, create: () => Promise<Session>): Promise<Session> {
    const gate = this.removalGates.get(sessionId)
    if (gate) return gate.promise.then(() => this.getOrCreate(sessionId, create))

    const existing = this.sessions.get(sessionId)
    if (existing) return Promise.resolve(existing)

    const pending = this.creations.get(sessionId)
    if (pending) return pending

    const creation = create().then((session) => {
      this.sessions.set(sessionId, session)
      return session
    })
    this.creations.set(sessionId, creation)
    void creation.then(
      () => this.clearCreation(sessionId, creation),
      () => this.clearCreation(sessionId, creation)
    )
    return creation
  }

  remove(sessionId: string): Promise<{ reaped: boolean }> {
    const existing = this.removals.get(sessionId)
    if (existing) return existing

    const gate = admissionGate()
    this.removalGates.set(sessionId, gate)
    const removal = this.removeWithinGate(sessionId, gate)
    this.removals.set(sessionId, removal)
    void removal.then(
      () => this.clearRemoval(sessionId, removal),
      () => this.clearRemoval(sessionId, removal)
    )
    return removal
  }

  private async removeWithinGate(
    sessionId: string,
    gate: AdmissionGate
  ): Promise<{ reaped: boolean }> {
    try {
      await this.creations.get(sessionId)?.catch(() => undefined)
      const session = this.sessions.get(sessionId)
      if (!session) return { reaped: true }

      const result = await session.shutdownExecutor()
      session.releaseMcpRpcConnection()
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
      return result
    } finally {
      if (this.removalGates.get(sessionId) === gate) this.removalGates.delete(sessionId)
      gate.release()
    }
  }

  private clearCreation(sessionId: string, creation: Promise<Session>): void {
    if (this.creations.get(sessionId) === creation) this.creations.delete(sessionId)
  }

  private clearRemoval(sessionId: string, removal: Promise<{ reaped: boolean }>): void {
    if (this.removals.get(sessionId) === removal) this.removals.delete(sessionId)
  }
}
