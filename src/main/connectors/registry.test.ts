import { Script } from 'node:vm'
import { describe, it, expect, vi } from 'vitest'
import {
  getConnectorTools,
  getDescriptor,
  validateToolArguments,
  ALL_CONNECTOR_IDS
} from './registry'
import { CONNECTOR_CATALOG } from './catalog'
import { ParserEngine } from './engine'
import { CELLXGENE_DISCOVER_TOOLS } from './descriptors/cellxgene-discover'
import { renderSkillDoc } from './skill-doc'
import { WORKBENCH_OMICS_TOOLS } from './descriptors/omics-workbench'
import { VARIANTS_MAVEDB_TOOLS } from './descriptors/variants-mavedb'

describe('registry + catalog', () => {
  it('registers bounded IEDB evidence searches and documents UniProt/PDB handoffs', () => {
    expect(getConnectorTools('iedb').map((tool) => tool.id)).toEqual([
      'search_epitopes',
      'search_antigens',
      'search_tcell_assays',
      'search_bcell_assays',
      'search_mhc_assays',
      'search_references'
    ])
    const epitope = getDescriptor('iedb', 'search_epitopes')!
    expect(() =>
      validateToolArguments(epitope, {
        sequence: 'SIINFEKL',
        host_taxonomy_id: 9606,
        uniprot_accession: 'P01012'
      })
    ).not.toThrow()
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 1000001 },
      { host_taxonomy_id: '9606' },
      { epitope_id: '1VAC' },
      { sequence: 'SIINFEKL\n' },
      { antigen_iri: 'UNIPROT:P01012', uniprot_accession: 'P01012' },
      { uniprot_accession: 'P01012\n' },
      { antigen_iri: 'UNIPROT:P01012&limit=999' },
      { mhc_class: 'III' },
      { pdb_id: '../x' },
      { url: 'https://example.org/' },
      { pubmed_id: '1234' }
    ])
      expect(() => validateToolArguments(epitope, { sequence: 'SIINFEKL', ...args })).toThrow(
        /invalid_arguments/
      )
    expect(() =>
      validateToolArguments(getDescriptor('iedb', 'search_mhc_assays')!, {
        assay_id: 1406346,
        qualitative_measure: 'Negative'
      })
    ).not.toThrow()
    expect(() =>
      validateToolArguments(getDescriptor('iedb', 'search_references')!, { pubmed_id: '22504645' })
    ).not.toThrow()
    const doc = renderSkillDoc('iedb')
    for (const phrase of [
      'get_uniprot_entries',
      'pdb_get_structures',
      'next_offset',
      'not predictions',
      'different experiments',
      'curated antigen',
      'assay__units',
      'elution_id'
    ]) {
      expect(doc).toContain(phrase)
    }
  })

  it.each([
    ['search_epitopes', { sequence: 'SIINFEKL' }],
    ['search_antigens', { antigen_name: 'ovalbumin' }],
    ['search_tcell_assays', { assay_id: 1957578 }],
    ['search_bcell_assays', { assay_id: 1854962 }],
    ['search_mhc_assays', { assay_id: 1406346 }],
    ['search_references', { pubmed_id: '22504645' }]
  ] as const)(
    'requires a biological or evidence filter in the %s input schema',
    (method, filter) => {
      const descriptor = getDescriptor('iedb', method)!
      for (const args of [{}, { limit: 20 }, { offset: 0 }, { limit: 20, offset: 0 }]) {
        expect(() => validateToolArguments(descriptor, args)).toThrow(/invalid_arguments/)
      }
      expect(() =>
        validateToolArguments(descriptor, { ...filter, limit: 20, offset: 0 })
      ).not.toThrow()
      expect(() => validateToolArguments(descriptor, { host_taxonomy_id: 9606 })).not.toThrow()
    }
  )

  it.each([
    'search_epitopes',
    'search_antigens',
    'search_tcell_assays',
    'search_bcell_assays',
    'search_mhc_assays',
    'search_references'
  ])('validates mutually exclusive antigen filters in the %s input schema', (method) => {
    const descriptor = getDescriptor('iedb', method)!
    expect(() => validateToolArguments(descriptor, { antigen_iri: 'UNIPROT:P01012' })).not.toThrow()
    expect(() => validateToolArguments(descriptor, { uniprot_accession: 'P01012' })).not.toThrow()
    expect(() =>
      validateToolArguments(descriptor, {
        antigen_iri: 'UNIPROT:P01012',
        uniprot_accession: 'P01012'
      })
    ).toThrow(/invalid_arguments/)
  })

  it('exposes PDB sequence search through the registry and generated skill with strict cutoffs', () => {
    const tool = getDescriptor('structures', 'pdb_search_sequence')!
    expect(tool).toBeDefined()
    const sequence = 'MTEYKLVVVGAGGVGKSALTIQLIQNHFVDEYDPTIEDSYRKQV'
    expect(() =>
      validateToolArguments(tool, { sequence, identity_cutoff: 0.9, min_query_coverage: 0.8 })
    ).not.toThrow()
    for (const args of [
      {},
      { sequence, identity_cutoff: 90 },
      { sequence, min_query_coverage: -1 },
      { sequence, evalue_cutoff: 0 },
      { sequence, max_rows: 26 },
      { sequence, max_candidates: 1001 },
      { sequence, include_computed_models: true }
    ])
      expect(() => validateToolArguments(tool, args)).toThrow(/invalid_arguments/)
    const doc = renderSkillDoc('structures')
    expect(doc).toContain('### pdb_search_sequence')
    expect(doc).toContain('min_query_coverage')
    expect(doc).toContain('BEFORE coverage filtering')
    expect(doc).toContain('auth_asym_ids')
  })

  it('registers bounded Monarch evidence queries separately from OLS and Alliance', () => {
    expect(getConnectorTools('monarch').map((tool) => tool.id)).toEqual([
      'monarch_get_disease_phenotypes',
      'monarch_get_gene_phenotypes'
    ])
    const tool = getDescriptor('monarch', 'monarch_get_disease_phenotypes')!
    expect(() => validateToolArguments(tool, { disease_id: 'MONDO:0007947' })).not.toThrow()
    for (const args of [
      { disease_id: 'Marfan' },
      { disease_id: 'MONDO:0007947\n' },
      { disease_id: 'MONDO:0007947', limit: 101 },
      { disease_id: 'MONDO:0007947', offset: -1 },
      { disease_id: 'MONDO:0007947', direct: 'false' },
      { disease_id: 'MONDO:0007947', query: '*' }
    ])
      expect(() => validateToolArguments(tool, args)).toThrow(/invalid_arguments/)
    const doc = renderSkillDoc('monarch')
    expect(doc).toContain('monarch_get_disease_phenotypes')
    expect(doc).toContain('monarch_get_gene_phenotypes')
    expect(doc).toContain('knowledge_level')
    expect(doc).toContain('OLS')
    expect(doc).toContain('Alliance')
  })

  it('registers HMMER search, status and results with the Pfam hmmscan constraint', () => {
    expect(getConnectorTools('hmmer').map((tool) => tool.id)).toEqual([
      'search',
      'status',
      'results'
    ])
    expect(() =>
      validateToolArguments(getDescriptor('hmmer', 'search')!, {
        program: 'hmmscan',
        database: 'pfam',
        input: 'MKT'
      })
    ).not.toThrow()
    expect(() =>
      validateToolArguments(getDescriptor('hmmer', 'search')!, {
        program: 'hmmscan',
        database: 'uniprot',
        input: 'MKT'
      })
    ).toThrow(/invalid_arguments/)
    expect(() =>
      validateToolArguments(getDescriptor('hmmer', 'search')!, {
        program: 'hmmscan',
        database: 'pfam',
        input: 'MKT',
        cut_ga: true
      })
    ).toThrow(/invalid_arguments/)
    expect(() =>
      validateToolArguments(getDescriptor('hmmer', 'search')!, {
        program: 'phmmer',
        database: 'pdb',
        input: 'MKT',
        nobias: true
      })
    ).toThrow(/invalid_arguments/)
    expect(() =>
      validateToolArguments(getDescriptor('hmmer', 'search')!, {
        program: 'phmmer',
        database: 'pdb',
        input: 'MKT',
        iterations: 2
      })
    ).toThrow(/invalid_arguments/)
    expect(() =>
      validateToolArguments(getDescriptor('hmmer', 'search')!, {
        program: 'jackhmmer',
        database: 'pdb',
        input: 'MKT',
        popen: 0.4999995,
        pextend: 0.9999995
      })
    ).not.toThrow()
  })

  it('registers InterProScan separately and validates its bounded input contract', () => {
    expect(getConnectorTools('interproscan').map((tool) => tool.id)).toEqual(['status', 'results'])
    expect(getDescriptor('protein-annotation', 'submit')).toBeUndefined()
    for (const method of ['status', 'results']) {
      expect(() =>
        validateToolArguments(getDescriptor('interproscan', method)!, {
          job_id: 'iprscan5-../secret'
        })
      ).toThrow(/invalid_arguments/)
    }
  })
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

  it('validates the UniProt mapping schemas without importing the registry from descriptor tests', () => {
    const submit = getDescriptor('genes', 'submit_uniprot_id_mapping')!
    const status = getDescriptor('genes', 'get_uniprot_id_mapping_status')!
    const results = getDescriptor('genes', 'get_uniprot_id_mapping_results')!
    expect(() =>
      validateToolArguments(submit, {
        from_db: 'UniProtKB_AC-ID',
        to_db: 'GeneID',
        ids: ['P04637']
      })
    ).not.toThrow()
    expect(() =>
      validateToolArguments(submit, {
        from_db: 'UniProtKB_AC-ID',
        to_db: 'GeneID',
        ids: ['P04637,P00533']
      })
    ).toThrow(/invalid_arguments/)
    expect(() => validateToolArguments(status, { job_id: '../job' })).toThrow(/invalid_arguments/)
    expect(() => validateToolArguments(results, { job_id: 'job', page_size: 501 })).toThrow(
      /invalid_arguments/
    )
    expect(() =>
      validateToolArguments(submit, {
        from_db: 'UniProtKB_AC-ID',
        to_db: 'GeneID',
        ids: Array.from({ length: 100_000 }, (_, i) => `id${i}`)
      })
    ).not.toThrow()
  })
})

describe('Metabolomics Workbench registration and input contracts', () => {
  it('registers all tools in Omics Archives and includes discovery guidance and examples', () => {
    const catalog = CONNECTOR_CATALOG.find((entry) => entry.id === 'omics-archives')!
    expect(catalog.sources).toContain('Metabolomics Workbench')
    const doc = renderSkillDoc(catalog.id)
    for (const descriptor of WORKBENCH_OMICS_TOOLS) {
      expect(getDescriptor('omics-archives', descriptor.id)).toBe(descriptor)
      expect(doc).toContain(descriptor.id)
      expect(doc).toContain(descriptor.example!)
    }
  })

  it('accepts supported compound fields, study search fields and study sections', () => {
    for (const field of [
      'regno',
      'formula',
      'inchi_key',
      'lm_id',
      'pubchem_cid',
      'hmdb_id',
      'kegg_id',
      'chebi_id',
      'metacyc_id'
    ]) {
      expect(() =>
        validateToolArguments(getDescriptor('omics-archives', 'workbench_search_compounds')!, {
          field,
          query: '5793'
        })
      ).not.toThrow()
    }
    for (const field of [undefined, 'study_title', 'institute']) {
      expect(() =>
        validateToolArguments(getDescriptor('omics-archives', 'workbench_search_studies')!, {
          ...(field === undefined ? {} : { field }),
          query: 'Fatb'
        })
      ).not.toThrow()
    }
    for (const section of [undefined, 'summary', 'factors', 'analysis', 'metabolites']) {
      expect(() =>
        validateToolArguments(getDescriptor('omics-archives', 'workbench_get_study')!, {
          ...(section === undefined ? {} : { section }),
          study_id: 'ST000001'
        })
      ).not.toThrow()
    }
  })

  it.each([
    ['workbench_search_compounds', { field: 'name', query: 'glucose' }],
    ['workbench_search_compounds', { field: 'abbrev', query: 'PC(34:1)' }],
    ['workbench_search_compounds', { field: 'regno', query: 11 }],
    ['workbench_search_studies', {}],
    ['workbench_search_studies', { query: '' }],
    ['workbench_search_studies', { query: 'x'.repeat(201) }],
    ['workbench_search_studies', { query: 'Fatb', field: 'species' }],
    ['workbench_search_studies', { query: 'Fatb', limit: 0 }],
    ['workbench_search_studies', { query: 'Fatb', limit: 1001 }],
    ['workbench_search_studies', { query: 'Fatb', limit: 1.5 }],
    ['workbench_search_studies', { query: 'Fatb', limit: '10' }],
    ['workbench_search_studies', { query: 'Fatb', offset: 1 }],
    ['workbench_get_study', { study_id: 'ST' }],
    ['workbench_get_study', { study_id: 'ST000001/../ST000002' }],
    ['workbench_get_study', { study_id: 'ST000001', section: 'data' }],
    ['workbench_get_study', { study_id: 'ST000001', download: true }],
    ['workbench_search_studies', { field: 'last_name', query: 'Kind' }]
  ])('rejects invalid %s arguments at the registry boundary: %j', (id, args) => {
    expect(() =>
      validateToolArguments(
        getDescriptor('omics-archives', id as string)!,
        args as Record<string, unknown>
      )
    ).toThrow(/invalid_arguments/)
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

describe('ENA discovery input contracts', () => {
  const query = getDescriptor('omics-archives', 'ena_query_runs')!

  it.each(['a', '𠮷', '😀'])('counts keyword %s by Unicode code points', (character) => {
    expect(() => validateToolArguments(query, { keyword: character.repeat(200) })).not.toThrow()
    expect(() => validateToolArguments(query, { keyword: character.repeat(201) })).toThrow(
      /invalid_arguments/
    )
  })

  it.each(['   ', '\u00a0', '\u3000'])(
    'rejects whitespace-only keyword %j at the Schema boundary',
    (keyword) => {
      for (const args of [{ keyword }, { tax_id: 6239, keyword }]) {
        expect(() => validateToolArguments(query, args)).toThrow(/invalid_arguments/)
      }
    }
  )

  it('accepts surrounding whitespace without mutating keyword arguments', () => {
    const args = { keyword: '\u3000 transcriptome \u00a0' }
    expect(() => validateToolArguments(query, args)).not.toThrow()
    expect(args.keyword).toBe('\u3000 transcriptome \u00a0')
  })

  it('requires a structured discovery filter and rejects raw queries and pagination', () => {
    for (const args of [{}, { query: 'tax_tree(6239)' }, { tax_id: 6239, offset: 1 }]) {
      expect(() => validateToolArguments(query, args)).toThrow(/invalid_arguments/)
    }
    expect(() =>
      validateToolArguments(query, { tax_id: 6239, library_strategy: 'RNA-Seq' })
    ).not.toThrow()
  })

  it('keeps accession lookup, generated FASTQ and submitted files as distinct contracts', () => {
    const lookup = getDescriptor('omics-archives', 'ena_search_runs')!
    expect(() => validateToolArguments(lookup, { keyword: 'worm' })).toThrow(/invalid_arguments/)
    for (const id of ['ena_get_run_files', 'ena_get_submitted_files']) {
      const descriptor = getDescriptor('omics-archives', id)!
      expect(() =>
        validateToolArguments(descriptor, { run_accession: 'ERR10015065' })
      ).not.toThrow()
      expect(() => validateToolArguments(descriptor, { accession: 'ERR10015065' })).toThrow(
        /invalid_arguments/
      )
    }
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

describe('Zenodo input contracts', () => {
  it.each([
    {},
    { query: '' },
    { query: '\u3000 ' },
    { query: 'x'.repeat(1001) },
    { query: 'x', page: 0 },
    { query: 'x', page: '2' },
    { query: 'x', page: 1.5 },
    { query: 'x', page_size: 26 },
    { query: 'x', page_size: 0 },
    { query: 'x', all_versions: 'true' },
    { query: 'x', sort: 'unknown' },
    { query: 'x', url: 'https://example.com' }
  ])('rejects invalid search arguments: %j', (args) => {
    expect(() => validateToolArguments(getDescriptor('zenodo', 'search_records')!, args)).toThrow(
      /invalid_arguments/
    )
  })

  it('counts the query limit in Unicode code points', () => {
    const descriptor = getDescriptor('zenodo', 'search_records')!
    expect(() => validateToolArguments(descriptor, { query: '😀'.repeat(1000) })).not.toThrow()
    expect(() => validateToolArguments(descriptor, { query: '😀'.repeat(1001) })).toThrow(
      /invalid_arguments/
    )
  })

  it.each(['0', '../1', '8435696?download=1', '01', '10.5281/zenodo.8435696', 8435696])(
    'rejects noncanonical record IDs: %s',
    (recordId) => {
      expect(() =>
        validateToolArguments(getDescriptor('zenodo', 'get_record')!, { record_id: recordId })
      ).toThrow(/invalid_arguments/)
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

describe('MaveDB registration and input contracts', () => {
  const SCORE_SET = 'urn:mavedb:00000003-a-1'
  const EXPERIMENT = 'urn:mavedb:00000003-a'
  const tool = (id: string): (typeof VARIANTS_MAVEDB_TOOLS)[number] =>
    getDescriptor('variants', `mavedb_${id}`)!

  it('registers all six public tools and discovery aliases', () => {
    expect(VARIANTS_MAVEDB_TOOLS).toHaveLength(6)
    for (const descriptor of VARIANTS_MAVEDB_TOOLS) {
      expect(getDescriptor('variants', descriptor.id)).toBe(descriptor)
      expect(descriptor.requiredCredential).toBeUndefined()
    }
    expect(CONNECTOR_CATALOG.find((c) => c.id === 'variants')?.aliases).toContain('MaveDB')
  })

  it.each(['urn:mavedb:00000662-0-1', 'urn:mavedb:00000003-aa-12'])(
    'accepts published meta-analysis and multi-letter URNs: %s',
    (id) => {
      expect(() => validateToolArguments(tool('get_score_set'), { urn: id })).not.toThrow()
      expect(() =>
        validateToolArguments(tool('get_experiment'), { urn: id.slice(0, id.lastIndexOf('-')) })
      ).not.toThrow()
    }
  )

  it.each([
    ['get_score_set', { urn: EXPERIMENT }],
    ['get_experiment', { urn: SCORE_SET }],
    ['get_score_set', { urn: `${SCORE_SET}/../../users/me` }],
    ['get_score_set', { urn: `${SCORE_SET}?secret=1` }],
    ['get_score_set', { urn: `tmp:446191af-c1f8-4891-9f67-de152e9d328b` }],
    ['search_score_sets', { text: ' ' }],
    ['search_score_sets', { text: 'x'.repeat(1001) }],
    ['search_score_sets', { text: 'BRCA1', limit: 101 }],
    ['search_score_sets', { text: 'BRCA1', offset: -1 }],
    ['search_score_sets', { text: 'BRCA1', offset: 0.5 }],
    ['download_scores', { urn: SCORE_SET, limit: '2' }],
    ['download_scores', { urn: SCORE_SET, limit: 10001 }],
    ['download_scores', { urn: SCORE_SET, start: -1 }]
  ])('rejects invalid MaveDB %s arguments in the registered schema', (id, args) => {
    expect(() => validateToolArguments(tool(id), args)).toThrow(/invalid_arguments/)
  })

  it('rejects unsupported input fields in the registered schema', () => {
    expect(() =>
      validateToolArguments(tool('get_mapped_variants'), { urn: SCORE_SET, offset: 1 })
    ).toThrow(/invalid_arguments/)
    expect(() =>
      validateToolArguments(tool('search_score_sets'), { text: 'BRCA1', published: false })
    ).toThrow(/invalid_arguments/)
  })
})

describe('CELLxGENE Discover registration and input contracts', () => {
  const C = '9a71db9e-687f-41f0-b88e-544eb1314ef6'
  const D = '0bbf93aa-2d3a-420f-95a1-26fe384024cb'
  const DV = '8e0fcb64-735c-4fcb-a74b-12a3518683d1'

  it('registers nine tools separately from CellGuide and documents the acquisition workflow', () => {
    expect(getConnectorTools('cellxgene-discover')).toEqual(CELLXGENE_DISCOVER_TOOLS)
    expect(CELLXGENE_DISCOVER_TOOLS).toHaveLength(9)
    expect(getConnectorTools('cellguide')).toHaveLength(5)
    expect(CONNECTOR_CATALOG.find((c) => c.id === 'cellxgene-discover')).toMatchObject({
      requiresNcbi: false
    })
    const doc = renderSkillDoc('cellxgene-discover')
    for (const t of CELLXGENE_DISCOVER_TOOLS) {
      expect(doc).toContain(t.id)
      expect(t.returns).toBeTruthy()
      const args = JSON.parse(t.example!.slice(t.example!.lastIndexOf(', {') + 2, -1))
      expect(() => validateToolArguments(t, args)).not.toThrow()
    }
    expect(doc).toContain('client-side')
    expect(doc).toContain('Census')
    expect(doc).toContain('dataset_version_id')
    expect(doc).toContain('can return historical datasets')
  })

  it.each([{ dataset_version_id: DV }, { collection_id: C, dataset_id: D }])(
    'accepts either file inventory identity: %j',
    (args) => {
      expect(() =>
        validateToolArguments(getDescriptor('cellxgene-discover', 'list_dataset_files')!, args)
      ).not.toThrow()
    }
  )

  it.each([
    ['list_collections', { page: 0 }],
    ['list_collections', { page_size: 101 }],
    ['list_datasets', { page_size: 1.5 }],
    ['list_datasets', { query: '  ' }],
    ['list_datasets', { schema_version: '7&visibility=PRIVATE' }],
    ['list_datasets', { visibility: 'PRIVATE' }],
    ['get_collection', { collection_id: '../private' }],
    ['get_dataset', { dataset_id: D }],
    ['get_dataset_version', { dataset_version_id: `${DV}?other=1` }],
    ['list_dataset_files', { collection_id: C }],
    ['list_dataset_files', { dataset_id: D, dataset_version_id: DV }],
    ['list_dataset_files', { dataset_version_id: null }],
    ['list_dataset_files', { dataset_version_id: DV, extra: true }],
    ['list_dataset_files', {}],
    ['list_dataset_files', { dataset_id: D }],
    ['list_dataset_files', { collection_id: C, dataset_version_id: DV }],
    ['list_dataset_files', { collection_id: C, dataset_id: D, dataset_version_id: DV }]
  ])(
    'rejects invalid or ambiguous %s arguments before making a request: %j',
    async (method, args) => {
      const fetchImpl = vi.fn()
      const engine = new ParserEngine({ fetchImpl })
      const tool = getDescriptor('cellxgene-discover', method)!
      await expect(
        Promise.resolve().then(() => {
          validateToolArguments(tool, args)
          return engine.call(tool, args, {})
        })
      ).rejects.toThrow('invalid_arguments')
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )
})

describe('Cellosaurus registration', () => {
  it('exposes identity and quality tools with valid generated examples', () => {
    const tools = getConnectorTools('cellosaurus')
    expect(tools.map((tool) => tool.id)).toEqual(['search_cell_lines', 'get_cell_line'])
    expect(CONNECTOR_CATALOG.find((entry) => entry.id === 'cellosaurus')).toMatchObject({
      sources: ['Cellosaurus'],
      requiresNcbi: false
    })
    const doc = renderSkillDoc('cellosaurus')
    expect(doc).toContain('name: mcp-cellosaurus')
    expect(doc).toContain('No recorded problem')
    expect(doc).toContain('next_offset')
    for (const tool of tools) {
      expect(doc).toContain(`### ${tool.id}`)
      const args = JSON.parse(tool.example!.slice(tool.example!.lastIndexOf(', {') + 2, -1))
      expect(() => validateToolArguments(tool, args)).not.toThrow()
    }
  })
})
