import { ImageComposerBridgeProvider } from './image-composer-bridge'
import { useImageModelSettingsStore } from '@/stores/image-model-settings-store'
import { isDesktopRuntimeConnectionError } from '../../../../../shared/desktop-runtime-recovery'
import {
  imageTaskIsActive,
  type ImageTask,
  type ImageTaskList,
  type ImageTaskStart,
  type ImageTaskStartResult,
  type ImageTaskIdentity
} from '../../../../../shared/image-task'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useSessionStore } from '@/stores/session-store'
import {
  IMAGE_EDITOR_DRAFT_LIMIT,
  reusableImageDraftKey,
  type ImageEditorDraft
} from './image-editor-state'
import { ImageEditingContext } from './image-edit-context'

const taskKey = ({ projectId, sessionId, id }: ImageTaskIdentity): string =>
  JSON.stringify([projectId, sessionId, id])

function mergeTasks(
  previous: readonly ImageTask[],
  incoming: readonly ImageTask[]
): readonly ImageTask[] {
  const tasks = new Map(previous.map((task) => [taskKey(task), task]))
  for (const task of incoming) {
    if (
      !useSessionStore
        .getState()
        .sessions.some(
          (session) => session.id === task.sessionId && session.projectId === task.projectId
        )
    )
      continue
    const current = tasks.get(taskKey(task))
    // List/start responses may arrive after a newer poll or a terminal result.
    if (
      current &&
      ((current.updatedAt === task.updatedAt && current.state === task.state) ||
        current.updatedAt > task.updatedAt ||
        (!imageTaskIsActive(current) && imageTaskIsActive(task)) ||
        (current.state === 'running' && task.state === 'queued'))
    )
      continue
    tasks.set(taskKey(task), task)
  }
  const entries = [...tasks.values()]
  const recentScopes = new Set(
    [...incoming, ...entries.slice().sort((a, b) => b.updatedAt - a.updatedAt)]
      .map(({ projectId, sessionId }) => JSON.stringify([projectId, sessionId]))
      .filter((key, index, keys) => keys.indexOf(key) === index)
      .slice(0, 8)
  )
  const counts = new Map<string, number>()
  const next = entries
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((task) => {
      if (imageTaskIsActive(task)) return true
      const scope = JSON.stringify([task.projectId, task.sessionId])
      const count = counts.get(scope) ?? 0
      counts.set(scope, count + 1)
      return recentScopes.has(scope) && count < 256
    })
  return next.length === previous.length && next.every((task, index) => task === previous[index])
    ? previous
    : next
}

// One workspace owner survives switching between panel and modal; unsent drafts stay in memory.
export function ImageEditingProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [tasks, setTasks] = useState<readonly ImageTask[]>([])
  const [observationErrors, setObservationErrors] = useState<ReadonlySet<string>>(new Set())
  const [observationFailures, setObservationFailures] = useState<ReadonlySet<string>>(new Set())
  const failedObservations = useRef(new Set<string>())
  const observations = useRef(new Map<string, Promise<ImageTask | undefined>>())
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [])
  const observation = useCallback((id: string, failed: boolean): void => {
    setObservationErrors((previous) => {
      if (previous.has(id) === failed) return previous
      const next = new Set(previous)
      if (failed) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const [drafts, setDrafts] = useState<ReadonlyMap<string, ImageEditorDraft>>(new Map())
  useEffect(
    () =>
      useSessionStore.subscribe((next, previous) => {
        if (next.sessions === previous.sessions) return
        setTasks((current) =>
          current.filter((task) =>
            next.sessions.some(
              (session) => session.id === task.sessionId && session.projectId === task.projectId
            )
          )
        )
        setDrafts((current) => {
          const retained = new Map(current)
          for (const [key, draft] of current) {
            const before = previous.sessions.find(({ id }) => id === draft.owner.sessionId)
            const after = next.sessions.find(({ id }) => id === draft.owner.sessionId)
            // Content unloading and active-branch switches retain drafts. Only removed owners
            // or a loaded graph that has actually lost the branch release their memory.
            const removedSession = before && !after
            const removedBranch =
              after?.contentLoaded !== false &&
              before?.conversationGraph &&
              after?.conversationGraph &&
              draft.owner.branchId &&
              before.conversationGraph.branches.some(({ id }) => id === draft.owner.branchId) &&
              !after.conversationGraph.branches.some(({ id }) => id === draft.owner.branchId)
            if (removedSession || removedBranch) retained.delete(key)
          }
          return retained.size === current.size ? current : retained
        })
      }),
    []
  )
  const settings = useImageModelSettingsStore((state) => state.snapshot)
  const settingsError = useImageModelSettingsStore((state) => state.loadFailed)
  const reloadSettings = useImageModelSettingsStore((state) => state.reload)
  const update = useCallback(
    (
      key: string,
      change: (draft: ImageEditorDraft | undefined) => ImageEditorDraft | undefined
    ): void => {
      setDrafts((current) => {
        const next = new Map(current)
        const value = change(current.get(key))
        if (value) {
          if (!current.has(key) && current.size >= IMAGE_EDITOR_DRAFT_LIMIT) {
            const reusable = reusableImageDraftKey(current)
            if (reusable === undefined) return current
            next.delete(reusable)
          }
          next.set(key, value)
        } else next.delete(key)
        return next
      })
    },
    []
  )
  const reloadTasks = useCallback(async (request: ImageTaskList): Promise<ImageTask[]> => {
    const next = await window.api.imageTasks.list(request)
    setTasks((previous) => mergeTasks(previous, next))
    return next
  }, [])
  const checkTask = useCallback(
    (scope: ImageTaskIdentity): Promise<ImageTask | undefined> => {
      const key = taskKey(scope)
      const pending = observations.current.get(key)
      if (pending) return pending
      const signal = lifetime.current.signal
      const run = async (): Promise<ImageTask | undefined> => {
        failedObservations.current.delete(scope.id)
        setObservationFailures((previous) =>
          previous.has(scope.id) ? new Set([...previous].filter((id) => id !== scope.id)) : previous
        )
        for (let attempt = 0; ; attempt++) {
          signal.throwIfAborted()
          if (
            !useSessionStore
              .getState()
              .sessions.some(
                (session) => session.id === scope.sessionId && session.projectId === scope.projectId
              )
          )
            return undefined
          try {
            const next = await window.api.imageTasks.get(scope)
            signal.throwIfAborted()
            observation(scope.id, false)
            setTasks((previous) =>
              next ? mergeTasks(previous, [next]) : previous.filter((task) => taskKey(task) !== key)
            )
            return next
          } catch (error) {
            if (signal.aborted) throw error
            // Retry transport failures only; business/storage errors need an explicit status check.
            if (
              attempt >= 4 ||
              !(isDesktopRuntimeConnectionError(error) || error instanceof TypeError)
            ) {
              observation(scope.id, false)
              failedObservations.current.add(scope.id)
              setObservationFailures((previous) => new Set([...previous, scope.id]))
              throw error
            }
            observation(scope.id, true)
            await new Promise<void>((resolve) => {
              const finish = (): void => {
                clearTimeout(timer)
                signal.removeEventListener('abort', finish)
                resolve()
              }
              const timer = setTimeout(finish, Math.min(1000 * 2 ** attempt, 10000))
              signal.addEventListener('abort', finish, { once: true })
            })
          }
        }
      }
      const result = run().finally(() => observations.current.delete(key))
      observations.current.set(key, result)
      return result
    },
    [observation]
  )
  const startTask = useCallback(
    async (request: ImageTaskStart): Promise<ImageTaskStartResult> => {
      let task: ImageTaskStartResult
      try {
        task = await window.api.imageTasks.start(request)
      } catch (error) {
        // Never resubmit on a lost response. The same observer checks the original identity.
        const admitted = await checkTask({
          projectId: request.projectId,
          sessionId: request.sessionId,
          id: request.id
        })
        if (!admitted) throw error
        return admitted
      }
      if ('state' in task) setTasks((previous) => mergeTasks(previous, [task]))
      return task
    },
    [checkTask]
  )
  const cancelTask = useCallback(
    async (scope: ImageTaskIdentity): Promise<void> => {
      await window.api.imageTasks.cancel(scope)
      void checkTask(scope).catch(() => undefined)
    },
    [checkTask]
  )
  const tasksRef = useRef(tasks)
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])
  const hasActiveTasks = tasks.some(
    (task) => imageTaskIsActive(task) && !observationFailures.has(task.id)
  )
  useEffect(() => {
    if (!hasActiveTasks) return
    const timer = setInterval(() => {
      for (const task of tasksRef.current) {
        if (observations.current.size >= 4) break
        if (
          !imageTaskIsActive(task) ||
          failedObservations.current.has(task.id) ||
          observations.current.has(taskKey(task))
        )
          continue
        void checkTask({ projectId: task.projectId, sessionId: task.sessionId, id: task.id }).catch(
          () => {}
        )
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [hasActiveTasks, checkTask, observationFailures])
  const value = useMemo(
    () => ({
      drafts,
      update,
      settings,
      settingsError,
      reloadSettings,
      tasks,
      observationErrors,
      observationFailures,
      checkTask,
      reloadTasks,
      startTask,
      cancelTask
    }),
    [
      drafts,
      update,
      settings,
      settingsError,
      reloadSettings,
      tasks,
      observationErrors,
      observationFailures,
      checkTask,
      reloadTasks,
      startTask,
      cancelTask
    ]
  )
  return (
    <ImageEditingContext.Provider value={value}>
      <ImageComposerBridgeProvider>{children}</ImageComposerBridgeProvider>
    </ImageEditingContext.Provider>
  )
}
