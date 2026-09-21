import { Script } from 'node:vm'
import { describe, it, expect, vi } from 'vitest'
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
  it.each(['ncbi_get_assembly_info', 'ncbi_get_sequence_aliases'])(
    'requires a versioned assembly accession for genomes/%s',
    (method) => {
      const descriptor = getDescriptor('genomes', method)!

      expect(() =>
        validateToolArguments(descriptor, { assembly_accession: 'GCF_000001405.40' })
      ).not.toThrow()
      expect(() =>
        validateToolArguments(descriptor, { assembly_accession: 'GCF_000001405' })
      ).toThrow(/invalid tool arguments.*assembly_accession/i)
    }
  )
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

describe('PRIDE project file input contract', () => {
  const descriptor = getDescriptor('omics-archives', 'pride_get_project_files')!

  it.each(['PXD000001', 'PRD000001'])('accepts project accession %s', (projectAccession) => {
    expect(() =>
      validateToolArguments(descriptor, { project_accession: projectAccession })
    ).not.toThrow()
  })

  it.each([
    { project_accession: '../PXD000001' },
    { project_accession: 'PXD1' },
    { project_accession: 'PRD1' },
    { project_accession: 'PRD000001/../files' },
    { project_accession: 'PRD00000x' },
    { project_accession: 'PZD000001' },
    { page: -1 },
    { page: 0.5 },
    { page: '1' },
    { page: 1000001 },
    { page_size: 0 },
    { page_size: 101 },
    { page_size: 1.5 },
    { page_size: '2' },
    { download: true }
  ])('rejects invalid or unknown arguments: %j', (args) => {
    expect(() =>
      validateToolArguments(descriptor, { project_accession: 'PXD000001', ...args })
    ).toThrow(/invalid_arguments/)
  })
})

// Authored examples are part of the agent-facing contract, not illustrative pseudocode.
describe('bundled tool contracts', () => {
  const tools = ALL_CONNECTOR_IDS.flatMap(getConnectorTools)
  it('keeps every public connector/method identity unique', () => {
    expect(new Set(tools.map((tool) => `${tool.connector}/${tool.id}`)).size).toBe(tools.length)
    expect(new Set(CONNECTOR_CATALOG.map((connector) => connector.id)).size).toBe(
      CONNECTOR_CATALOG.length
    )
  })

  it.each(tools)(
    '$connector/$id has a runnable, schema-valid example and return documentation',
    async (tool) => {
      expect(tool.id).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(tool.description.trim()).not.toBe('')
      expect(tool.returns?.trim()).toBeTruthy()
      expect(tool.example?.trim()).toBeTruthy()
      expect(
        typeof tool.run === 'function' ||
          (typeof tool.url === 'function' && typeof tool.parse === 'function')
      ).toBe(true)
      const mcp = vi.fn((connector: string, method: string, args: Record<string, unknown> = {}) => {
        expect([connector, method]).toEqual([tool.connector, tool.id])
        validateToolArguments(tool, args)
        return {}
      })
      // Repository-authored code only; the stub never dispatches or accesses credentials/network.
      await new Script(`(async () => { ${tool.example} })()`).runInNewContext(
        { host: { mcp } },
        { timeout: 1000 }
      )
      expect(mcp).toHaveBeenCalledTimes(1)
    }
  )
})

describe('UniProt discovery input contract', () => {
  const search = getDescriptor('genes', 'search_uniprot_entries')!
  it.each([
    {},
    { reviewed: true },
    { query: 'organism_id:9606' },
    { gene: 'TP53', offset: 1 },
    { gene: ' ' },
    { protein_name: '\u3000' },
    { gene: 'x" OR reviewed:true' },
    { gene: '*' },
    { organism_id: '9606' },
    { gene: 'TP53', reviewed: 'true' },
    { gene: 'TP53', page_size: 501 },
    { gene: 'TP53', cursor: '' }
  ])('rejects invalid search arguments before authorization: %j', (args) => {
    expect(() => validateToolArguments(search, args)).toThrow(/invalid_arguments/)
  })
  it.each(['a', '𠮷', '😀'])('counts both text fields as Unicode code points: %s', (character) => {
    for (const field of ['gene', 'protein_name']) {
      expect(() => validateToolArguments(search, { [field]: character.repeat(200) })).not.toThrow()
      expect(() => validateToolArguments(search, { [field]: character.repeat(201) })).toThrow(
        /invalid_arguments/
      )
    }
  })
  it('accepts false, maximum page size and cursors without injecting defaults or changing arguments', () => {
    const args = { gene: ' TP53 ', reviewed: false, page_size: 500, cursor: 'opaque+/token==' }
    expect(() => validateToolArguments(search, args)).not.toThrow()
    expect(args).toEqual({
      gene: ' TP53 ',
      reviewed: false,
      page_size: 500,
      cursor: 'opaque+/token=='
    })
    const minimal = { gene: 'TP53' }
    validateToolArguments(search, minimal)
    expect(minimal).toEqual({ gene: 'TP53' })
  })
})
