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

export { compareHandoffEventOrder, pendingSpecialistReconfigureError, specialistNameFor }
export type { WorkspaceSpecialistReconfigureError }
