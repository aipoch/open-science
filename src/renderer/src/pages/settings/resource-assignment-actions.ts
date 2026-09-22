import type { SpecialistListItem } from '../../../../shared/specialist'
import { useSpecialistStore } from '@/stores/specialist-store'
import {
  assignmentUpdate,
  canEditResourceAssignments,
  type AssignableResource
} from './resource-assignment'

// Consume this request's snapshot: a concurrent catalog refresh may supersede the store update.
export const readResourceSpecialists = async (): Promise<SpecialistListItem[]> => {
  const snapshot = await window.api.specialist.list()
  if (snapshot.integrity.status !== 'ok') throw new Error('Specialist catalog unavailable')
  return snapshot.items
}

// Read a fresh revision before each edit; optimistic concurrency still rejects a racing writer.
export const setResourceAssignments = async (
  resources: readonly AssignableResource[],
  enabled: boolean,
  specialistId?: string
): Promise<void> => {
  const items = await readResourceSpecialists()
  if (
    specialistId &&
    !items.some(
      (item) =>
        item.kind !== 'reviewer' && canEditResourceAssignments(item) && item.id === specialistId
    )
  ) {
    throw new Error('Specialist unavailable')
  }
  const failures: unknown[] = []
  for (const item of items) {
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
