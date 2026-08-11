import { notebookLaneKey, type NotebookLaneIdentity } from './lane-identity'

export type NotebookSessionRegistryMember = {
  readonly sessionId: string
  shutdownExecutor: () => Promise<{ reaped: boolean }>
  releaseMcpRpcConnection: () => void
}

export type NotebookSessionRegistryOptions = {
  beforeTeardown?: () => Promise<void>
}

type AdmissionGate = {
  promise: Promise<void>
  release: () => void
}

type RemovalOperation = {
  promise: Promise<{ reaped: boolean }>
  releaseAttempted: boolean
  failureStage?: number
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
  private readonly removals = new Map<string, RemovalOperation>()
  private globalGate: AdmissionGate | undefined
  private shutdownPromise: Promise<{ reaped: boolean }> | undefined
  private terminal = false
  private disposalPromise: Promise<{ reaped: boolean }> | undefined

  constructor(private readonly options: NotebookSessionRegistryOptions = {}) {}

  private key(identity: NotebookLaneIdentity): string {
    try {
      return notebookLaneKey(identity)
    } catch {
      throw new Error('Notebook owners require an explicit Frame lane.')
    }
  }

  get(identity: NotebookLaneIdentity): Session | undefined {
    return this.sessions.get(this.key(identity))
  }

  values(): IterableIterator<Session> {
    return this.sessions.values()
  }

  getOrCreate(identity: NotebookLaneIdentity, create: () => Promise<Session>): Promise<Session> {
    const sessionId = this.key(identity)
    if (this.terminal) return Promise.reject(this.disposedError())

    const globalGate = this.globalGate
    if (globalGate) return globalGate.promise.then(() => this.getOrCreate(identity, create))

    const gate = this.removalGates.get(sessionId)
    if (gate) return gate.promise.then(() => this.getOrCreate(identity, create))

    const existing = this.sessions.get(sessionId)
    if (existing) return Promise.resolve(existing)

    const pending = this.creations.get(sessionId)
    if (pending) return pending

    const creation = Promise.resolve()
      .then(create)
      .then((session) => {
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

  remove(identity: NotebookLaneIdentity): Promise<{ reaped: boolean }> {
    const sessionId = this.key(identity)
    if (this.terminal) return Promise.reject(this.disposedError())

    const globalGate = this.globalGate
    if (globalGate) return globalGate.promise.then(() => this.remove(identity))

    const existing = this.removals.get(sessionId)
    if (existing) return existing.promise

    const gate = admissionGate()
    this.removalGates.set(sessionId, gate)
    const operation: RemovalOperation = {
      promise: Promise.resolve({ reaped: true }),
      releaseAttempted: false
    }
    operation.promise = this.removeWithinGate(sessionId, gate, operation)
    this.removals.set(sessionId, operation)
    void operation.promise.then(
      () => this.clearRemoval(sessionId, operation),
      () => this.clearRemoval(sessionId, operation)
    )
    return operation.promise
  }

  shutdownAll(): Promise<{ reaped: boolean }> {
    if (this.terminal) return Promise.reject(this.disposedError())
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

  dispose(): Promise<{ reaped: boolean }> {
    if (this.disposalPromise) return this.disposalPromise

    this.terminal = true
    const disposal = this.disposePermanently()
    this.disposalPromise = disposal
    return disposal
  }

  private async disposePermanently(): Promise<{ reaped: boolean }> {
    const shutdown = this.shutdownPromise
    if (shutdown) return shutdown
    return this.teardownOwnedSessions(true)
  }

  private async shutdownWithinGate(gate: AdmissionGate): Promise<{ reaped: boolean }> {
    try {
      return await this.teardownOwnedSessions(false)
    } finally {
      if (this.globalGate === gate) this.globalGate = undefined
      gate.release()
    }
  }

  private async teardownOwnedSessions(terminalCleanup: boolean): Promise<{ reaped: boolean }> {
    // Global gates are acquired before per-ID gates. A teardown already owned by remove() counts
    // toward this operation, but is never retried, so colliding lifecycle calls release resources once.
    const removals = Array.from(this.removals.entries()).sort(([left], [right]) =>
      left.localeCompare(right)
    )
    const removalOutcomes = await Promise.allSettled(
      removals.map(([, operation]) => operation.promise)
    )
    await this.options.beforeTeardown?.()
    await Promise.allSettled(Array.from(this.creations.values()))
    const removalIds = new Set(removals.map(([sessionId]) => sessionId))
    const sessions = Array.from(this.sessions.entries())
      .filter(([sessionId]) => !removalIds.has(sessionId))
      .sort(([left], [right]) => left.localeCompare(right))
    const outcomes = await Promise.allSettled(
      sessions.map(([, session]) => Promise.resolve().then(() => session.shutdownExecutor()))
    )
    const failures: Array<{ sessionId: string; stage: number; reason: unknown }> = []
    let reaped = true
    const terminal = terminalCleanup || this.terminal

    removalOutcomes.forEach((outcome, index) => {
      const [sessionId, operation] = removals[index]
      if (outcome.status === 'rejected') {
        failures.push({
          sessionId,
          stage: operation.failureStage ?? 0,
          reason: outcome.reason
        })
        if (terminal) {
          const session = this.sessions.get(sessionId)
          if (session && !operation.releaseAttempted) {
            operation.releaseAttempted = true
            try {
              session.releaseMcpRpcConnection()
            } catch (error) {
              failures.push({ sessionId, stage: 1, reason: error })
            }
          }
          if (session && this.sessions.get(sessionId) === session) {
            this.sessions.delete(sessionId)
          }
        }
        return
      }
      reaped &&= outcome.value.reaped
    })

    outcomes.forEach((outcome, index) => {
      const [sessionId, session] = sessions[index]
      if (outcome.status === 'rejected') {
        failures.push({ sessionId, stage: 0, reason: outcome.reason })
      } else {
        reaped &&= outcome.value.reaped
      }

      if (outcome.status === 'fulfilled' || terminal) {
        let released = false
        try {
          session.releaseMcpRpcConnection()
          released = true
        } catch (error) {
          failures.push({ sessionId, stage: 1, reason: error })
        }
        if ((released || terminal) && this.sessions.get(sessionId) === session) {
          this.sessions.delete(sessionId)
        }
      }
    })

    this.throwFailures(
      failures
        .sort(
          (left, right) => left.sessionId.localeCompare(right.sessionId) || left.stage - right.stage
        )
        .map(({ reason }) => reason)
    )
    return { reaped }
  }

  private async removeWithinGate(
    sessionId: string,
    gate: AdmissionGate,
    operation: RemovalOperation
  ): Promise<{ reaped: boolean }> {
    try {
      await this.creations.get(sessionId)?.catch(() => undefined)
      const session = this.sessions.get(sessionId)
      if (!session) return { reaped: true }

      let result: { reaped: boolean }
      try {
        result = await Promise.resolve().then(() => session.shutdownExecutor())
      } catch (error) {
        operation.failureStage = 0
        throw error
      }
      operation.releaseAttempted = true
      try {
        session.releaseMcpRpcConnection()
      } catch (error) {
        operation.failureStage = 1
        throw error
      }
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

  private clearRemoval(sessionId: string, operation: RemovalOperation): void {
    if (this.removals.get(sessionId) === operation) this.removals.delete(sessionId)
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

  private disposedError(): Error {
    return new Error('Notebook session registry has been disposed.')
  }
}
