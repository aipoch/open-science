import { describe, expect, it } from 'vitest'
import {
  validateSpecialistName,
  validateSpecialistDescription,
  validateCreateSpecialistInput,
  validateUpdateSpecialistInput,
  SPECIALIST_DESCRIPTION_MAX_LENGTH,
  SPECIALIST_DISPLAY_NAME_MAX_LENGTH,
  SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH,
  emptyFullAccessConfig,
  emptySelectedConfig,
  resolveEffectiveSpecialistSkills,
  filterSpecialistConnectorSkills
} from './specialist'

describe('validateSpecialistName', () => {
  it('accepts normal names', () => {
    expect(validateSpecialistName('RNA-seq Reviewer', [])).toBeUndefined()
    expect(validateSpecialistName('AB', [])).toBeUndefined()
    expect(validateSpecialistName('My Bot 2', [])).toBeUndefined()
  })

  it('rejects empty / whitespace-only name', () => {
    expect(validateSpecialistName('', [])).toBeTruthy()
    expect(validateSpecialistName('   ', [])).toBeTruthy()
  })

  it('rejects names over 80 chars', () => {
    expect(validateSpecialistName('A'.repeat(81), [])).toBeTruthy()
  })

  it('accepts exactly 80 chars', () => {
    expect(validateSpecialistName('A'.repeat(80), [])).toBeUndefined()
  })

  it('allows lowercase and spaces (human-readable)', () => {
    expect(validateSpecialistName('rna-seq reviewer', [])).toBeUndefined()
  })

  it('rejects duplicate name via existingNames fallback', () => {
    expect(validateSpecialistName('My Bot', ['My Bot'])).toBeTruthy()
  })

  it('rejects duplicate name via existingIds map', () => {
    const map = new Map([['My Bot', 'id-1']])
    expect(validateSpecialistName('My Bot', [], undefined, map)).toBeTruthy()
  })

  it('allows same name for self when editing (currentId matches)', () => {
    const map = new Map([['My Bot', 'id-1']])
    expect(validateSpecialistName('My Bot', [], 'id-1', map)).toBeUndefined()
  })
})

describe('validateCreateSpecialistInput', () => {
  it('returns empty array for valid input', () => {
    expect(validateCreateSpecialistInput({ name: 'RNA Reviewer' }, [])).toHaveLength(0)
  })

  it('returns name error when empty', () => {
    const errors = validateCreateSpecialistInput({ name: '' }, [])
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('returns name error when name is duplicate', () => {
    const map = new Map([['My Bot', 'id-1']])
    const errors = validateCreateSpecialistInput({ name: 'My Bot' }, [], map)
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('rejects invalid public names even when displayName is omitted', () => {
    expect(
      validateCreateSpecialistInput({ name: '<bad>' }, []).map((error) => error.message)
    ).toContain('Name may only contain letters, digits, spaces, hyphens, and underscores.')
    expect(
      validateUpdateSpecialistInput({ id: 'specialist-1', revision: 1, name: '<bad>' }, []).map(
        (error) => error.message
      )
    ).toContain('Name may only contain letters, digits, spaces, hyphens, and underscores.')
  })

  it('rejects blank or oversized display names on create and update', () => {
    expect(
      validateCreateSpecialistInput({ name: 'Bot', displayName: '   ' }, []).map(
        (error) => error.message
      )
    ).toContain('Display name is required.')

    expect(
      validateUpdateSpecialistInput(
        {
          id: 'specialist-1',
          revision: 1,
          displayName: 'x'.repeat(SPECIALIST_DISPLAY_NAME_MAX_LENGTH + 1)
        },
        []
      ).map((error) => error.message)
    ).toContain(`Display name must be ${SPECIALIST_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`)
  })
})

describe('validateSpecialistDescription', () => {
  it('accepts an empty description (optional field)', () => {
    expect(validateSpecialistDescription('')).toBeUndefined()
  })

  it('accepts a description at exactly the max length', () => {
    expect(
      validateSpecialistDescription('a'.repeat(SPECIALIST_DESCRIPTION_MAX_LENGTH))
    ).toBeUndefined()
  })

  it('rejects a description over the max length', () => {
    expect(validateSpecialistDescription('a'.repeat(SPECIALIST_DESCRIPTION_MAX_LENGTH + 1))).toBe(
      `Description must be ${SPECIALIST_DESCRIPTION_MAX_LENGTH} characters or fewer.`
    )
  })
})

describe('description validation in create/update inputs', () => {
  it('surfaces a description error on create when too long', () => {
    const errors = validateCreateSpecialistInput(
      { name: 'Bot', description: 'a'.repeat(SPECIALIST_DESCRIPTION_MAX_LENGTH + 1) },
      []
    )
    expect(errors.some((e) => e.field === 'description')).toBe(true)
  })

  it('surfaces a description error on update when too long', () => {
    const errors = validateUpdateSpecialistInput(
      { id: 'x', revision: 1, description: 'a'.repeat(SPECIALIST_DESCRIPTION_MAX_LENGTH + 1) },
      []
    )
    expect(errors.some((e) => e.field === 'description')).toBe(true)
  })
})

describe('system prompt validation in create/update inputs', () => {
  it('rejects prompts over the shared storage and runtime limit', () => {
    const oversized = 'a'.repeat(SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH + 1)

    expect(
      validateCreateSpecialistInput({ name: 'Bot', systemPrompt: oversized }, []).some(
        (error) => error.field === 'systemPrompt'
      )
    ).toBe(true)
    expect(
      validateUpdateSpecialistInput(
        { id: 'specialist-1', revision: 1, systemPrompt: oversized },
        []
      ).some((error) => error.field === 'systemPrompt')
    ).toBe(true)
  })
})

describe('empty config helpers', () => {
  it('emptyFullAccessConfig returns correct shape', () => {
    const cfg = emptyFullAccessConfig()
    expect(cfg.excludedSkillIds).toEqual([])
    expect(cfg.excludedConnectorIds).toEqual([])
    expect(cfg.connectorTools).toEqual([])
  })

  it('emptySelectedConfig returns correct shape', () => {
    const cfg = emptySelectedConfig()
    expect(cfg.skillIds).toEqual([])
    expect(cfg.connectorIds).toEqual([])
    expect(cfg.connectorTools).toEqual([])
  })
})

describe('resolveEffectiveSpecialistSkills', () => {
  const catalog = [
    { id: 'disabled-in-main', frameworkName: 'Disabled In Main' },
    { id: 'future-skill', frameworkName: 'Future Skill' }
  ]
  const base = {
    capabilityMode: 'full' as const,
    fullAccess: emptyFullAccessConfig(),
    selectedCapabilities: emptySelectedConfig()
  }

  it('full access includes current and newly discovered catalog entries, minus exclusions', () => {
    expect(resolveEffectiveSpecialistSkills(base, catalog)).toMatchObject({
      kind: 'specialist',
      skillIds: ['disabled-in-main', 'future-skill']
    })
    expect(
      resolveEffectiveSpecialistSkills(
        { ...base, fullAccess: { ...emptyFullAccessConfig(), excludedSkillIds: ['future-skill'] } },
        catalog
      )
    ).toMatchObject({ skillIds: ['disabled-in-main'] })
  })

  it('selected access retains explicit inclusions and reports only missing inclusions', () => {
    expect(
      resolveEffectiveSpecialistSkills(
        {
          ...base,
          capabilityMode: 'selected',
          selectedCapabilities: { ...emptySelectedConfig(), skillIds: ['disabled-in-main', 'gone'] }
        },
        catalog
      )
    ).toEqual({
      kind: 'specialist',
      skillIds: ['disabled-in-main'],
      frameworkNames: ['Disabled In Main'],
      missingSkillIds: ['gone']
    })
  })

  it('keeps Main unscoped', () => {
    expect(resolveEffectiveSpecialistSkills(undefined, catalog)).toEqual({ kind: 'main' })
  })
})

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
