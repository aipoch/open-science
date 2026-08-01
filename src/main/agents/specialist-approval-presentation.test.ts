import { describe, expect, it } from 'vitest'

import {
  mapDeleteApprovalCard,
  mapSwitchApprovalCard,
  mapUpdateApprovalCard
} from './specialist-approval-presentation'
import type { SpecialistPermissionCardPayload } from '../../shared/agents-contract'
import type { SpecialistProfileView } from '../../shared/specialist'

const baseProfile = (overrides: Partial<SpecialistProfileView> = {}): SpecialistProfileView => ({
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

describe('mapUpdateApprovalCard — name-changing update presentation', () => {
  it('shows old name -> new name and marks bindings stable', () => {
    const current = baseProfile()
    const payload = mapUpdateApprovalCard(current, { name: 'DATA_SCIENTIST' })
    expect(payload).toEqual<SpecialistPermissionCardPayload>({
      kind: 'update',
      name: 'DATA_ANALYST',
      newName: 'DATA_SCIENTIST',
      changes: [],
      bindingsStable: true
    })
  })

  it('lists each other changed field as a compact manifest entry, never full text', () => {
    const current = baseProfile()
    const payload = mapUpdateApprovalCard(current, {
      name: 'DATA_SCIENTIST',
      description: 'Builds and validates predictive models.',
      systemPrompt: 'NEW SECRET INSTRUCTIONS',
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: ['data-cleaning', 'model-training', 'netcdf-io'],
        connectorIds: ['postgres-readonly'],
        connectorTools: []
      }
    }) as Extract<SpecialistPermissionCardPayload, { kind: 'update' }>

    expect(payload.newName).toBe('DATA_SCIENTIST')
    // System instructions and descriptions appear as 'edited' summaries, never as full text.
    const fields = payload.changes.map((c) => c.field)
    expect(fields).toEqual(
      expect.arrayContaining([
        'description',
        'system instructions',
        'capability mode',
        'skills',
        'connectors'
      ])
    )
    const sysInstruction = payload.changes.find((c) => c.field === 'system instructions')
    expect(sysInstruction?.kind).toBe('edited')
    // The card payload must never embed the full system prompt text.
    expect(JSON.stringify(payload)).not.toContain('NEW SECRET INSTRUCTIONS')
  })

  it('reports added/removed counts for capability collections and a total', () => {
    const current = baseProfile({
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: ['a', 'b'],
        connectorIds: ['old-conn'],
        connectorTools: []
      }
    })
    const payload = mapUpdateApprovalCard(current, {
      name: 'RENAMED',
      selectedCapabilities: {
        skillIds: ['a', 'c', 'd'],
        connectorIds: ['new-conn'],
        connectorTools: []
      }
    }) as Extract<SpecialistPermissionCardPayload, { kind: 'update' }>

    const skills = payload.changes.find((c) => c.field === 'skills')
    expect(skills?.kind).toBe('collection')
    if (skills?.kind === 'collection') {
      expect(skills.added).toBe(2)
      expect(skills.removed).toBe(1)
      expect(skills.total).toBe(3)
    }
    const connectors = payload.changes.find((c) => c.field === 'connectors')
    expect(connectors?.kind).toBe('collection')
    if (connectors?.kind === 'collection') {
      expect(connectors.added).toBe(1)
      expect(connectors.removed).toBe(1)
      expect(connectors.total).toBe(1)
    }
  })

  it('never exposes UUIDs, secrets, or complete system instructions', () => {
    const current = baseProfile()
    const payload = mapUpdateApprovalCard(current, {
      name: 'RENAMED',
      systemPrompt: 'TOP SECRET TOKEN abc123 /Users/secret/path'
    })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('sp-1')
    expect(serialized).not.toContain('TOP SECRET')
    expect(serialized).not.toContain('abc123')
  })
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
      takesEffectOnNextMessage: true
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
