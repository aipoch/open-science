import { useSpecialistStore } from '@/stores/specialist-store'
import {
  assignmentUpdate,
  canEditResourceAssignments,
  type AssignableResource
} from './resource-assignment'

// Read a fresh revision before each edit; optimistic concurrency still rejects a racing writer.
export const setResourceAssignments = async (
  resources: readonly AssignableResource[],
  enabled: boolean,
  specialistId?: string
): Promise<void> => {
  await useSpecialistStore.getState().load({ force: true })
  const state = useSpecialistStore.getState()
  if (state.integrity.status !== 'ok' || state.loadError)
    throw new Error('Specialist catalog unavailable')
  if (
    specialistId &&
    !state.items.some(
      (item) =>
        item.kind !== 'reviewer' && canEditResourceAssignments(item) && item.id === specialistId
    )
  ) {
    throw new Error('Specialist unavailable')
  }
  const failures: unknown[] = []
  for (const item of state.items) {
    if (
      item.kind === 'reviewer' ||
      !canEditResourceAssignments(item) ||
      (specialistId && item.id !== specialistId)
    )
      continue
    const input = assignmentUpdate(item, resources, enabled)
    if (!input) continue
    try {
      await useSpecialistStore.getState().update(input)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new Error('Some resource assignments could not be saved')
}
