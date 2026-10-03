import type { ToolDescriptor } from '../types'

// IQ-API search/export contracts: https://query-api.iedb.org/ (live OpenAPI).
// https://discuss.iedb.org/t/immune-epitope-database-query-api-iq-api/154
const API = 'https://query-api.iedb.org'
type Row = Record<string, unknown>
type Kind = 'epitope' | 'antigen' | 'tcell' | 'bcell' | 'mhc' | 'reference'
const MAX_OFFSET = 1000000
const id = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const text = { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' }
const curie = {
  type: 'string',
  maxLength: 200,
  pattern: '^[A-Za-z][A-Za-z0-9_]*:[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])'
}
const accessionPattern = '[A-Z0-9]{6}(?:[A-Z0-9]{4})?(?:-[1-9][0-9]*)?'
const assayKinds = new Set<Kind>(['tcell', 'bcell', 'mhc'])
const keys: Record<Kind, string> = {
  epitope: 'structure_id',
  antigen: 'parent_source_antigen_iri',
  tcell: 'tcell_id',
  bcell: 'bcell_id',
  mhc: 'elution_id',
  reference: 'reference_id'
}
const aggregateFields = [
  'curated_source_antigens',
  'parent_source_antigen_names',
  'host_organism_iris',
  'host_organism_names',
  'source_organism_iris',
  'source_organism_names',
  'mhc_allele_names',
  'mhc_classes',
  'qualitative_measures',
  'assay_names',
  'tcell_ids',
  'bcell_ids',
  'elution_ids',
  'pdb_ids'
]
const literatureAggregateFields = [
  'epitope_structures_defined',
  'reference_types',
  'journal_names',
  'reference_titles',
  'reference_authors',
  'reference_dates'
]
const referenceExportFields = [
  'reference__type',
  'reference__pmid',
  'reference__submission_id',
  'reference__alternate_iris',
  'reference__authors',
  'reference__journal',
  'reference__date',
  'reference__title'
]
const assayFields = [
  'structure_id',
  'structure_iri',
  'structure_type',
  'structure_description',
  'linear_sequence',
  'e_modification',
  'curated_source_antigen',
  'parent_source_antigen_iri',
  'parent_source_antigen_name',
  'host_organism_iri',
  'host_organism_name',
  'source_organism_iri',
  'source_organism_name',
  'mhc_allele_name',
  'mhc_class',
  'mhc_allele_evidence',
  'qualitative_measure',
  'assay_iris',
  'assay_names',
  'antibody_isotype',
  'direct_ex_vivo_bool',
  'disease_names',
  'epitope_structure_defined',
  'pdb_id',
  'reference_id',
  'reference_iri',
  'reference_type',
  'reference_titles',
  'reference_authors',
  'reference_dates',
  'journal_name',
  'pubmed_id',
  'submission_iri'
]

function columns(kind: Kind): string {
  if (assayKinds.has(kind)) {
    const evidence = [
      'assay__method',
      'assay__response_measured',
      'assay__units',
      'assay__measurement_inequality',
      'assay__quantitative_measurement',
      'assay__number_of_subjects_tested',
      'assay__response_frequency_',
      'assay__location_of_assay_data_in_reference',
      'assay__comments',
      kind === 'bcell' ? 'assay__qualitative_measure' : 'assay__qualitative_measurement',
      kind === 'mhc' ? 'assay__number_of_subjects_responded' : 'assay__number_of_subjects_positive'
    ]
    const context =
      kind === 'mhc'
        ? ['merged_host_imm_desc']
        : ['immunization_description', 'antigen_description', 'antigen_er']
    return [keys[kind], ...assayFields, ...context, `${kind}_export(${evidence.join(',')})`].join(
      ','
    )
  }
  const fields = [
    keys[kind],
    ...aggregateFields,
    ...(kind === 'reference' ? [] : literatureAggregateFields)
  ]
  if (kind !== 'antigen') fields.push('parent_source_antigen_iris')
  if (kind === 'epitope') {
    fields.push(
      'structure_iri',
      'structure_type',
      'structure_descriptions',
      'linear_sequence',
      'e_modification',
      'reference_ids',
      'reference_iris',
      'pubmed_ids'
    )
  } else if (kind === 'antigen') {
    fields.push(
      'parent_source_antigen_source_org_iri',
      'parent_source_antigen_source_org_name',
      'structure_ids',
      'reference_ids',
      'reference_iris',
      'pubmed_ids'
    )
  } else {
    fields.push(
      'reference_iri',
      'reference_title',
      'reference_title2',
      'reference_author',
      'reference_author2',
      'reference_date',
      'reference_date2',
      'journal_name',
      'pubmed_id',
      'submission_iris',
      'structure_ids',
      `reference_export(${referenceExportFields.join(',')})`
    )
  }
  return fields.join(',')
}

// Postgres array literals need their own quoting in addition to URL encoding.
const contains = (value: unknown): string => `cs.{${JSON.stringify(String(value))}}`
const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : []

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('IEDB returned an invalid record')
  }
  return value as Row
}

function crossReferences(row: Row): Row {
  const parent = strings(row.parent_source_antigen_iris ?? row.parent_source_antigen_iri)
  const curated =
    row.curated_source_antigens ?? (row.curated_source_antigen ? [row.curated_source_antigen] : [])
  const curatedIris = Array.isArray(curated)
    ? curated.flatMap((value) => strings(object(value).iri))
    : []
  const accessions = (iris: string[]): string[] => [
    ...new Set(
      iris.flatMap((iri) => {
        const match = new RegExp(
          `^(?:UNIPROT:|https?://(?:www\\.)?uniprot\\.org/uniprot/|https?://purl\\.uniprot\\.org/uniprot/)(${accessionPattern})$`,
          'i'
        ).exec(iri)
        return match ? [match[1].toUpperCase()] : []
      })
    )
  ]
  return {
    parent_uniprot_accessions: accessions(parent),
    curated_uniprot_accessions: accessions(curatedIris),
    pdb_ids: [...new Set(strings(row.pdb_ids ?? row.pdb_id).map((v) => v.toUpperCase()))]
  }
}

function properties(kind: Kind): Record<string, unknown> {
  const assay = assayKinds.has(kind)
  return {
    epitope_id: {
      ...id,
      description: 'IEDB epitope structure_id, not a PDB structure identifier.'
    },
    reference_id: { ...id, description: 'IEDB reference_id, not a PMID.' },
    host_taxonomy_id: {
      ...id,
      description: 'NCBI taxon of the experimental host, including descendants (9606 for human).'
    },
    source_taxonomy_id: {
      ...id,
      description:
        'NCBI taxon of the epitope source organism, including descendants; distinct from host.'
    },
    antigen_iri: {
      ...curie,
      description:
        'Exact parent antigen CURIE returned by IEDB, e.g. UNIPROT:P01012. Mutually exclusive with uniprot_accession.'
    },
    uniprot_accession: {
      type: 'string',
      pattern: `^${accessionPattern}(?![\\s\\S])`,
      description: 'Exact parent UniProt accession; no automatic isoform or alias conversion.'
    },
    mhc_allele: {
      ...text,
      description: 'Exact IEDB allele name, e.g. HLA-A*02:01. The asterisk is literal.'
    },
    mhc_class: { type: 'string', enum: ['I', 'II'] },
    qualitative_measure: {
      ...text,
      description:
        'Exact IEDB result, e.g. Negative, Positive, Positive-High. No result filter by default.'
    },
    assay_iri: {
      ...curie,
      description:
        'Assay ontology CURIE with descendants, e.g. OBI:0001489 for cellular MHC/mass spectrometry.'
    },
    pdb_id: {
      type: 'string',
      pattern: '^[0-9][A-Za-z0-9]{3}(?![\\s\\S])',
      description: 'Experimental PDB cross-reference, not an IEDB epitope ID.'
    },
    ...(kind === 'epitope' || assay
      ? {
          sequence: {
            type: 'string',
            pattern: '^[A-Za-z]+(?![\\s\\S])',
            maxLength: 1000,
            description: 'Exact linear peptide sequence (case normalized). Not a similarity search.'
          }
        }
      : {}),
    ...(assay ? { assay_id: { ...id, description: `IEDB ${keys[kind]}.` } } : {}),
    ...(kind === 'antigen'
      ? {
          antigen_name: {
            ...text,
            description:
              'Exact member of parent_source_antigen_names; use UniProt search to resolve protein names to accessions.'
          }
        }
      : {}),
    ...(kind === 'reference'
      ? { pubmed_id: { type: 'string', pattern: '^[1-9][0-9]*(?![\\s\\S])', maxLength: 12 } }
      : {}),
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, default: 0 }
  }
}

const labels: Record<Kind, string> = {
  epitope: 'epitopes',
  antigen: 'antigens',
  tcell: 'tcell_assays',
  bcell: 'bcell_assays',
  mhc: 'mhc_assays',
  reference: 'references'
}

function searchTool(kind: Kind): ToolDescriptor {
  const assay = assayKinds.has(kind)
  const inputProperties = properties(kind)
  const scalar = (single: string, plural: string): string => (assay ? single : plural)
  const description = assay
    ? `Search IEDB ${kind === 'tcell' ? 'T cell' : kind === 'bcell' ? 'B cell' : 'MHC binding and ligand elution'} experiments with host, source antigen, MHC and outcome filters. Includes ${kind}_export measurements, units, inequalities, methods, subject counts and publication locations. `
    : `Search IEDB ${labels[kind]} with epitope, host, antigen source, MHC and evidence filters. Aggregated filters can match different experiments in the same record; use assay searches to enforce co-occurrence in one experiment. `
  return {
    id: `search_${labels[kind]}`,
    connector: 'iedb',
    description:
      description +
      'At least one biological or evidence filter is required; limit and offset alone are not filters. ' +
      'Database observations, not predictions. Keep negative and missing results distinct. MHC ligand elution is not a binding affinity measurement; interpret response_measured, method and units together. ' +
      'Parent antigens are representative proteins and may not exactly match the curated antigen or epitope sequence. Use cross_references.parent_uniprot_accessions or curated_uniprot_accessions with host.mcp("genes", "get_uniprot_entries", {accessions:[...]}); use cross_references.pdb_ids with host.mcp("structures", "pdb_get_structures", {pdb_ids:[...]}). These are explicit upstream cross-references, not sequence-derived mappings. Load each matching connector skill before calling it.',
    input: {
      type: 'object',
      properties: inputProperties,
      anyOf: Object.keys(inputProperties)
        .filter((field) => field !== 'limit' && field !== 'offset')
        .map((field) => ({ properties: { [field]: {} }, required: [field] })),
      additionalProperties: false,
      not: {
        properties: { antigen_iri: {}, uniprot_accession: {} },
        required: ['antigen_iri', 'uniprot_accession']
      }
    },
    returns: `{source,query_url,limit,offset,returned,has_more,next_offset,records:[{...IEDB fields,${assay ? `${kind}_export:[{assay__method,assay__response_measured,assay__quantitative_measurement,assay__measurement_inequality,assay__units,...}],` : ''}cross_references:{parent_uniprot_accessions,curated_uniprot_accessions,pdb_ids}}]}. Upstream nulls and evidence values are preserved; optional fields may be absent. No exact total is requested. Follow next_offset with identical filters; order is by the unique IEDB key. Empty results mean no match for these filters. No automatic page traversal, local cache or external connector calls.`,
    example: `const result = await host.mcp("iedb", "search_${labels[kind]}", {"${kind === 'reference' ? 'reference_id' : kind === 'antigen' ? 'uniprot_accession' : 'epitope_id'}": ${kind === 'reference' ? '1023094' : kind === 'antigen' ? '"P01012"' : '25750'}, "limit": 20})`,
    run: async (ctx, args) => {
      const hasFilter = Object.keys(args).some((key) => key !== 'limit' && key !== 'offset')
      if (!hasFilter) {
        throw new Error('IEDB search requires at least one biological or evidence filter')
      }
      const limit = (args.limit ?? 20) as number
      const offset = (args.offset ?? 0) as number
      const params = new URLSearchParams({
        select: columns(kind),
        order: `${keys[kind]}.asc`,
        limit: String(limit + 1),
        offset: String(offset)
      })
      const filter = (
        arg: string,
        column: string,
        array = false,
        transform: (value: unknown) => string = String
      ): void => {
        if (args[arg] !== undefined) {
          const value = transform(args[arg])
          params.set(column, array ? contains(value) : `eq.${value}`)
        }
      }
      filter(
        'epitope_id',
        kind === 'epitope' || assay ? 'structure_id' : 'structure_ids',
        kind === 'antigen' || kind === 'reference'
      )
      filter(
        'reference_id',
        kind === 'reference' || assay ? 'reference_id' : 'reference_ids',
        kind === 'epitope' || kind === 'antigen'
      )
      filter('host_taxonomy_id', 'host_organism_iri_search', true, (v) => `NCBITaxon:${v}`)
      filter('source_taxonomy_id', 'source_organism_iri_search', true, (v) => `NCBITaxon:${v}`)
      const antigenColumn =
        kind === 'antigen' || assay ? 'parent_source_antigen_iri' : 'parent_source_antigen_iris'
      filter('antigen_iri', antigenColumn, !assay && kind !== 'antigen')
      filter(
        'uniprot_accession',
        antigenColumn,
        !assay && kind !== 'antigen',
        (v) => `UNIPROT:${v}`
      )
      filter('mhc_allele', scalar('mhc_allele_name', 'mhc_allele_names'), !assay)
      filter('mhc_class', scalar('mhc_class', 'mhc_classes'), !assay)
      filter('qualitative_measure', scalar('qualitative_measure', 'qualitative_measures'), !assay)
      filter('assay_iri', 'assay_iri_search', true)
      filter('pdb_id', scalar('pdb_id', 'pdb_ids'), !assay, (v) => String(v).toUpperCase())
      filter('sequence', 'linear_sequence', false, (v) => String(v).toUpperCase())
      filter('assay_id', keys[kind])
      filter('antigen_name', 'parent_source_antigen_names', true)
      filter('pubmed_id', 'pubmed_id')
      const url = `${API}/${kind}_search?${params}`
      const raw = await ctx.fetchJson(url)
      if (!Array.isArray(raw) || raw.length > limit + 1) {
        throw new Error('IEDB returned an invalid result page')
      }
      const rows = raw.map((value) => {
        const row = object(value)
        const key = row[keys[kind]]
        if (
          kind === 'antigen'
            ? typeof key !== 'string' || !key
            : typeof key !== 'number' || !Number.isSafeInteger(key) || key < 1
        ) {
          throw new Error(`IEDB record is missing ${keys[kind]}`)
        }
        if (assay && !Array.isArray(row[`${kind}_export`])) {
          throw new Error('IEDB record is missing assay export evidence')
        }
        return row
      })
      const hasMore = rows.length > limit
      if (hasMore && offset + limit > MAX_OFFSET) {
        throw new Error('IEDB pagination exceeds the offset limit; narrow the filters')
      }
      const records = rows.slice(0, limit).map((row) => ({
        ...row,
        cross_references: crossReferences(row)
      }))
      return {
        source: 'IEDB IQ-API',
        query_url: url,
        limit,
        offset,
        returned: records.length,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
        records
      }
    }
  }
}

export const IEDB_TOOLS: ToolDescriptor[] = (
  ['epitope', 'antigen', 'tcell', 'bcell', 'mhc', 'reference'] as const
).map(searchTool)
