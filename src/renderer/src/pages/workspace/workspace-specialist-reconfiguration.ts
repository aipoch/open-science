import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type {
  CompletionHandoffLifecycleEvent,
  SpecialistListItem
} from '../../../../shared/specialist'

type WorkspaceSpecialistReconfigureError = {
  sessionId: string
  specialistName: string
  message: string
  committed: boolean
}

type IdleSpecialistFailure = {
  specialistId: string | undefined
  error: WorkspaceSpecialistReconfigureError
}

type IdleSpecialistAttempt = {
  complete: () => boolean
  recordFailure: (message: string) => boolean
}

const specialistNameFor = (
  items: readonly SpecialistListItem[],
  specialistId: string | undefined
): string => {
  if (specialistId === undefined) return 'Main Agent'
  const item = items.find(
    (candidate) => candidate.kind === 'custom' && candidate.id === specialistId
  )
  return item?.kind === 'custom' ? item.name : 'the selected specialist'
}

const pendingSpecialistReconfigureError = (
  sessionId: string,
  items: readonly SpecialistListItem[],
  specialistId: string | undefined
): WorkspaceSpecialistReconfigureError => ({
  sessionId,
  specialistName: specialistNameFor(items, specialistId),
  message: 'The selection is saved, but the Agent runtime has not applied it yet.',
  committed: true
})

const useWorkspaceSpecialistReconfiguration = (
  items: readonly SpecialistListItem[]
): {
  error: WorkspaceSpecialistReconfigureError | null
  setError: Dispatch<SetStateAction<WorkspaceSpecialistReconfigureError | null>>
  idleErrorFor: (sessionId: string | undefined) => WorkspaceSpecialistReconfigureError | null
  clearIdleRetry: (sessionId: string) => void
  beginIdleAttempt: (sessionId: string, specialistId: string | undefined) => IdleSpecialistAttempt
  retryIdle: (
    activeSessionId: string | undefined,
    retry: (specialistId: string | undefined) => void
  ) => boolean
} => {
  const [error, setError] = useState<WorkspaceSpecialistReconfigureError | null>(null)
  const [idleFailures, setIdleFailures] = useState<Record<string, IdleSpecialistFailure>>({})
  const nextIdleAttemptGeneration = useRef(0)
  const idleAttemptGenerations = useRef(new Map<string, number>())

  const idleErrorFor = (
    sessionId: string | undefined
  ): WorkspaceSpecialistReconfigureError | null =>
    sessionId ? (idleFailures[sessionId]?.error ?? null) : null
  const removeIdleFailure = useCallback((sessionId: string): void => {
    setIdleFailures((current) => {
      if (!Object.hasOwn(current, sessionId)) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [])
  const clearIdleRetry = useCallback(
    (sessionId: string): void => {
      idleAttemptGenerations.current.delete(sessionId)
      removeIdleFailure(sessionId)
    },
    [removeIdleFailure]
  )
  const beginIdleAttempt = useCallback(
    (sessionId: string, specialistId: string | undefined): IdleSpecialistAttempt => {
      const generation = ++nextIdleAttemptGeneration.current
      idleAttemptGenerations.current.set(sessionId, generation)
      removeIdleFailure(sessionId)
      return {
        complete: (): boolean => {
          if (idleAttemptGenerations.current.get(sessionId) !== generation) return false
          idleAttemptGenerations.current.delete(sessionId)
          return true
        },
        recordFailure: (message: string): boolean => {
          if (idleAttemptGenerations.current.get(sessionId) !== generation) return false
          setIdleFailures((current) => {
            if (idleAttemptGenerations.current.get(sessionId) !== generation) return current
            return {
              ...current,
              [sessionId]: {
                specialistId,
                error: {
                  sessionId,
                  specialistName: specialistNameFor(items, specialistId),
                  message,
                  committed: false
                }
              }
            }
          })
          return true
        }
      }
    },
    [items, removeIdleFailure]
  )
  const retryIdle = (
    activeSessionId: string | undefined,
    retry: (specialistId: string | undefined) => void
  ): boolean => {
    if (!activeSessionId) return false
    const failure = idleFailures[activeSessionId]
    if (!failure) return false
    retry(failure.specialistId)
    return true
  }

  return { error, setError, idleErrorFor, clearIdleRetry, beginIdleAttempt, retryIdle }
}

const compareHandoffEventOrder = (
  left: Pick<CompletionHandoffLifecycleEvent, 'commitOrder' | 'observedAt' | 'sequence' | 'id'>,
  right: Pick<CompletionHandoffLifecycleEvent, 'commitOrder' | 'observedAt' | 'sequence' | 'id'>
): number =>
  (left.commitOrder !== undefined || right.commitOrder !== undefined
    ? left.commitOrder === undefined
      ? -1
      : right.commitOrder === undefined
        ? 1
        : left.commitOrder - right.commitOrder
    : left.observedAt - right.observedAt) ||
  left.sequence - right.sequence ||
  left.id.localeCompare(right.id)

export {
  compareHandoffEventOrder,
  pendingSpecialistReconfigureError,
  specialistNameFor,
  useWorkspaceSpecialistReconfiguration
}
export type { WorkspaceSpecialistReconfigureError }
