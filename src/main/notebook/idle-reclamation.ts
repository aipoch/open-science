// An interpreter is one resource, regardless of the number of OS processes in its owned tree.
export type IdleInterpreter = {
  identity: object
  projectId: string
  sessionId: string
  group: 'data' | 'repl' | 'shell'
  lastUsedAt: number
  release: (stillIdle: () => boolean) => Promise<boolean>
}

export const NOTEBOOK_SESSION_IDLE_MS = 15 * 60_000
export const NOTEBOOK_MAX_IDLE_INTERPRETERS = { data: 3, repl: 3, shell: 3 } as const

type Entry = { resource: IdleInterpreter; idleSince?: number; revision: number }

/** Policy only: the existing kernel/Shell owners retain process-tree cleanup and failure fences. */
export class NotebookIdleReclamation {
  private readonly entries = new Map<object, Entry>()
  private readonly observations = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private dirty = false
  private disposed = false

  constructor(
    private readonly options: {
      resources: () => IdleInterpreter[]
      isSessionBusy: (projectId: string, sessionId: string) => boolean | Promise<boolean>
      onFailure: (error: unknown) => void
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
            ...Array.from(this.entries.values(), ({ idleSince, resource }) =>
              idleSince === undefined || this.observations.has(resource.sessionId)
                ? 30_000
                : Math.max(1, idleSince + NOTEBOOK_SESSION_IDLE_MS - Date.now())
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
      if (this.observations.has(sessionId)) continue
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
            entry.resource.group === group &&
            entry.idleSince !== undefined &&
            !this.observations.has(entry.resource.sessionId)
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
          !this.observations.has(entry.resource.sessionId)
        try {
          const busy = await this.options.isSessionBusy(
            entry.resource.projectId,
            entry.resource.sessionId
          )
          if (!stillIdle()) {
            excess--
            continue
          }
          if (busy) {
            entry.idleSince = undefined
            excess--
            continue
          }
          if (await entry.resource.release(stillIdle)) {
            this.entries.delete(entry.resource.identity)
            excess--
          } else if (entry.revision === revision) entry.idleSince = undefined
        } catch (error) {
          // Avoid a tight retry loop; cleanup ownership and admission fences remain with the owner.
          entry.idleSince = undefined
          this.options.onFailure(error)
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    await this.running
    this.entries.clear()
    this.observations.clear()
  }
}
