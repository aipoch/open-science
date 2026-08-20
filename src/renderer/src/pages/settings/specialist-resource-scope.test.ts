import { describe, expect, it } from 'vitest'

import type { SpecialistListItem } from '../../../../shared/specialist'
import {
  resourceScope,
  specialistsUsingConnector,
  specialistsUsingSkill
} from './specialist-resource-scope'

const items: SpecialistListItem[] = [
  {
    kind: 'custom',
    id: 'selected',
    name: 'SELECTED',
    displayName: 'Selected Specialist',
    description: '',
    systemPrompt: '',
    enabled: false,
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: {
      skillIds: ['analysis'],
      connectorIds: ['custom-id'],
      connectorTools: []
    },
    revision: 1
  },
  {
    kind: 'custom',
    id: 'full',
    name: 'FULL',
    displayName: 'Full Specialist',
    description: '',
    systemPrompt: '',
    enabled: true,
    capabilityMode: 'full',
    fullAccess: {
      excludedSkillIds: ['excluded'],
      excludedConnectorIds: ['blocked'],
      connectorTools: []
    },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1
  },
  { kind: 'reviewer', id: 'reviewer' }
]

describe('Specialist resource scope', () => {
  it('derives durable Skill and Connector memberships from selected and full-access profiles', () => {
    expect(specialistsUsingSkill(items, 'analysis').map((item) => item.id)).toEqual([
      'full',
      'selected'
    ])
    expect(specialistsUsingSkill(items, 'excluded').map((item) => item.id)).toEqual([])
    expect(
      specialistsUsingConnector(items, { id: 'custom-id', name: 'custom-name' }).map(
        (item) => item.id
      )
    ).toEqual(['full', 'selected'])
    expect(
      specialistsUsingConnector(items, { id: 'blocked', name: 'blocked' }).map((item) => item.id)
    ).toEqual([])
  })

  it('keeps Main availability independent from Specialist membership', () => {
    const used = [{ id: 'selected', name: 'Selected Specialist', kind: 'custom' as const }]
    expect(resourceScope(true, [])).toBe('main-only')
    expect(resourceScope(false, used)).toBe('specialist-only')
    expect(resourceScope(true, used)).toBe('shared')
    expect(resourceScope(false, [])).toBe('not-in-use')
  })
})
