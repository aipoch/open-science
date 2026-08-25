import { describe, it, expect } from 'vitest'
import {
  getConnectorTools,
  getDescriptor,
  validateToolArguments,
  ALL_CONNECTOR_IDS
} from './registry'
import { CONNECTOR_CATALOG } from './catalog'

describe('registry + catalog', () => {
  it('resolves a tool by connector+method', () => {
    expect(getDescriptor('chemistry', 'pubchem_get_compounds')?.id).toBe('pubchem_get_compounds')
    expect(getDescriptor('chemistry', 'nope')).toBeUndefined()
  })
  it('lists tools for a connector', () => {
    expect(getConnectorTools('pubmed').map((t) => t.id)).toContain('search_articles')
  })
  it('catalog ids and registry ids are consistent', () => {
    for (const meta of CONNECTOR_CATALOG) expect(ALL_CONNECTOR_IDS).toContain(meta.id)
    for (const id of ALL_CONNECTOR_IDS) expect(CONNECTOR_CATALOG.map((c) => c.id)).toContain(id)
  })
  it('uses kebab-case for every bundled connector identity', () => {
    for (const id of ALL_CONNECTOR_IDS) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })
  it('compiles every bundled input Schema when the registry loads', () => {
    expect(ALL_CONNECTOR_IDS.flatMap(getConnectorTools).length).toBeGreaterThan(0)
  })
  it('validates arguments against the compiled input Schema without coercion', () => {
    const descriptor = getDescriptor('chemistry', 'pubchem_get_compounds')!

    expect(() => validateToolArguments(descriptor, { cids: [2244] })).not.toThrow()
    expect(() => validateToolArguments(descriptor, { cids: '2244' })).toThrow(
      /invalid tool arguments.*cids.*array/i
    )
  })
  it('uses Schema-required fields instead of the drifted descriptor required list', () => {
    const descriptor = getDescriptor('biorxiv', 'get_preprint')!

    expect(descriptor.required).toBeUndefined()
    expect(() => validateToolArguments(descriptor, {})).toThrow(/doi.*required/i)
  })
})
