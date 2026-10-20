import { z } from 'zod'
import type { PersistedChatSession } from './session-persistence'

export const sessionInvalidationSchema = z
  .object({
    kind: z.literal('session-invalidation'),
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    originClientId: z.string()
  })
  .strict()
export type SessionInvalidation = z.infer<typeof sessionInvalidationSchema>
type Event = { channel: string; payload: unknown }
type Pending = {
  event: Event
  bytes: number
  key?: string
  projectId?: string
  targetRevision: number
  invalidation?: SessionInvalidation
  cancelled: boolean
  onApplied?: () => void
}

// Preserve the public full-Session event facade and event ordering while resolving large updates.
export function createSessionEventHydrator(options: {
  load: (request: { projectId: string; sessionId: string }) => Promise<unknown>
  deliver: (event: Event) => void
  onFailure: () => void
}): {
  receive(event: Event, bytes: number, onApplied?: () => void): void
  whenIdle(callback: () => void): void
  dispose(): void
} {
  const queue: Pending[] = []
  const idleCallbacks = new Set<() => void>()
  let retainedBytes = 0
  let active: Pending | undefined
  let disposed = false
  const dispose = (): void => {
    disposed = true
    queue.length = 0
    idleCallbacks.clear()
    retainedBytes = 0
  }
  const fail = (): void => {
    if (!disposed) {
      dispose()
      options.onFailure()
    }
  }
  const pump = async (): Promise<void> => {
    if (active || disposed) return
    try {
      while (queue.length > 0 && !disposed) {
        const entry = queue[0]
        active = entry
        if (!entry.cancelled) {
          if (entry.invalidation) {
            let session: PersistedChatSession | undefined
            do {
              const revisionAtStart = entry.targetRevision
              session = (await options.load({
                projectId: entry.invalidation.projectId,
                sessionId: entry.invalidation.sessionId
              })) as PersistedChatSession | undefined
              if (disposed || entry.cancelled) break
              if (
                !session ||
                session.id !== entry.invalidation.sessionId ||
                session.projectId !== entry.invalidation.projectId
              )
                throw new Error('Session invalidation could not be resolved.')
              if ((session.revision ?? 0) < revisionAtStart)
                throw new Error('Session revision is unavailable.')
            } while ((session.revision ?? 0) < entry.targetRevision)
            if (!disposed && !entry.cancelled)
              options.deliver({
                channel: entry.event.channel,
                payload: { session, originClientId: entry.invalidation.originClientId }
              })
          } else options.deliver(entry.event)
        }
        if (disposed) return
        entry.onApplied?.()
        queue.shift()
        retainedBytes -= entry.bytes
        active = undefined
      }
    } catch {
      fail()
    } finally {
      active = undefined
      if (!disposed && queue.length === 0) {
        const callbacks = [...idleCallbacks]
        idleCallbacks.clear()
        for (const callback of callbacks) callback()
      }
    }
  }
  return {
    receive(event, bytes, onApplied) {
      if (disposed) return
      try {
        let invalidation: SessionInvalidation | undefined
        let key: string | undefined
        let projectId: string | undefined
        let revision = 0
        if (event.channel === 'session:updated' || event.channel === 'session:created') {
          const payload = event.payload as { kind?: string; session?: PersistedChatSession }
          if (payload?.kind === 'session-invalidation') {
            invalidation = sessionInvalidationSchema.parse(payload)
            projectId = invalidation.projectId
            key = JSON.stringify([projectId, invalidation.sessionId])
            revision = invalidation.revision
          } else if (payload?.session) {
            projectId = payload.session.projectId
            key = JSON.stringify([projectId, payload.session.id])
            revision = payload.session.revision ?? 0
          }
          if (key && active?.key === key)
            active.targetRevision = Math.max(active.targetRevision, revision)
        }
        if (event.channel === 'session:deleted' || event.channel === 'project:deleted') {
          const deleted = event.payload as { projectId: string; sessionId?: string }
          const key = JSON.stringify([deleted.projectId, deleted.sessionId])
          for (const pending of queue) {
            if (
              pending.key === key ||
              (event.channel === 'project:deleted' && pending.projectId === deleted.projectId)
            )
              pending.cancelled = true
          }
        }
        const previous = queue.at(-1)
        // Only adjacent notifications from the same authority can collapse. Distinct origins merge different fields.
        if (
          invalidation &&
          previous &&
          previous !== active &&
          previous.invalidation &&
          previous.key === key &&
          previous.event.channel === event.channel &&
          previous.invalidation.originClientId === invalidation.originClientId
        ) {
          queue.pop()
          retainedBytes -= previous.bytes
        }
        if (queue.length >= 4096 || retainedBytes + bytes > 64 * 1024 * 1024) {
          fail()
          return
        }
        queue.push({
          event,
          bytes,
          key,
          projectId,
          targetRevision: revision,
          invalidation,
          cancelled: false,
          onApplied
        })
        retainedBytes += bytes
        void pump()
      } catch {
        fail()
      }
    },
    whenIdle(callback) {
      if (disposed) return
      if (!active && queue.length === 0) callback()
      else idleCallbacks.add(callback)
    },
    dispose
  }
}
