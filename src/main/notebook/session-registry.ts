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
  private globalGate: AdmissionGate | undefined
  private shutdownPromise: Promise<{ reaped: boolean }> | undefined

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getOrCreate(sessionId: string, create: () => Promise<Session>): Promise<Session> {
    const globalGate = this.globalGate
    if (globalGate) return globalGate.promise.then(() => this.getOrCreate(sessionId, create))

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
    const globalGate = this.globalGate
    if (globalGate) return globalGate.promise.then(() => this.remove(sessionId))

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

  shutdownAll(): Promise<{ reaped: boolean }> {
    if (this.shutdownPromise) return this.shutdownPromise

    const gate = admissionGate()
    this.globalGate = gate
    const shutdown = this.shutdownWithinGate(gate)
    this.shutdownPromise = shutdown
    void shutdown.then(
      () => this.clearShutdown(shutdown),
      () => this.clearShutdown(shutdown)
    )
    return shutdown
  }

  private async shutdownWithinGate(gate: AdmissionGate): Promise<{ reaped: boolean }> {
    try {
      const removals = Array.from(this.removals.entries()).sort(([left], [right]) =>
        left.localeCompare(right)
      )
      const removalOutcomes = await Promise.allSettled(removals.map(([, removal]) => removal))
      await Promise.allSettled(Array.from(this.creations.values()))
      const removalIds = new Set(removals.map(([sessionId]) => sessionId))
      const sessions = Array.from(this.sessions.entries())
        .filter(([sessionId]) => !removalIds.has(sessionId))
        .sort(([left], [right]) => left.localeCompare(right))
      const outcomes = await Promise.allSettled(
        sessions.map(([, session]) => session.shutdownExecutor())
      )
      const failures: Array<{ sessionId: string; reason: unknown }> = []
      let reaped = true

      removalOutcomes.forEach((outcome, index) => {
        const [sessionId] = removals[index]
        if (outcome.status === 'rejected') {
          failures.push({ sessionId, reason: outcome.reason })
          return
        }
        reaped &&= outcome.value.reaped
      })

      outcomes.forEach((outcome, index) => {
        const [sessionId, session] = sessions[index]
        if (outcome.status === 'rejected') {
          failures.push({ sessionId, reason: outcome.reason })
          return
        }

        reaped &&= outcome.value.reaped
        session.releaseMcpRpcConnection()
        if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
      })

      this.throwFailures(
        failures
          .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
          .map(({ reason }) => reason)
      )
      return { reaped }
    } finally {
      if (this.globalGate === gate) this.globalGate = undefined
      gate.release()
    }
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

  private clearShutdown(shutdown: Promise<{ reaped: boolean }>): void {
    if (this.shutdownPromise === shutdown) this.shutdownPromise = undefined
  }

  private throwFailures(failures: unknown[]): void {
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Multiple notebook sessions failed to shut down.')
    }
  }
}
