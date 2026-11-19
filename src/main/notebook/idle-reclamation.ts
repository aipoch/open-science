import type { NotebookMemoryPolicyPort } from './execution-admission'

// An interpreter is one resource, regardless of the number of OS processes in its owned tree.
export type IdleInterpreter = {
  identity: object
  projectId: string
  sessionId: string
  group: 'data' | 'repl' | 'shell'
  // Supplied by the live owner, never inferred from a PID or a portable runtime binding.
  executionDomain?: 'host'
  lastUsedAt: number
  release: (stillIdle: () => boolean) => Promise<boolean>
}

export const NOTEBOOK_SESSION_IDLE_MS = 15 * 60_000
export const NOTEBOOK_MAX_IDLE_INTERPRETERS = { data: 3, repl: 3, shell: 3 } as const
const pressureIdleMs = 5 * 60_000
const pressurePassIntervalMs = 5000
const pressureSampleAgeMs = 10_000

type Entry = { resource: IdleInterpreter; idleSince?: number; revision: number }

/** Policy only: the existing kernel/Shell owners retain process-tree cleanup and failure fences. */
export class NotebookIdleReclamation {
  private readonly entries = new Map<object, Entry>()
  private readonly observations = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private dirty = false
  private disposed = false
  private nextPressurePassAt = 0
  private pressureActive = false

  constructor(
    private readonly options: {
      resources: () => IdleInterpreter[]
      isSessionBusy: (projectId: string, sessionId: string) => boolean | Promise<boolean>
      isSessionHeld?: (projectId: string, sessionId: string) => boolean
      memoryPolicy?: () => Promise<NotebookMemoryPolicyPort>
      onFailure: (error: unknown) => void
      onReclamation?: (
        resource: IdleInterpreter,
        reason: 'timeout' | 'capacity' | 'pressure',
        result: 'started' | 'released' | 'skipped' | 'failed'
      ) => void
    }
  ) {}

  activityChanged(sessionId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.resource.sessionId !== sessionId) continue
      entry.idleSince = undefined
      entry.revision++
    }
    this.refresh()
  }

  observeSession(sessionId: string): () => void {
    this.observations.set(sessionId, (this.observations.get(sessionId) ?? 0) + 1)
    // Invalidate an in-flight eligibility check without renewing the idle deadline.
    for (const entry of this.entries.values())
      if (entry.resource.sessionId === sessionId) entry.revision++
    return () => {
      const remaining = (this.observations.get(sessionId) ?? 1) - 1
      if (remaining) this.observations.set(sessionId, remaining)
      else this.observations.delete(sessionId)
      for (const entry of this.entries.values())
        if (entry.resource.sessionId === sessionId) entry.revision++
      this.refresh()
    }
  }

  refresh(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check()
    }, 0)
    this.timer.unref?.()
  }

  async check(): Promise<void> {
    if (this.disposed) return
    if (this.running) return this.running
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.dirty = false
    this.running = this.sweep().catch((error) => {
      // An unavailable activity source must fail closed, without polling an expired entry at 1ms.
      for (const entry of this.entries.values()) entry.idleSince = undefined
      this.options.onFailure(error)
    })
    try {
      await this.running
    } finally {
      this.running = undefined
      if (!this.disposed) {
        if (this.dirty) this.refresh()
        else if (this.entries.size) {
          // Observe external background-work settlement even without a renderer/event subscriber.
          const next = Math.min(
            30_000,
            this.pressureActive
              ? Math.max(pressurePassIntervalMs, this.nextPressurePassAt - performance.now())
              : 30_000,
            ...Array.from(this.entries.values(), (entry) =>
              entry.idleSince === undefined || this.isHeld(entry)
                ? 30_000
                : Math.max(1, entry.idleSince + NOTEBOOK_SESSION_IDLE_MS - Date.now())
            )
          )
          this.timer = setTimeout(() => {
            this.timer = undefined
            void this.check()
          }, next)
          this.timer.unref?.()
        }
      }
    }
  }

  private async sweep(): Promise<void> {
    const resources = this.options.resources()
    const live = new Set(resources.map(({ identity }) => identity))
    for (const identity of this.entries.keys())
      if (!live.has(identity)) this.entries.delete(identity)
    for (const resource of resources) {
      const entry = this.entries.get(resource.identity)
      if (entry) entry.resource = resource
      else this.entries.set(resource.identity, { resource, revision: 0 })
    }
    const activity = new Map<string, Promise<boolean>>()
    const revisions = new Map([...this.entries.values()].map((entry) => [entry, entry.revision]))
    for (const entry of this.entries.values()) {
      const { projectId, sessionId } = entry.resource
      if (this.isHeld(entry)) continue
      const key = JSON.stringify([projectId, sessionId])
      if (!activity.has(key))
        activity.set(key, Promise.resolve(this.options.isSessionBusy(projectId, sessionId)))
      const revision = revisions.get(entry)
      const busy = await activity.get(key)!
      if (this.disposed) return
      if (revision !== entry.revision || this.observations.has(sessionId)) continue
      if (busy) entry.idleSince = undefined
      else entry.idleSince ??= Date.now()
    }
    for (const group of ['data', 'repl', 'shell'] as const) {
      const idle = [...this.entries.values()]
        .filter(
          (entry) =>
            entry.resource.group === group && entry.idleSince !== undefined && !this.isHeld(entry)
        )
        .sort((a, b) => a.resource.lastUsedAt - b.resource.lastUsedAt)
      let excess = idle.length - NOTEBOOK_MAX_IDLE_INTERPRETERS[group]
      for (const entry of idle) {
        if (this.disposed) return
        const expired = Date.now() - entry.idleSince! >= NOTEBOOK_SESSION_IDLE_MS
        if (excess <= 0 && !expired) continue
        const revision = entry.revision
        const stillIdle = (): boolean =>
          !this.disposed &&
          entry.revision === revision &&
          entry.idleSince !== undefined &&
          !this.isHeld(entry)
        const reason = expired ? 'timeout' : 'capacity'
        const report = (result: 'started' | 'released' | 'skipped' | 'failed'): void =>
          this.options.onReclamation?.(entry.resource, reason, result)
        try {
          report('started')
          const busy = await this.options.isSessionBusy(
            entry.resource.projectId,
            entry.resource.sessionId
          )
          if (!stillIdle()) {
            report('skipped')
            excess--
            continue
          }
          if (busy) {
            report('skipped')
            entry.idleSince = undefined
            excess--
            continue
          }
          if (await entry.resource.release(stillIdle)) {
            this.entries.delete(entry.resource.identity)
            excess--
            report('released')
          } else {
            if (entry.revision === revision) entry.idleSince = undefined
            report('skipped')
          }
        } catch (error) {
          // Avoid a tight retry loop; cleanup ownership and admission fences remain with the owner.
          entry.idleSince = undefined
          report('failed')
          this.options.onFailure(error)
        }
      }
    }
    await this.reclaimUnderPressure()
  }

  private async reclaimUnderPressure(): Promise<void> {
    if (!this.options.memoryPolicy || performance.now() < this.nextPressurePassAt) return
    const candidates = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.resource.executionDomain === 'host' &&
          entry.idleSince !== undefined &&
          Date.now() - entry.idleSince >= pressureIdleMs &&
          !this.isHeld(entry)
      )
      .sort((a, b) => a.resource.lastUsedAt - b.resource.lastUsedAt)
      .slice(0, 8)
    if (!candidates.length) return
    let retryDelay = pressurePassIntervalMs
    try {
      const policy = await this.options.memoryPolicy()
      const isPressured = (): boolean => {
        const current = policy.currentState({ maxAgeMs: pressureSampleAgeMs })
        this.pressureActive =
          current.status === 'pressured' && current.reason.pressureScope === 'host'
        return this.pressureActive
      }
      await policy.getState({ maxAgeMs: pressureSampleAgeMs })
      for (const entry of candidates) {
        if (this.disposed || !isPressured()) return
        const revision = entry.revision
        const stillIdle = (): boolean =>
          !this.disposed &&
          isPressured() &&
          entry.revision === revision &&
          entry.idleSince !== undefined &&
          !this.isHeld(entry)
        const report = (result: 'started' | 'released' | 'skipped' | 'failed'): void =>
          this.options.onReclamation?.(entry.resource, 'pressure', result)
        try {
          report('started')
          const busy = await this.options.isSessionBusy(
            entry.resource.projectId,
            entry.resource.sessionId
          )
          if (busy) entry.idleSince = undefined
          if (!busy && stillIdle()) {
            if (await entry.resource.release(stillIdle)) {
              this.entries.delete(entry.resource.identity)
              report('released')
            } else {
              if (entry.revision === revision) entry.idleSince = undefined
              report('skipped')
            }
          } else report('skipped')
        } catch (error) {
          entry.idleSince = undefined
          report('failed')
          this.options.onFailure(error)
        }
        if (!this.disposed) await policy.getState({ force: true, maxAgeMs: pressureSampleAgeMs })
      }
    } catch (error) {
      // A broken sampler only disables pressure reclamation; ordinary idle time must not renew.
      this.pressureActive = false
      retryDelay = 30_000
      this.options.onFailure(error)
    } finally {
      this.nextPressurePassAt = performance.now() + retryDelay
    }
  }

  private isHeld(entry: Entry): boolean {
    return (
      this.observations.has(entry.resource.sessionId) ||
      this.options.isSessionHeld?.(entry.resource.projectId, entry.resource.sessionId) === true
    )
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    await this.running
    this.entries.clear()
    this.observations.clear()
  }
}
