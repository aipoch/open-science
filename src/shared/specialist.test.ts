import { describe, expect, it } from 'vitest'
import { emptyFullAccessConfig, emptySelectedConfig } from '@aipoch/specialists'
import { filterSpecialistConnectorSkills } from './specialist'

describe('filterSpecialistConnectorSkills', () => {
  const provisioned = ['mcp-chemistry', 'mcp-literature', 'mcp-pubmed']

  it('selected mode keeps only connectorIds', () => {
    const specialist = {
      capabilityMode: 'selected' as const,
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: { ...emptySelectedConfig(), connectorIds: ['chemistry'] }
    }
    expect(filterSpecialistConnectorSkills(provisioned, specialist)).toEqual(['mcp-chemistry'])
  })

  it('full mode keeps all provisioned except excludedConnectorIds', () => {
    const specialist = {
      capabilityMode: 'full' as const,
      fullAccess: { ...emptyFullAccessConfig(), excludedConnectorIds: ['literature'] },
      selectedCapabilities: emptySelectedConfig()
    }
    expect(filterSpecialistConnectorSkills(provisioned, specialist)).toEqual([
      'mcp-chemistry',
      'mcp-pubmed'
    ])
  })

  it('returns empty when no connector is allowed', () => {
    const specialist = {
      capabilityMode: 'selected' as const,
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: { ...emptySelectedConfig(), connectorIds: ['nonexistent'] }
    }
    expect(filterSpecialistConnectorSkills(provisioned, specialist)).toEqual([])
  })
})
