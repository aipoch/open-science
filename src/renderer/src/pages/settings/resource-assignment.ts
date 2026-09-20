import type { SpecialistListItem, UpdateSpecialistInput } from '../../../../shared/specialist'

export type AssignableResource = {
  id: string
  name: string
  displayName?: string
  kind: 'skill' | 'connector'
  group: string
  mainEnabled: boolean
  mainRequired?: boolean
  deletable?: boolean
}
export type ResourceSpecialist = Exclude<SpecialistListItem, { kind: 'reviewer' }>

export const canEditResourceAssignments = (item: ResourceSpecialist): boolean =>
  item.kind === 'custom' && item.origin !== 'marketplace'

const matchesResource = (id: string, resource: AssignableResource): boolean =>
  id === resource.id || (resource.kind === 'connector' && id === resource.name)

export const isResourceAssigned = (
  item: ResourceSpecialist,
  resource: AssignableResource
): boolean => {
  const full = item.capabilityMode === 'full'
  const ids =
    resource.kind === 'skill'
      ? full
        ? item.fullAccess.excludedSkillIds
        : item.selectedCapabilities.skillIds
      : full
        ? item.fullAccess.excludedConnectorIds
        : item.selectedCapabilities.connectorIds
  const matches = ids.some((id) => matchesResource(id, resource))
  return full ? !matches : matches
}

// Patch only the active policy. Preserve the other mode, tool restrictions and profile enablement.
export const assignmentUpdate = (
  item: ResourceSpecialist,
  resources: readonly AssignableResource[],
  enabled: boolean
): UpdateSpecialistInput | undefined => {
  if (!canEditResourceAssignments(item)) return undefined
  const changed = resources.filter((resource) => isResourceAssigned(item, resource) !== enabled)
  if (changed.length === 0) return undefined
  const full = item.capabilityMode === 'full'
  const updateIds = (ids: string[], kind: AssignableResource['kind']): string[] => {
    const targets = changed.filter((resource) => resource.kind === kind)
    const next = ids.filter((id) => !targets.some((resource) => matchesResource(id, resource)))
    if (enabled !== full) next.push(...targets.map((resource) => resource.id))
    return [...new Set(next)]
  }
  return {
    id: item.id,
    revision: item.revision,
    ...(full
      ? {
          fullAccess: {
            ...item.fullAccess,
            excludedSkillIds: updateIds(item.fullAccess.excludedSkillIds, 'skill'),
            excludedConnectorIds: updateIds(item.fullAccess.excludedConnectorIds, 'connector')
          }
        }
      : {
          selectedCapabilities: {
            ...item.selectedCapabilities,
            skillIds: updateIds(item.selectedCapabilities.skillIds, 'skill'),
            connectorIds: updateIds(item.selectedCapabilities.connectorIds, 'connector')
          }
        })
  }
}

export const bulkResourceActions = (
  resources: readonly AssignableResource[],
  items: readonly SpecialistListItem[]
): {
  stopMain: AssignableResource[]
  unlink: AssignableResource[]
  deletable: AssignableResource[]
} => {
  const profiles = items.filter((item): item is ResourceSpecialist => item.kind !== 'reviewer')
  return {
    stopMain: resources.filter((resource) => resource.mainEnabled && !resource.mainRequired),
    unlink: resources.filter((resource) =>
      profiles.some(
        (item) => canEditResourceAssignments(item) && isResourceAssigned(item, resource)
      )
    ),
    deletable: resources.filter(
      (resource) =>
        resource.deletable &&
        resource.group !== 'featured' &&
        !profiles.some(
          (item) =>
            isResourceAssigned(item, resource) ||
            (resource.kind === 'skill' && item.ownedSkillIds?.includes(resource.id))
        )
    )
  }
}
