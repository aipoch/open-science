import type { SpecialistListItem } from '../../../../shared/specialist'

export type ResourceScope = 'main-only' | 'specialist-only' | 'shared' | 'not-in-use'

export type SpecialistUsage = {
  id: string
  name: string
  kind: 'custom' | 'builtin'
  iconKey?: string
  colorKey?: string
}

const profiles = (
  items: readonly SpecialistListItem[]
): Array<Exclude<SpecialistListItem, { kind: 'reviewer' }>> =>
  items.filter(
    (item): item is Exclude<SpecialistListItem, { kind: 'reviewer' }> => item.kind !== 'reviewer'
  )

const usage = (
  items: readonly SpecialistListItem[],
  uses: (item: Exclude<SpecialistListItem, { kind: 'reviewer' }>) => boolean
): SpecialistUsage[] =>
  profiles(items)
    .filter(uses)
    .map((item) => ({
      id: item.id,
      name: item.displayName?.trim() || item.name,
      kind: item.kind,
      ...(item.iconKey ? { iconKey: item.iconKey } : {}),
      ...(item.colorKey ? { colorKey: item.colorKey } : {})
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

export const specialistsUsingSkill = (
  items: readonly SpecialistListItem[],
  skillId: string
): SpecialistUsage[] =>
  usage(items, (item) =>
    item.capabilityMode === 'full'
      ? !item.fullAccess.excludedSkillIds.includes(skillId)
      : item.selectedCapabilities.skillIds.includes(skillId)
  )

export const specialistsOwningSkill = (
  items: readonly SpecialistListItem[],
  skillId: string
): SpecialistUsage[] => usage(items, (item) => item.ownedSkillIds?.includes(skillId) ?? false)

export const specialistsUsingConnector = (
  items: readonly SpecialistListItem[],
  connector: { id: string; name: string }
): SpecialistUsage[] => {
  const matches = (id: string): boolean => id === connector.id || id === connector.name
  return usage(items, (item) => {
    const ids =
      item.capabilityMode === 'full'
        ? item.fullAccess.excludedConnectorIds
        : item.selectedCapabilities.connectorIds
    return item.capabilityMode === 'full' ? !ids.some(matches) : ids.some(matches)
  })
}

export const resourceScope = (
  mainEnabled: boolean,
  specialistUsages: readonly SpecialistUsage[]
): ResourceScope => {
  if (mainEnabled) return specialistUsages.length > 0 ? 'shared' : 'main-only'
  return specialistUsages.length > 0 ? 'specialist-only' : 'not-in-use'
}
