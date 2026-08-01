export type NotebookSessionRegistryMember = {
  readonly sessionId: string
  shutdownExecutor: () => Promise<{ reaped: boolean }>
  releaseMcpRpcConnection: () => void
}

export class NotebookSessionRegistry<Session extends NotebookSessionRegistryMember> {
  private readonly sessions = new Map<string, Session>()
  private readonly creations = new Map<string, Promise<Session>>()

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getOrCreate(sessionId: string, create: () => Promise<Session>): Promise<Session> {
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

  private clearCreation(sessionId: string, creation: Promise<Session>): void {
    if (this.creations.get(sessionId) === creation) this.creations.delete(sessionId)
  }
}
