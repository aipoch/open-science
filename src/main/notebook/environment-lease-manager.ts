export type EnvironmentLeaseMode = 'shared' | 'exclusive'

export type EnvironmentLeaseSnapshot = {
  disposed: boolean
  environments: Array<{
    environment: string
    holders: { shared: number; exclusive: number }
    waiters: { shared: number; exclusive: number }
  }>
}

export type EnvironmentLease = {
  release(): boolean
}

export type EnvironmentLeaseAcquisition = {
  readonly granted: Promise<EnvironmentLease>
  cancel(): boolean
}

type PendingAcquisition = {
  mode: EnvironmentLeaseMode
  acquisition: EnvironmentLeaseAcquisition
  resolve: (lease: EnvironmentLease) => void
  reject: (error: Error) => void
}

type EnvironmentLeaseState = {
  holders: Map<EnvironmentLease, EnvironmentLeaseMode>
  waiters: PendingAcquisition[]
}

export class EnvironmentLeaseManager {
  private readonly states = new Map<string, EnvironmentLeaseState>()
  private disposed = false

  acquire(environment: string, mode: EnvironmentLeaseMode): EnvironmentLeaseAcquisition {
    let resolveGranted!: (lease: EnvironmentLease) => void
    let rejectGranted!: (error: Error) => void
    const granted = new Promise<EnvironmentLease>((resolve, reject) => {
      resolveGranted = resolve
      rejectGranted = reject
    })
    const acquisition: EnvironmentLeaseAcquisition = {
      granted,
      cancel: () => this.cancelPendingAcquisition(environment, pending)
    }
    const pending = { mode, acquisition, resolve: resolveGranted, reject: rejectGranted }

    if (this.disposed) {
      pending.reject(new Error('Environment lease manager is disposed.'))
      return acquisition
    }

    const state = this.stateFor(environment)
    if (
      state.waiters.length === 0 &&
      (state.holders.size === 0 ||
        (mode === 'shared' &&
          Array.from(state.holders.values()).every((held) => held === 'shared')))
    ) {
      this.grant(environment, state, pending)
    } else {
      state.waiters.push(pending)
    }
    return acquisition
  }

  hasExclusive(environment: string): boolean {
    const state = this.states.get(environment)
    return Boolean(
      state &&
      (Array.from(state.holders.values()).includes('exclusive') ||
        state.waiters.some((waiter) => waiter.mode === 'exclusive'))
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const [environment, state] of Array.from(this.states.entries())) {
      const waiters = state.waiters.splice(0)
      for (const waiter of waiters) {
        waiter.reject(new Error('Environment lease manager is disposed.'))
      }
      for (const lease of Array.from(state.holders.keys())) lease.release()
      this.states.delete(environment)
    }
  }

  snapshot(): EnvironmentLeaseSnapshot {
    return {
      disposed: this.disposed,
      environments: Array.from(this.states.entries())
        .map(([environment, state]) => ({
          environment,
          holders: this.countModes(state.holders.values()),
          waiters: this.countModes(state.waiters.map((waiter) => waiter.mode))
        }))
        .sort((left, right) => left.environment.localeCompare(right.environment))
    }
  }

  private stateFor(environment: string): EnvironmentLeaseState {
    let state = this.states.get(environment)
    if (!state) {
      state = { holders: new Map(), waiters: [] }
      this.states.set(environment, state)
    }
    return state
  }

  private grant(
    environment: string,
    state: EnvironmentLeaseState,
    pending: PendingAcquisition
  ): void {
    let released = false
    const lease: EnvironmentLease = {
      release: () => {
        if (released) return false
        released = true
        this.release(environment, state, lease)
        return true
      }
    }
    state.holders.set(lease, pending.mode)
    pending.resolve(lease)
  }

  private cancelPendingAcquisition(environment: string, pending: PendingAcquisition): boolean {
    const state = this.states.get(environment)
    const index = state?.waiters.indexOf(pending) ?? -1
    if (!state || index < 0) return false
    state.waiters.splice(index, 1)
    pending.reject(new Error('Environment lease acquisition was cancelled.'))
    this.pump(environment, state)
    this.deleteEmptyState(environment, state)
    return true
  }

  private release(
    environment: string,
    state: EnvironmentLeaseState,
    lease: EnvironmentLease
  ): void {
    if (!state.holders.delete(lease)) return
    this.pump(environment, state)
    this.deleteEmptyState(environment, state)
  }

  private pump(environment: string, state: EnvironmentLeaseState): void {
    if (Array.from(state.holders.values()).some((mode) => mode === 'exclusive')) return
    if (state.holders.size > 0) {
      while (state.waiters[0]?.mode === 'shared') {
        this.grant(environment, state, state.waiters.shift()!)
      }
      return
    }
    const next = state.waiters.shift()
    if (!next) return
    this.grant(environment, state, next)
    if (next.mode === 'exclusive') return
    while (state.waiters[0]?.mode === 'shared') {
      this.grant(environment, state, state.waiters.shift()!)
    }
  }

  private deleteEmptyState(environment: string, state: EnvironmentLeaseState): void {
    if (state.holders.size === 0 && state.waiters.length === 0) {
      this.states.delete(environment)
    }
  }

  private countModes(modes: Iterable<EnvironmentLeaseMode>): {
    shared: number
    exclusive: number
  } {
    const counts = { shared: 0, exclusive: 0 }
    for (const mode of modes) counts[mode] += 1
    return counts
  }
}
