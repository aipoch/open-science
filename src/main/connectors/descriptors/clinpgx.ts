import type { ToolContext, ToolDescriptor } from '../types'

const API = 'https://api.clinpgx.org/v1'

function unwrap(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const envelope = raw as { status?: unknown; data?: unknown; message?: unknown }
  if ('status' in envelope) {
    if (envelope.status !== 'success') {
      const detail = typeof envelope.message === 'string' ? `: ${envelope.message}` : ''
      throw new Error(`ClinPGx API returned ${String(envelope.status)}${detail}`)
    }
    if (!('data' in envelope)) throw new Error('ClinPGx API success response did not include data')
    return envelope.data
  }
  return 'data' in envelope ? envelope.data : raw
}

function queryUrl(path: string, args: Record<string, unknown>, keys: string[]): string {
  const params = new URLSearchParams()
  for (const key of keys) {
    const value = args[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) params.set(key, trimmed)
    } else {
      params.set(key, String(value))
    }
  }
  const query = params.toString()
  return `${API}${path}${query ? `?${query}` : ''}`
}

function requireOne(args: Record<string, unknown>, keys: string[]): void {
  if (
    !keys.some((key) => {
      const value = args[key]
      return typeof value === 'string'
        ? value.trim().length > 0
        : value !== undefined && value !== null
    })
  ) {
    throw new Error(`provide at least one of ${keys.join(', ')}`)
  }
}

const nonBlankString = { type: 'string', minLength: 1, pattern: '\\S' }

const atLeastOne = (
  fields: string[]
): Array<{ properties: Record<string, object>; required: string[] }> =>
  fields.map((field) => ({ properties: { [field]: {} }, required: [field] }))

async function query(
  ctx: ToolContext,
  path: string,
  args: Record<string, unknown>,
  keys: string[],
  requiredKeys: string[] = keys
): Promise<unknown> {
  requireOne(args, requiredKeys)
  return ctx.fetchJson(queryUrl(path, args, keys)).then(unwrap)
}

async function queryWithGroups(
  ctx: ToolContext,
  path: string,
  args: Record<string, unknown>,
  keys: string[],
  requiredGroups: string[][]
): Promise<unknown> {
  for (const group of requiredGroups) requireOne(args, group)
  return ctx.fetchJson(queryUrl(path, args, keys)).then(unwrap)
}

function getById(
  path: string,
  idKey: string,
  view = true,
  idType: 'string' | 'positiveNumber' = 'string'
): (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown> {
  return (ctx, args) => {
    const rawId = args[idKey]
    if (idType === 'positiveNumber') {
      if (typeof rawId !== 'number' || !Number.isFinite(rawId) || rawId < 1) {
        throw new Error(`${idKey} must be a positive number`)
      }
    }
    const id = typeof rawId === 'string' ? rawId.trim() : String(rawId ?? '')
    if (!id) throw new Error(`${idKey} is required`)
    return ctx
      .fetchJson(queryUrl(`${path}/${encodeURIComponent(id)}`, args, view ? ['view'] : []))
      .then(unwrap)
  }
}

const viewProperty = { type: 'string', enum: ['min', 'base', 'max'], default: 'base' }

const summaryAnnotationProperties = {
  id: nonBlankString,
  'relatedChemicals.accessionId': nonBlankString,
  'relatedChemicals.name': nonBlankString,
  'location.genes.symbol': nonBlankString,
  'location.fingerprint': nonBlankString,
  view: viewProperty
}

const variantAnnotationProperties = {
  'location.genes.symbol': nonBlankString,
  'location.fingerprint': nonBlankString,
  view: viewProperty
}

export const CLINPGX_TOOLS: ToolDescriptor[] = [
  {
    id: 'clinpgx_search_chemicals',
    connector: 'clinical-genomics',
    description:
      'Resolve ClinPGx drug/chemical records by ClinPGx accession id or name before querying pharmacogenomic annotations.',
    input: {
      type: 'object',
      properties: { accessionId: nonBlankString, name: nonBlankString, view: viewProperty },
      anyOf: atLeastOne(['accessionId', 'name']),
      additionalProperties: false
    },
    returns:
      '`ClinPGx Chemical` JSON array/object with drug names, identifiers, and cross references.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_search_chemicals", {"name": "warfarin", "view": "max"})',
    run: (ctx, args) =>
      query(ctx, '/data/chemical', args, ['accessionId', 'name', 'view'], ['accessionId', 'name'])
  },
  {
    id: 'clinpgx_search_genes',
    connector: 'clinical-genomics',
    description:
      'Resolve ClinPGx gene records by ClinPGx accession id or HGNC symbol before querying pharmacogenomic annotations.',
    input: {
      type: 'object',
      properties: {
        accessionId: nonBlankString,
        symbol: nonBlankString,
        view: viewProperty
      },
      anyOf: atLeastOne(['accessionId', 'symbol']),
      additionalProperties: false
    },
    returns:
      '`ClinPGx Gene` JSON array/object with gene symbols, identifiers, and cross references.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_search_genes", {"symbol": "VKORC1", "view": "max"})',
    run: (ctx, args) =>
      query(ctx, '/data/gene', args, ['accessionId', 'symbol', 'view'], ['accessionId', 'symbol'])
  },
  {
    id: 'clinpgx_search_summary_annotations',
    connector: 'clinical-genomics',
    description:
      'Search ClinPGx clinical annotations linking a drug, gene, and variant. Supports CPIC-style evidence levels 1A, 1B, 2A, 2B, 3, and 4.',
    input: {
      type: 'object',
      properties: {
        ...summaryAnnotationProperties,
        'levelOfEvidence.term': { type: 'string', enum: ['1A', '1B', '2A', '2B', '3', '4'] }
      },
      anyOf: atLeastOne([
        'relatedChemicals.accessionId',
        'relatedChemicals.name',
        'location.genes.symbol',
        'location.fingerprint',
        'id'
      ]),
      additionalProperties: false
    },
    returns:
      '`ClinPGx summaryAnnotation` JSON array/object with drug, gene, variant, phenotype, and level-of-evidence fields.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_search_summary_annotations", {"relatedChemicals.name": "warfarin", "location.genes.symbol": "VKORC1", "levelOfEvidence.term": "1A", "view": "max"})',
    run: (ctx, args) =>
      query(
        ctx,
        '/data/summaryAnnotation',
        args,
        [
          'id',
          'relatedChemicals.accessionId',
          'relatedChemicals.name',
          'location.genes.symbol',
          'location.fingerprint',
          'levelOfEvidence.term',
          'view'
        ],
        [
          'relatedChemicals.accessionId',
          'relatedChemicals.name',
          'location.genes.symbol',
          'location.fingerprint',
          'id'
        ]
      )
  },
  {
    id: 'clinpgx_get_summary_annotation',
    connector: 'clinical-genomics',
    description:
      'Retrieve one ClinPGx clinical annotation by its numeric ClinPGx record id, including linked drug, gene, variant, phenotype, and evidence level.',
    input: {
      type: 'object',
      properties: { id: { type: 'number', minimum: 1 }, view: viewProperty },
      required: ['id'],
      additionalProperties: false
    },
    required: ['id'],
    returns: '`ClinPGx summaryAnnotation` object.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_get_summary_annotation", {"id": 655385012, "view": "max"})',
    run: getById('/data/summaryAnnotation', 'id', true, 'positiveNumber')
  },
  {
    id: 'clinpgx_search_variant_annotations',
    connector: 'clinical-genomics',
    description:
      'Search ClinPGx variant annotations by gene symbol or variant fingerprint (commonly an rsID).',
    input: {
      type: 'object',
      properties: variantAnnotationProperties,
      anyOf: atLeastOne(['location.genes.symbol', 'location.fingerprint']),
      additionalProperties: false
    },
    returns:
      '`ClinPGx variantAnnotation` JSON array/object with variant-level pharmacogenomic annotations.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_search_variant_annotations", {"location.fingerprint": "rs1799853", "view": "max"})',
    run: (ctx, args) =>
      query(
        ctx,
        '/data/variantAnnotation',
        args,
        ['location.genes.symbol', 'location.fingerprint', 'view'],
        ['location.genes.symbol', 'location.fingerprint']
      )
  },
  {
    id: 'clinpgx_search_guideline_annotations',
    connector: 'clinical-genomics',
    description:
      'Search ClinPGx pharmacogenomic dosing guideline annotations from CPIC, DPWG, or PharmGKB/PRO.',
    input: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['cpic', 'dpwg', 'pro'] },
        'relatedChemicals.accessionId': nonBlankString,
        'relatedGenes.accessionId': nonBlankString,
        view: viewProperty
      },
      anyOf: atLeastOne(['source', 'relatedChemicals.accessionId', 'relatedGenes.accessionId']),
      additionalProperties: false
    },
    returns:
      '`ClinPGx guidelineAnnotation` JSON array/object with source, drug, gene, recommendation, and strength fields.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_search_guideline_annotations", {"source": "cpic", "relatedGenes.accessionId": "PA267", "view": "max"})',
    run: (ctx, args) =>
      query(
        ctx,
        '/data/guidelineAnnotation',
        args,
        ['source', 'relatedChemicals.accessionId', 'relatedGenes.accessionId', 'view'],
        ['source', 'relatedChemicals.accessionId', 'relatedGenes.accessionId']
      )
  },
  {
    id: 'clinpgx_search_drug_labels',
    connector: 'clinical-genomics',
    description:
      'Search ClinPGx regulatory pharmacogenomic drug labels from FDA, EMA, PMDA, or Health Canada.',
    input: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['fda', 'ema', 'pmda', 'hcsc'] },
        'relatedChemicals.accessionId': nonBlankString,
        'relatedChemicals.name': nonBlankString,
        'relatedGenes.accessionId': nonBlankString,
        'relatedGenes.symbol': nonBlankString,
        view: viewProperty
      },
      anyOf: atLeastOne([
        'source',
        'relatedChemicals.accessionId',
        'relatedChemicals.name',
        'relatedGenes.accessionId',
        'relatedGenes.symbol'
      ]),
      additionalProperties: false
    },
    returns:
      '`ClinPGx label` JSON array/object with regulatory label text and linked drug/gene records.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_search_drug_labels", {"source": "fda", "relatedChemicals.name": "clopidogrel", "view": "max"})',
    run: (ctx, args) =>
      query(
        ctx,
        '/data/label',
        args,
        [
          'source',
          'relatedChemicals.accessionId',
          'relatedChemicals.name',
          'relatedGenes.accessionId',
          'relatedGenes.symbol',
          'view'
        ],
        [
          'source',
          'relatedChemicals.accessionId',
          'relatedChemicals.name',
          'relatedGenes.accessionId',
          'relatedGenes.symbol'
        ]
      )
  },
  {
    id: 'clinpgx_search_variants',
    connector: 'clinical-genomics',
    description:
      'Resolve ClinPGx pharmacogenomic variants by dbSNP rsID or another variant symbol.',
    input: {
      type: 'object',
      properties: { symbol: nonBlankString, view: viewProperty },
      required: ['symbol'],
      additionalProperties: false
    },
    required: ['symbol'],
    returns:
      '`ClinPGx variant` JSON array/object with variant identifiers, fingerprints, genes, and alleles.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_search_variants", {"symbol": "rs1799853", "view": "max"})',
    run: (ctx, args) => query(ctx, '/data/variant/', args, ['symbol', 'view'], ['symbol'])
  },
  {
    id: 'clinpgx_get_variant_frequency',
    connector: 'clinical-genomics',
    description:
      'Retrieve population variant frequencies reported by ClinPGx for a variant fingerprint such as an rsID.',
    input: {
      type: 'object',
      properties: { fp: nonBlankString },
      required: ['fp'],
      additionalProperties: false
    },
    required: ['fp'],
    returns: '`ClinPGx variantFrequency` JSON object keyed by population/resource.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_get_variant_frequency", {"fp": "rs1799853"})',
    url: (args) => queryUrl('/report/variantFrequency', args, ['fp']),
    parse: unwrap
  },
  {
    id: 'clinpgx_get_drug_gene_variant',
    connector: 'clinical-genomics',
    description:
      'Query a pairwise ClinPGx connection between two objects (for example, a drug and a gene) using the shared connection report; provide one identifier for each object. Use summary annotations for a drug-gene-variant clinical annotation.',
    input: {
      type: 'object',
      properties: {
        object1Id: nonBlankString,
        object1Name: nonBlankString,
        object1Type: nonBlankString,
        object2Id: nonBlankString,
        object2Name: nonBlankString,
        object2Type: nonBlankString,
        view: viewProperty
      },
      allOf: [
        { anyOf: atLeastOne(['object1Id', 'object1Name', 'object1Type']) },
        { anyOf: atLeastOne(['object2Id', 'object2Name', 'object2Type']) }
      ],
      additionalProperties: false
    },
    returns:
      '`ClinPGx connection` JSON array/object containing relationships between two pharmacogenomic objects.',
    example:
      'const result = await host.mcp("clinical-genomics", "clinpgx_get_drug_gene_variant", {"object1Name": "warfarin", "object1Type": "chemical", "object2Name": "VKORC1", "object2Type": "gene", "view": "max"})',
    run: (ctx, args) =>
      queryWithGroups(
        ctx,
        '/data/connection',
        args,
        [
          'object1Id',
          'object1Name',
          'object1Type',
          'object2Id',
          'object2Name',
          'object2Type',
          'view'
        ],
        [
          ['object1Id', 'object1Name', 'object1Type'],
          ['object2Id', 'object2Name', 'object2Type']
        ]
      )
  }
]
