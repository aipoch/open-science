import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

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
  recordIdleFailure: (sessionId: string, specialistId: string | undefined, message: string) => void
  retryIdle: (
    activeSessionId: string | undefined,
    retry: (specialistId: string | undefined) => void
  ) => boolean
} => {
  const [error, setError] = useState<WorkspaceSpecialistReconfigureError | null>(null)
  const [idleFailures, setIdleFailures] = useState<Record<string, IdleSpecialistFailure>>({})

  const idleErrorFor = (
    sessionId: string | undefined
  ): WorkspaceSpecialistReconfigureError | null =>
    sessionId ? (idleFailures[sessionId]?.error ?? null) : null
  const clearIdleRetry = useCallback((sessionId: string): void => {
    setIdleFailures((current) => {
      if (!Object.hasOwn(current, sessionId)) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [])
  const recordIdleFailure = (
    sessionId: string,
    specialistId: string | undefined,
    message: string
  ): void => {
    const failure = {
      specialistId,
      error: {
        sessionId,
        specialistName: specialistNameFor(items, specialistId),
        message,
        committed: false
      }
    }
    setIdleFailures((current) => ({
      ...current,
      [sessionId]: failure
    }))
  }
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

  return { error, setError, idleErrorFor, clearIdleRetry, recordIdleFailure, retryIdle }
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
