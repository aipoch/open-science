import { useSessionStore } from '@/stores/session-store'
import type { PersistedChatSession } from '../../../../../shared/session-persistence'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
  ScheduleHistoryRequest,
  ScheduleRun,
  ScheduleSummary,
  ScheduleView
} from '../../../../../shared/session-schedules'

type Snapshot = { tasks: ScheduleSummary[]; loaded: boolean; error: string }
const empty: Snapshot = { tasks: [], loaded: false, error: '' }
type ScheduleApi = Window['api']['schedules']
type Source = {
  getSnapshot: () => Snapshot
  refresh: () => Promise<boolean>
  subscribe: (listener: () => void) => () => void
}

function createSource(api: ScheduleApi, projectId: string): Source {
  let snapshot = empty
  const listeners = new Set<() => void>()
  let stop: (() => void) | undefined
  let refresh = (): Promise<boolean> => Promise.resolve(false)
  let completion: ReturnType<typeof Promise.withResolvers<boolean>> | undefined
  return {
    getSnapshot: () => snapshot,
    refresh: () => refresh(),
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (!stop) {
        let active = true,
          queued = false,
          reading = false,
          dirty = false
        const read = async (): Promise<void> => {
          queued = false
          if (!active) return
          reading = true
          dirty = false
          try {
            const tasks = await api.list({ projectId })
            if (active && !dirty) snapshot = { tasks, loaded: true, error: '' }
          } catch (error) {
            if (active && !dirty) snapshot = { ...snapshot, error: String(error) }
          } finally {
            reading = false
            if (active) {
              if (!dirty) {
                const settled = completion
                completion = undefined
                settled?.resolve(snapshot.loaded && !snapshot.error)
              }
              for (const notify of listeners) notify()
              if (dirty) void refresh()
            }
          }
        }
        refresh = () => {
          if (!active) return Promise.resolve(false)
          completion ??= Promise.withResolvers<boolean>()
          dirty = true
          if (!reading && !queued) {
            queued = true
            queueMicrotask(() => void read())
          }
          return completion.promise
        }
        const unsubscribe = api.onChanged?.((event) => {
          if (event.projectId === projectId) refresh()
        })
        stop = () => {
          active = false
          unsubscribe?.()
          snapshot = empty
          completion?.resolve(false)
          completion = undefined
        }
        refresh()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size)
          queueMicrotask(() => {
            if (!listeners.size) {
              stop?.()
              stop = undefined
            }
          })
      }
    }
  }
}

// One project directory serves the sidebar and all conversation cards in this renderer.
const sources = new WeakMap<ScheduleApi, Map<string, Source>>()
const idle = {
  getSnapshot: () => empty,
  subscribe: () => () => {},
  refresh: () => Promise.resolve(false)
}
function sourceFor(api: ScheduleApi | undefined, projectId?: string): Source {
  if (!api || !projectId) return idle
  let projects = sources.get(api)
  if (!projects) sources.set(api, (projects = new Map()))
  let source = projects.get(projectId)
  if (!source) projects.set(projectId, (source = createSource(api, projectId)))
  return source
}

export function useSchedules(
  projectId?: string,
  sessionId?: string
): {
  tasks: ScheduleSummary[]
  loaded: boolean
  isEmpty: boolean
  error: string
  refresh: () => Promise<boolean>
} {
  const source = sourceFor(window.api?.schedules, projectId)
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const tasks = useMemo(
    () =>
      sessionId
        ? snapshot.tasks.filter((task) => task.target.sessionId === sessionId)
        : snapshot.tasks,
    [snapshot.tasks, sessionId]
  )
  return {
    tasks,
    loaded: snapshot.loaded && !snapshot.error,
    isEmpty: snapshot.loaded && !snapshot.error && tasks.length === 0,
    error: snapshot.error,
    refresh: source.refresh
  }
}

export function subscribeScheduleHistory(
  scope: ScheduleHistoryRequest,
  onRows: (rows: ScheduleRun[]) => void,
  onError: (error: unknown) => void
): () => void {
  const api = window.api.schedules
  let active = true,
    reading = false,
    queued = false,
    dirty = false
  const read = async (): Promise<void> => {
    queued = false
    if (!active) return
    reading = true
    dirty = false
    try {
      const rows = await api.history(scope)
      if (active && !dirty) onRows(rows)
    } catch (error) {
      if (active && !dirty) onError(error)
    } finally {
      reading = false
      if (active && dirty) refresh()
    }
  }
  const refresh = (): void => {
    if (!active) return
    dirty = true
    if (reading || queued) return
    queued = true
    queueMicrotask(() => void read())
  }
  const unsubscribe = api.onChanged((event) => {
    if (event.projectId === scope.projectId && event.sessionId === scope.sessionId) refresh()
  })
  refresh()
  return () => {
    active = false
    unsubscribe()
  }
}

// Only open editors and detail panels read the saved instructions.
export function useScheduleDetail(task: ScheduleSummary | null): {
  detail: ScheduleView | undefined
  error: unknown
  refresh: () => void
} {
  const [loaded, setLoaded] = useState<{ key: string; detail: ScheduleView }>()
  const [failure, setFailure] = useState<{ key: string; error: unknown }>()
  const [retry, setRetry] = useState(0)
  const projectId = task?.target.projectId
  const sessionId = task?.target.sessionId
  const id = task?.id
  const revision = task?.revision
  const key = JSON.stringify([projectId, sessionId, id])
  const requestKey = JSON.stringify([key, revision, retry])
  const complete =
    task && ('message' in task.draft.action || 'code' in task.draft.action)
      ? (task as ScheduleView)
      : undefined
  useEffect(() => {
    if (complete || !projectId || !id || sessionId === undefined) return
    let active = true
    void window.api.schedules
      .get({ projectId, sessionId, scheduleId: id })
      .then((detail) => {
        if (!active) return
        if (!detail) throw new Error('Schedule not found')
        setLoaded({ key, detail })
        setFailure(undefined)
      })
      .catch((error: unknown) => {
        if (active) setFailure({ key: requestKey, error })
      })
    return () => {
      active = false
    }
  }, [complete, projectId, sessionId, id, revision, key, retry, requestKey])
  return {
    detail: complete ?? (loaded?.key === key ? loaded.detail : undefined),
    error: !complete && failure?.key === requestKey ? failure.error : undefined,
    refresh: () => setRetry((v) => v + 1)
  }
}

// Status and result previews share a read only for the lifetime of their consumers.
const runSessionReads = new WeakMap<
  Window['api']['sessions'],
  Map<
    string,
    {
      readers: number
      promise: Promise<PersistedChatSession | undefined>
    }
  >
>()
export function useScheduleRunSession(
  projectId: string,
  run?: ScheduleRun
): PersistedChatSession | undefined {
  const live = useSessionStore((state) =>
    state.sessions.find(
      (session) => session.projectId === projectId && session.id === run?.runSessionId
    )
  )
  const complete = live?.conversationGraph && live.contentLoaded !== false ? live : undefined
  const sessionId = run?.runSessionId
  const key = JSON.stringify([
    projectId,
    sessionId,
    run?.scheduledAt,
    run?.status,
    live?.revision,
    live?.status,
    live?.activeRun?.promptMessageId
  ])
  const [snapshot, setSnapshot] = useState<{
    key: string
    session: PersistedChatSession | undefined
  }>()
  useEffect(() => {
    if (!sessionId || complete) return
    const api = window.api.sessions
    let reads = runSessionReads.get(api)
    if (!reads) runSessionReads.set(api, (reads = new Map()))
    let read = reads.get(key)
    if (!read) {
      read = { readers: 0, promise: api.loadOne({ projectId, sessionId }).catch(() => undefined) }
      reads.set(key, read)
    }
    read.readers++
    let active = true
    void read.promise.then((session) => {
      if (active) setSnapshot({ key, session })
    })
    return () => {
      active = false
      if (--read.readers === 0) reads.delete(key)
    }
  }, [projectId, sessionId, key, complete])
  return complete ?? (snapshot?.key === key ? snapshot.session : undefined)
}
