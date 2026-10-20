import { describe, expect, it } from 'vitest'
import type { SpecialistListItem } from '../../../../shared/specialist'
import { assignmentUpdate, isResourceAssigned, bulkResourceActions } from './resource-assignment'

const specialist = (overrides = {}): Exclude<SpecialistListItem, { kind: 'reviewer' }> => ({
  kind: 'custom',
  id: 'research',
  name: 'RESEARCH',
  description: '',
  systemPrompt: '',
  enabled: false,
  revision: 4,
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: {
    skillIds: ['existing'],
    connectorIds: ['legacy-name'],
    connectorTools: [{ connectorId: 'legacy-name', excludedMethods: ['write'] }]
  },
  ...overrides
})
const skill = {
  id: 'new',
  name: 'New',
  kind: 'skill' as const,
  group: 'featured',
  mainEnabled: true
}

describe('resource assignments', () => {
  it('adds only missing resources and preserves tool policy, inactive mode and disabled Specialist state', () => {
    const item = specialist()
    expect(assignmentUpdate(item, [skill], true)).toEqual({
      id: 'research',
      revision: 4,
      selectedCapabilities: {
        skillIds: ['existing', 'new'],
        connectorIds: ['legacy-name'],
        connectorTools: [{ connectorId: 'legacy-name', excludedMethods: ['write'] }]
      }
    })
    expect(assignmentUpdate(item, [{ ...skill, id: 'existing' }], true)).toBeUndefined()
  })
  it('changes exclusions in full access mode without converting future-resource access to a snapshot', () => {
    const item = specialist({ capabilityMode: 'full' })
    expect(assignmentUpdate(item, [skill], false)).toEqual({
      id: 'research',
      revision: 4,
      fullAccess: { excludedSkillIds: ['new'], excludedConnectorIds: [], connectorTools: [] }
    })
    expect(assignmentUpdate(item, [skill], true)).toBeUndefined()
  })
  it('recognizes and removes legacy connector names without touching tool rules', () => {
    const resource = { ...skill, id: 'stable-id', name: 'legacy-name', kind: 'connector' as const }
    const item = specialist()
    expect(isResourceAssigned(item, resource)).toBe(true)
    expect(assignmentUpdate(item, [resource], false)?.selectedCapabilities).toEqual({
      skillIds: ['existing'],
      connectorIds: [],
      connectorTools: [{ connectorId: 'legacy-name', excludedMethods: ['write'] }]
    })
    const full = specialist({
      capabilityMode: 'full',
      fullAccess: {
        excludedSkillIds: [],
        excludedConnectorIds: ['legacy-name', 'stable-id'],
        connectorTools: []
      }
    })
    expect(isResourceAssigned(full, resource)).toBe(false)
    expect(assignmentUpdate(full, [resource], true)?.fullAccess?.excludedConnectorIds).toEqual([])
  })
  it('does not offer capability mutations for marketplace profiles', () => {
    const item = specialist({ origin: 'marketplace' })
    expect(assignmentUpdate(item, [skill], true)).toBeUndefined()
    expect(bulkResourceActions([{ ...skill, id: 'existing' }], [item]).unlink).toEqual([])
  })
  it('never edits read-only built-in Specialists', () => {
    expect(
      assignmentUpdate(specialist({ kind: 'builtin', readonly: true, version: '1' }), [skill], true)
    ).toBeUndefined()
  })
  it('offers warning actions only for affected selected items and never deletes featured or referenced resources', () => {
    const required = { ...skill, mainRequired: true }
    const unused = { ...skill, id: 'unused', mainEnabled: false }
    expect(bulkResourceActions([unused], [])).toEqual({ stopMain: [], unlink: [], deletable: [] })
    expect(bulkResourceActions([required], []).stopMain).toEqual([])
    const personal = { ...skill, id: 'existing', group: 'personal', deletable: true }
    const result = bulkResourceActions([required, personal], [specialist()])
    expect(result.stopMain.map((item) => item.id)).toEqual(['existing'])
    expect(result.unlink.map((item) => item.id)).toEqual(['existing'])
    expect(result.deletable).toEqual([])
    expect(bulkResourceActions([personal], []).deletable.map((item) => item.id)).toEqual([
      'existing'
    ])
    expect(
      bulkResourceActions(
        [personal],
        [
          specialist({
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            ownedSkillIds: ['existing']
          })
        ]
      ).deletable
    ).toEqual([])
  })
})
