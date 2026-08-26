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
  it('accepts scalar forms that bundled handlers normalize to one-item lists', () => {
    const cases = [
      ['pubmed', 'get_article_metadata', 'pmids', '35486828'],
      ['pubmed', 'find_related_articles', 'pmids', '35486828'],
      ['pubmed', 'convert_article_ids', 'ids', 'PMC9046468'],
      ['pubmed', 'get_full_text_article', 'pmc_ids', 'PMC9046468'],
      ['pubmed', 'get_copyright_status', 'pmids', '35891187'],
      ['variants', 'clinvar_get_records', 'accessions', 'VCV000045122'],
      ['zinc', 'zinc_search_by_id', 'zinc_ids', 'ZINC000000000012'],
      ['zinc', 'zinc_search_by_supplier', 'supplier_codes', 'MCULE-2311834287'],
      ['zinc', 'zinc_get_3d', 'zinc_ids', 'ZINC000000000012']
    ] as const

    for (const [connector, method, field, value] of cases) {
      const descriptor = getDescriptor(connector, method)!
      expect(() => validateToolArguments(descriptor, { [field]: value })).not.toThrow()
      expect(() => validateToolArguments(descriptor, { [field]: [value] })).not.toThrow()
    }
  })
  it('uses Schema-required fields instead of the drifted descriptor required list', () => {
    const descriptor = getDescriptor('biorxiv', 'get_preprint')!

    expect(descriptor.required).toBeUndefined()
    expect(() => validateToolArguments(descriptor, {})).toThrow(/doi.*required/i)
  })
})
