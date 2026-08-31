import { describe, expect, it } from 'vitest'

import { mapDeleteApprovalCard, mapSwitchApprovalCard } from './specialist-approval-presentation'
import type { SpecialistPermissionCardPayload } from '../../shared/agents-contract'
import type { SpecialistView } from '../../shared/specialist'

const baseProfile = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
  id: 'sp-1',
  name: 'DATA_ANALYST',
  displayName: 'Data Analyst',
  description: 'Builds dashboards.',
  systemPrompt: 'SECRET FULL INSTRUCTIONS — never shown on a card',
  iconKey: 'chart',
  colorKey: 'violet',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 2,
  ...overrides
})

describe('mapDeleteApprovalCard — delete presentation', () => {
  it('names the specialist and states bound conversations become unavailable', () => {
    const payload = mapDeleteApprovalCard(baseProfile())
    expect(payload).toEqual<SpecialistPermissionCardPayload>({
      kind: 'delete',
      name: 'DATA_ANALYST',
      boundConversationsUnavailable: true
    })
  })

  it('never exposes the UUID or system instructions', () => {
    const payload = mapDeleteApprovalCard(baseProfile())
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('sp-1')
    expect(serialized).not.toContain('SECRET')
  })
})

describe('mapSwitchApprovalCard — switch presentation', () => {
  it('names current and target and marks next-message timing', () => {
    const payload = mapSwitchApprovalCard('Data Analyst', 'SQL Wrangler')
    expect(payload).toEqual<SpecialistPermissionCardPayload>({
      kind: 'switch',
      currentName: 'Data Analyst',
      targetName: 'SQL Wrangler',
      takesEffectAfterCurrentTool: true
    })
  })

  it('supports reverting to Main Agent (target null) and switching from Main (current null)', () => {
    expect(mapSwitchApprovalCard('Data Analyst', null)).toEqual(
      expect.objectContaining({ targetName: null, currentName: 'Data Analyst' })
    )
    expect(mapSwitchApprovalCard(null, 'SQL Wrangler')).toEqual(
      expect.objectContaining({ currentName: null, targetName: 'SQL Wrangler' })
    )
  })
})
