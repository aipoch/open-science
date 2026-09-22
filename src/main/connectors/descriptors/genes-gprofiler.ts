import type { ToolContext, ToolDescriptor } from '../types'

const BASE = 'https://biit.cs.ut.ee/gprofiler/api'
const ORGANISM = /^[a-z][a-z0-9_]*$/u
const SOURCE = /^[A-Za-z0-9:_-]+$/u
// g:Profiler currently accepts custom and custom_annotated for an explicit background;
// custom_known is mentioned by some older docs but returns HTTP 400 from the live API.
const DOMAIN_SCOPES = ['annotated', 'known', 'custom', 'custom_annotated'] as const
const CORRECTION_METHODS = ['g_SCS', 'bonferroni', 'fdr'] as const

type Dict = Record<string, unknown>
type DomainScope = (typeof DOMAIN_SCOPES)[number]
type CorrectionMethod = (typeof CORRECTION_METHODS)[number]

const asRecord = (value: unknown, label: string): Dict => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`g:Profiler returned an invalid ${label} record`)
  }
  return value as Dict
}

const cleanList = (
  value: unknown,
  label: string,
  max: number,
  { allowDuplicates = false } = {}
): string[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`)
  const values = value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${label} must contain only non-empty strings`)
    }
    return entry.trim()
  })
  if (values.length === 0) throw new Error(`${label} must contain at least one value`)
  if (values.length > max) throw new Error(`${label} must contain at most ${max} values`)
  if (!allowDuplicates && new Set(values).size !== values.length)
    throw new Error(`${label} must not contain duplicates`)
  return values
}

const optionalList = (value: unknown, label: string, max: number): string[] | null => {
  if (value == null) return null
  return cleanList(value, label, max)
}

const organismId = (value: unknown): string => {
  const organism = typeof value === 'string' ? value.trim() : ''
  if (!ORGANISM.test(organism)) {
    throw new Error('organism must be a g:Profiler organism id such as hsapiens or mmusculus')
  }
  return organism
}

const sourceIds = (value: unknown): string[] => {
  if (value == null) return []
  if (Array.isArray(value) && value.length === 0) return []
  const sources = cleanList(value, 'sources', 100)
  for (const source of sources) {
    if (!SOURCE.test(source)) throw new Error(`invalid g:Profiler source id: ${source}`)
  }
  return sources
}

const domainScope = (value: unknown, hasBackground: boolean): DomainScope => {
  const requested = value == null || String(value).trim() === '' ? null : String(value).trim()
  const effective = requested ?? (hasBackground ? 'custom' : 'annotated')
  if (!DOMAIN_SCOPES.includes(effective as DomainScope)) {
    throw new Error(`domain_scope must be one of: ${DOMAIN_SCOPES.join(', ')}`)
  }
  const scope = effective as DomainScope
  if (hasBackground && !scope.startsWith('custom')) {
    throw new Error('background_genes requires a custom domain_scope')
  }
  if (scope.startsWith('custom') && !hasBackground) {
    throw new Error(`domain_scope '${scope}' requires background_genes`)
  }
  return scope
}

const correctionMethod = (value: unknown): CorrectionMethod => {
  const method = value == null || String(value).trim() === '' ? 'g_SCS' : String(value).trim()
  if (!CORRECTION_METHODS.includes(method as CorrectionMethod)) {
    throw new Error(`correction_method must be one of: ${CORRECTION_METHODS.join(', ')}`)
  }
  return method as CorrectionMethod
}

const optionalProbability = (value: unknown): number | undefined => {
  if (value == null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('user_threshold must be a number in (0, 1]')
  }
  return value
}

function normalizeSources(
  raw: unknown
): Array<{ id: string; name: string | null; version: string | null }> {
  const sources = asRecord(raw, 'sources')
  return Object.entries(sources).map(([id, value]) => {
    const row = asRecord(value, `source ${id}`)
    return {
      id,
      name: typeof row.name === 'string' ? row.name : null,
      version: typeof row.version === 'string' ? row.version : null
    }
  })
}

function enrichmentMetadata(response: Dict): Dict {
  const meta = response.meta
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? (meta as Dict) : {}
}

function geneMapping(meta: Dict): {
  mapping: Dict
  failed: string[]
  ambiguous: Dict
  duplicates: string[]
} {
  const genesMetadata = asRecord(meta.genes_metadata, 'genes_metadata')
  const query = asRecord(genesMetadata.query, 'query metadata')
  const queryOne = asRecord(query.query_1, 'query_1 metadata')
  const mapping =
    typeof queryOne.mapping === 'object' &&
    queryOne.mapping !== null &&
    !Array.isArray(queryOne.mapping)
      ? (queryOne.mapping as Dict)
      : {}
  const failed = Array.isArray(genesMetadata.failed)
    ? genesMetadata.failed.filter((value): value is string => typeof value === 'string')
    : []
  const ambiguous =
    typeof genesMetadata.ambiguous === 'object' &&
    genesMetadata.ambiguous !== null &&
    !Array.isArray(genesMetadata.ambiguous)
      ? (genesMetadata.ambiguous as Dict)
      : {}
  const duplicates = Array.isArray(genesMetadata.duplicates)
    ? genesMetadata.duplicates.filter((value): value is string => typeof value === 'string')
    : []
  return { mapping, failed, ambiguous, duplicates }
}

export const GENES_GPROFILER_TOOLS: ToolDescriptor[] = [
  {
    id: 'list_enrichment_sources',
    connector: 'genes',
    description:
      'List the g:Profiler enrichment sources and their current data versions for one organism. Sources are organism-dependent and include namespaces such as GO:BP, GO:MF, GO:CC, KEGG, Reactome, and WikiPathways when available. g:Profiler stores limited query metadata for service operation; this read-only lookup does not submit a gene list.',
    input: {
      type: 'object',
      properties: {
        organism: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_]*$' }
      },
      required: ['organism'],
      additionalProperties: false
    },
    required: ['organism'],
    returns:
      '{organism, display_name, scientific_name, taxonomy_id, version, gprofiler_version, sources:[{id,name,version}], nonnumeric_namespaces, numeric_namespaces}',
    example:
      'const result = await host.mcp("genes", "list_enrichment_sources", {"organism": "hsapiens"})',
    run: async (ctx, args) => {
      const organism = organismId(args.organism)
      const organismParams = new URLSearchParams({ organism, extra_data: 'true' })
      const versionParams = new URLSearchParams({ organism })
      const [organismRaw, versionsRaw] = await Promise.all([
        ctx.fetchJson(`${BASE}/util/organisms_list/?${organismParams.toString()}`),
        ctx.fetchJson(`${BASE}/util/data_versions/?${versionParams.toString()}`)
      ])
      if (!Array.isArray(organismRaw) || organismRaw.length === 0) {
        throw new Error(`g:Profiler returned no organism metadata for ${organism}`)
      }
      const organismInfo = asRecord(organismRaw[0], 'organism')
      const versions = asRecord(versionsRaw, 'data versions')
      return {
        organism,
        display_name:
          typeof organismInfo.display_name === 'string' ? organismInfo.display_name : null,
        scientific_name:
          typeof organismInfo.scientific_name === 'string' ? organismInfo.scientific_name : null,
        taxonomy_id: organismInfo.taxonomy_id ?? null,
        version: organismInfo.version ?? null,
        gprofiler_version: versions.gprofiler_version ?? null,
        sources: normalizeSources(versions.sources ?? {}),
        nonnumeric_namespaces: Array.isArray(organismInfo.nonnumeric_namespaces)
          ? organismInfo.nonnumeric_namespaces
          : [],
        numeric_namespaces: Array.isArray(organismInfo.numeric_namespaces)
          ? organismInfo.numeric_namespaces
          : []
      }
    }
  },
  {
    id: 'enrich_gene_set',
    connector: 'genes',
    description:
      'Run g:Profiler g:GOSt enrichment for a gene set across GO, Reactome, KEGG, WikiPathways, and other organism-supported sources. Supports an explicit organism, custom statistical background, under-representation testing, and g:Profiler multiple-testing correction. Unmapped, ambiguous, and duplicate identifiers are returned in metadata instead of being silently discarded.',
    input: {
      type: 'object',
      properties: {
        genes: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 5000
        },
        organism: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_]*$' },
        sources: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 },
        background_genes: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 20000
        },
        domain_scope: { type: 'string', enum: DOMAIN_SCOPES },
        correction_method: { type: 'string', enum: CORRECTION_METHODS, default: 'g_SCS' },
        user_threshold: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        all_results: { type: 'boolean', default: false },
        ordered: { type: 'boolean', default: false },
        measure_underrepresentation: { type: 'boolean', default: false },
        no_iea: { type: 'boolean', default: false },
        no_evidences: { type: 'boolean', default: false },
        numeric_ns: { type: 'string', minLength: 1, maxLength: 64 }
      },
      required: ['genes', 'organism'],
      additionalProperties: false
    },
    required: ['genes', 'organism'],
    returns:
      '{tool, organism, n_input, n_mapped (mapped input identifiers), n_unmapped, input_genes, mapped_genes, unmapped_genes, ambiguous_genes, duplicate_genes, background_size (submitted background length), domain_scope, sources (requested source IDs; [] means all available sources), correction_method, n_results, results:[{source,native,name,p_value,significant,intersection_size,term_size,query_size,effective_domain_size,precision,recall,intersections}], meta (actual sources are in meta.query_metadata.sources)}',
    example:
      'const result = await host.mcp("genes", "enrich_gene_set", {"genes": ["TP53", "EGFR", "BRCA1"], "organism": "hsapiens", "sources": ["GO:BP", "REAC"], "correction_method": "fdr"})',
    run: async (ctx: ToolContext, args) => {
      const genes = cleanList(args.genes, 'genes', 5000, { allowDuplicates: true })
      const background = optionalList(args.background_genes, 'background_genes', 20000)
      const organism = organismId(args.organism)
      const sources = sourceIds(args.sources)
      const scope = domainScope(args.domain_scope, background !== null)
      const method = correctionMethod(args.correction_method)
      const userThreshold = optionalProbability(args.user_threshold)
      const payload: Dict = {
        organism,
        query: genes,
        sources,
        domain_scope: scope,
        significance_threshold_method: method,
        all_results: args.all_results === true,
        ordered: args.ordered === true,
        measure_underrepresentation: args.measure_underrepresentation === true,
        no_iea: args.no_iea === true,
        no_evidences: args.no_evidences === true,
        output: 'json'
      }
      if (background) payload.background = background
      if (userThreshold !== undefined) payload.user_threshold = userThreshold
      if (args.numeric_ns != null && String(args.numeric_ns).trim() !== '') {
        payload.numeric_ns = String(args.numeric_ns).trim()
      }
      const response = asRecord(
        await ctx.postJson(`${BASE}/gost/profile/`, payload),
        'enrichment response'
      )
      if (!Array.isArray(response.result))
        throw new Error('g:Profiler enrichment response has no result list')
      const meta = enrichmentMetadata(response)
      const mapping = geneMapping(meta)
      return {
        tool: 'enrich_gene_set',
        organism,
        input_genes: genes,
        n_input: genes.length,
        n_mapped: Object.keys(mapping.mapping).length,
        n_unmapped: mapping.failed.length,
        mapped_genes: mapping.mapping,
        unmapped_genes: mapping.failed,
        ambiguous_genes: mapping.ambiguous,
        duplicate_genes: mapping.duplicates,
        background_size: background?.length ?? null,
        domain_scope: scope,
        sources,
        correction_method: method,
        n_results: response.result.length,
        results: response.result,
        meta
      }
    }
  }
]
