import { useRef, useState, type Dispatch, type SetStateAction } from 'react'

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

type IdleSpecialistRetryTarget = {
  sessionId: string
  specialistId: string | undefined
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
  clearIdleRetry: (sessionId: string) => void
  recordIdleFailure: (sessionId: string, specialistId: string | undefined, message: string) => void
  retryIdle: (
    activeSessionId: string | undefined,
    retry: (specialistId: string | undefined) => void
  ) => boolean
} => {
  const [error, setError] = useState<WorkspaceSpecialistReconfigureError | null>(null)
  const idleRetryTarget = useRef<IdleSpecialistRetryTarget | null>(null)

  const clearIdleRetry = (sessionId: string): void => {
    if (idleRetryTarget.current?.sessionId === sessionId) idleRetryTarget.current = null
  }
  const recordIdleFailure = (
    sessionId: string,
    specialistId: string | undefined,
    message: string
  ): void => {
    idleRetryTarget.current = { sessionId, specialistId }
    setError({
      sessionId,
      specialistName: specialistNameFor(items, specialistId),
      message,
      committed: false
    })
  }
  const retryIdle = (
    activeSessionId: string | undefined,
    retry: (specialistId: string | undefined) => void
  ): boolean => {
    const target = idleRetryTarget.current
    if (!activeSessionId || target?.sessionId !== activeSessionId) return false
    retry(target.specialistId)
    return true
  }

  return { error, setError, clearIdleRetry, recordIdleFailure, retryIdle }
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
