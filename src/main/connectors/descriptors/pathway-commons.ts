import type { ToolContext, ToolDescriptor } from '../../connector-core/types'

// Pathway Commons PC2 v14. The legacy GET routes remain the most useful transport here because
// graph and export queries can return BioPAX/GSEA/SIF text rather than JSON.
const BASE = 'https://www.pathwaycommons.org/pc2'
const MAX_LIST = 100
const MAX_QUERY_LENGTH = 512
const MAX_GRAPH_RESPONSE_BYTES = 4_000_000

const FORMATS = ['BIOPAX', 'SIF', 'TXT', 'GSEA', 'SBGN', 'JSONLD'] as const
type Format = (typeof FORMATS)[number]
const GRAPH_KINDS = ['NEIGHBORHOOD', 'PATHSBETWEEN', 'PATHSFROMTO', 'COMMONSTREAM'] as const
type GraphKind = (typeof GRAPH_KINDS)[number]
const DIRECTIONS = ['UPSTREAM', 'DOWNSTREAM', 'BOTHSTREAM', 'UNDIRECTED'] as const
type Direction = (typeof DIRECTIONS)[number]
const LIMIT_TYPES = ['NORMAL', 'SHORTEST_PLUS_K'] as const
const PATTERNS = [
  'CONTROLS_STATE_CHANGE_OF',
  'CONTROLS_TRANSPORT_OF',
  'CONTROLS_PHOSPHORYLATION_OF',
  'CONTROLS_EXPRESSION_OF',
  'CATALYSIS_PRECEDES',
  'IN_COMPLEX_WITH',
  'INTERACTS_WITH',
  'NEIGHBOR_OF',
  'CONSUMPTION_CONTROLLED_BY',
  'CONTROLS_PRODUCTION_OF',
  'CONTROLS_TRANSPORT_OF_CHEMICAL',
  'CHEMICAL_AFFECTS',
  'REACTS_WITH',
  'USED_TO_PRODUCE'
] as const

type Dict = Record<string, unknown>

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const stringList = (value: unknown, label: string, max = MAX_LIST): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one value`)
  }
  if (value.length > max) throw new Error(`${label} must contain at most ${max} values`)
  const result = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${label} must contain only non-empty strings`)
    }
    return entry.trim()
  })
  if (new Set(result).size !== result.length)
    throw new Error(`${label} must not contain duplicates`)
  return result
}

const optionalStringList = (value: unknown, label: string, max = 20): string[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`)
  if (value.length > max) throw new Error(`${label} must contain at most ${max} values`)
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${label} must contain only non-empty strings`)
    }
    return entry.trim()
  })
}

const boundedQuery = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  const query = value.trim()
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_QUERY_LENGTH} characters`)
  }
  return query
}

const enumValue = <T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T
): T[number] => {
  const normalized = value == null ? values[0] : String(value).trim().toUpperCase()
  if (!values.includes(normalized as T[number])) {
    throw new Error(`${label} must be one of: ${values.join(', ')}`)
  }
  return normalized as T[number]
}

const positiveInteger = (value: unknown, label: string, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`)
  }
  return value as number
}

const pageNumber = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10000) {
    throw new Error('page must be an integer between 0 and 10000')
  }
  return value as number
}

function queryUrl(
  path: string,
  params: Array<[string, string | number | boolean | undefined]>
): string {
  const query = new URLSearchParams()
  for (const [key, value] of params) {
    if (value === undefined) continue
    query.append(key, String(value))
  }
  return `${BASE}${path}?${query.toString()}`
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Pathway Commons ${label} must be a non-empty string`)
  }
  return value
}

function arrayField(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`Pathway Commons ${label} must be an array of strings`)
  if (value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Pathway Commons ${label} must contain only strings`)
  }
  return value as string[]
}

function searchResults(
  raw: unknown,
  label: string
): { total: number; pageSize: number; results: Dict[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Pathway Commons returned an invalid ${label} response`)
  }
  const payload = raw as Dict
  const hits = payload.searchHit
  if (!Array.isArray(hits))
    throw new Error(`Pathway Commons ${label} response has no searchHit list`)
  const results = hits.map((hit, index) => {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) {
      throw new Error(`Pathway Commons ${label} result ${index + 1} is malformed`)
    }
    const row = hit as Dict
    return {
      uri: requiredString(row.uri, `${label} result ${index + 1} uri`),
      biopax_class: requiredString(row.biopaxClass, `${label} result ${index + 1} biopaxClass`),
      name: stringValue(row.name),
      data_sources: arrayField(row.dataSource, `${label} result ${index + 1} dataSource`),
      organisms: arrayField(row.organism, `${label} result ${index + 1} organism`),
      pathways: arrayField(row.pathway, `${label} result ${index + 1} pathway`),
      excerpt: stringValue(row.excerpt),
      n_participants: typeof row.numParticipants === 'number' ? row.numParticipants : null,
      n_processes: typeof row.numProcesses === 'number' ? row.numProcesses : null
    }
  })
  return {
    total: typeof payload.numHits === 'number' ? payload.numHits : results.length,
    pageSize: typeof payload.maxHitsPerPage === 'number' ? payload.maxHitsPerPage : results.length,
    results
  }
}

async function fetchJson(ctx: ToolContext, url: string): Promise<unknown> {
  const text = await ctx.fetchText(url, 'application/json')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Pathway Commons returned invalid JSON')
  }
}

async function fetchExport(ctx: ToolContext, url: string, format: Format): Promise<unknown> {
  const text = await ctx.fetchText(url, format === 'JSONLD' ? 'application/ld+json' : 'text/plain')
  if (format === 'JSONLD') {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Pathway Commons returned invalid JSON-LD')
    }
  }
  return text
}

const nonEmptyLines = (section: string): string[] =>
  section.split(/\r?\n/u).filter((line) => line.trim())

const splitReferences = (value: string): string[] =>
  value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)

function parseTxt(content: string): Dict {
  if (!content.trim()) return { n_records: 0, records: [], n_nodes: 0, nodes: [] }
  const sections = content
    .split(/\r?\n\s*\r?\n/u)
    .map((section) => nonEmptyLines(section))
    .filter((section) => section.length > 0)
  if (sections.length < 2) {
    throw new Error('Pathway Commons TXT export must contain edge and node sections')
  }

  const edgeHeader = [
    'PARTICIPANT_A',
    'INTERACTION_TYPE',
    'PARTICIPANT_B',
    'INTERACTION_DATA_SOURCE',
    'INTERACTION_PUBMED_ID',
    'PATHWAY_NAMES',
    'MEDIATOR_IDS'
  ]
  const nodeHeader = [
    'PARTICIPANT',
    'PARTICIPANT_TYPE',
    'PARTICIPANT_NAME',
    'UNIFICATION_XREF',
    'RELATIONSHIP_XREF'
  ]
  if (sections[0][0] !== edgeHeader.join('\t')) {
    throw new Error('Pathway Commons TXT edge header is malformed')
  }
  if (sections[1][0] !== nodeHeader.join('\t')) {
    throw new Error('Pathway Commons TXT node header is malformed')
  }

  const records = sections[0].slice(1).map((line, index) => {
    const fields = line.split('\t')
    if (fields.length < edgeHeader.length || !fields[0] || !fields[1] || !fields[2]) {
      throw new Error(`Pathway Commons TXT edge record ${index + 1} is malformed`)
    }
    return {
      source: fields[0],
      interaction: fields[1],
      target: fields[2],
      data_source: fields[3],
      pubmed_id: fields[4],
      pathway_names: fields[5],
      mediator_ids: fields[6]
    }
  })
  const nodes = sections[1].slice(1).map((line, index) => {
    const fields = line.split('\t')
    if (fields.length < nodeHeader.length || !fields[0]) {
      throw new Error(`Pathway Commons TXT node record ${index + 1} is malformed`)
    }
    return {
      participant: fields[0],
      participant_type: fields[1],
      participant_name: fields[2],
      unification_xrefs: splitReferences(fields[3]),
      relationship_xrefs: splitReferences(fields[4])
    }
  })
  return { n_records: records.length, records, n_nodes: nodes.length, nodes }
}

function textSummary(format: Format, content: string): Dict {
  const lines = nonEmptyLines(content)
  if (format === 'SIF') {
    const records = lines.map((line, index) => {
      const fields = line.split('\t')
      if (fields.length < 2) throw new Error(`Pathway Commons SIF record ${index + 1} is malformed`)
      return { source: fields[0], interaction: fields[1], targets: fields.slice(2) }
    })
    return { n_records: records.length, records }
  }
  if (format === 'TXT') return parseTxt(content)
  if (format === 'GSEA') return { n_gene_sets: lines.length, content }
  return { content }
}

const searchInput = {
  type: 'object',
  properties: {
    q: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
    type: { type: 'string', minLength: 1, maxLength: 64 },
    organism: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
    datasource: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
    page: { type: 'integer', minimum: 0, maximum: 10000, default: 0 }
  },
  required: ['q'],
  additionalProperties: false
}

const graphInput = {
  type: 'object',
  properties: {
    source: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      maxItems: MAX_LIST
    },
    target: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      maxItems: MAX_LIST
    },
    kind: { type: 'string', enum: GRAPH_KINDS, default: 'NEIGHBORHOOD' },
    format: { type: 'string', enum: FORMATS, default: 'SIF' },
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
    direction: { type: 'string', enum: DIRECTIONS },
    limit_type: { type: 'string', enum: LIMIT_TYPES, default: 'NORMAL' },
    pattern: {
      type: 'array',
      items: { type: 'string', enum: PATTERNS },
      maxItems: PATTERNS.length
    },
    organism: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
    datasource: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
    subpathways: { type: 'boolean', default: false }
  },
  required: ['source'],
  additionalProperties: false
}

const exportInput = {
  type: 'object',
  properties: {
    uri: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      maxItems: MAX_LIST
    },
    format: { type: 'string', enum: FORMATS, default: 'BIOPAX' },
    pattern: {
      type: 'array',
      items: { type: 'string', enum: PATTERNS },
      maxItems: PATTERNS.length
    },
    subpathways: { type: 'boolean', default: false }
  },
  required: ['uri'],
  additionalProperties: false
}

export const PATHWAY_COMMONS_TOOLS: ToolDescriptor[] = [
  {
    id: 'pathway_commons_search',
    connector: 'pathway-commons',
    description:
      'Search the Pathway Commons BioPAX model by gene/protein/pathway keyword or Lucene query. Results include BioPAX class, URI, source databases, organism, and pathway metadata. Use the returned URI as input to graph or export queries.',
    input: searchInput,
    required: ['q'],
    returns:
      '{tool, query, page, total_hits, page_size, results:[{uri,biopax_class,name,data_sources,organisms,pathways,excerpt,n_participants,n_processes}]}',
    example:
      'const result = await host.mcp("pathway-commons", "pathway_commons_search", {"q": "TP53", "type": "ProteinReference", "organism": ["9606"]})',
    run: async (ctx, args) => {
      const q = boundedQuery(args.q, 'q')
      const organisms = optionalStringList(args.organism, 'organism')
      const datasources = optionalStringList(args.datasource, 'datasource')
      const page = args.page === undefined ? 0 : pageNumber(args.page)
      const params: Array<[string, string | number | boolean | undefined]> = [
        ['q', q],
        ['format', 'JSON'],
        ['page', page]
      ]
      if (typeof args.type === 'string' && args.type.trim()) params.push(['type', args.type.trim()])
      for (const value of organisms) params.push(['organism', value])
      for (const value of datasources) params.push(['datasource', value])
      const parsed = searchResults(await fetchJson(ctx, queryUrl('/search', params)), 'search')
      return {
        tool: 'pathway_commons_search',
        query: q,
        page,
        total_hits: parsed.total,
        page_size: parsed.pageSize,
        results: parsed.results
      }
    }
  },
  {
    id: 'pathway_commons_top_pathways',
    connector: 'pathway-commons',
    description:
      'Find top-level pathways in Pathway Commons matching a keyword or Lucene query, optionally restricted to a species or source such as Reactome.',
    input: {
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
        organism: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
        datasource: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 }
      },
      required: ['q'],
      additionalProperties: false
    },
    required: ['q'],
    returns:
      '{tool, query, total_hits, results:[{uri,name,data_sources,organisms,n_participants,n_processes}]}',
    example:
      'const result = await host.mcp("pathway-commons", "pathway_commons_top_pathways", {"q": "insulin", "datasource": ["reactome"], "organism": ["9606"]})',
    run: async (ctx, args) => {
      const q = boundedQuery(args.q, 'q')
      const organisms = optionalStringList(args.organism, 'organism')
      const datasources = optionalStringList(args.datasource, 'datasource')
      const params: Array<[string, string | number | boolean | undefined]> = [
        ['q', q],
        ['format', 'JSON']
      ]
      for (const value of organisms) params.push(['organism', value])
      for (const value of datasources) params.push(['datasource', value])
      const parsed = searchResults(
        await fetchJson(ctx, queryUrl('/top_pathways', params)),
        'top_pathways'
      )
      return {
        tool: 'pathway_commons_top_pathways',
        query: q,
        total_hits: parsed.total,
        results: parsed.results.map(
          ({ uri, name, data_sources, organisms, n_participants, n_processes }) => ({
            uri,
            name,
            data_sources,
            organisms,
            n_participants,
            n_processes
          })
        )
      }
    }
  },
  {
    id: 'pathway_commons_graph',
    connector: 'pathway-commons',
    description:
      'Run a Pathway Commons BioPAX graph query for a gene neighborhood, paths between gene sets, directed paths from sources to targets, or a common upstream/downstream stream. SIF results are normalized as interaction records, TXT results include edge and node records, and GSEA/BioPAX/SBGN exports remain available as text.',
    input: graphInput,
    required: ['source'],
    totalTimeoutMs: 45_000,
    maxResponseBytes: MAX_GRAPH_RESPONSE_BYTES,
    returns:
      '{tool,kind,format,source,target?,n_records?,records?,n_nodes?,nodes?,n_gene_sets?,content?}; format SIF/TXT returns normalized records, TXT also returns node attributes, and GSEA/BIOPAX/SBGN returns export content.',
    example:
      'const result = await host.mcp("pathway-commons", "pathway_commons_graph", {"kind": "NEIGHBORHOOD", "source": ["TP53"], "format": "SIF", "pattern": ["INTERACTS_WITH"]})',
    run: async (ctx, args) => {
      const source = stringList(args.source, 'source')
      const kind = enumValue(args.kind, 'kind', GRAPH_KINDS) as GraphKind
      const format = (
        args.format === undefined ? 'SIF' : enumValue(args.format, 'format', FORMATS)
      ) as Format
      const target = args.target === undefined ? [] : stringList(args.target, 'target')
      if (kind === 'PATHSFROMTO' && target.length === 0)
        throw new Error('target is required for PATHSFROMTO')
      if (kind !== 'PATHSFROMTO' && target.length > 0)
        throw new Error('target is only valid for PATHSFROMTO')
      const direction =
        args.direction === undefined
          ? undefined
          : (enumValue(args.direction, 'direction', DIRECTIONS) as Direction)
      if (direction !== undefined && kind !== 'NEIGHBORHOOD' && kind !== 'COMMONSTREAM') {
        throw new Error('direction is only valid for NEIGHBORHOOD or COMMONSTREAM')
      }
      if (
        direction !== undefined &&
        kind === 'COMMONSTREAM' &&
        direction !== 'UPSTREAM' &&
        direction !== 'DOWNSTREAM'
      ) {
        throw new Error('COMMONSTREAM direction must be UPSTREAM or DOWNSTREAM')
      }
      const limitType = enumValue(args.limit_type, 'limit_type', LIMIT_TYPES)
      if (limitType !== 'NORMAL' && kind !== 'PATHSFROMTO')
        throw new Error('limit_type is only valid for PATHSFROMTO')
      const limit =
        args.limit === undefined ? 1 : positiveInteger(args.limit as number, 'limit', 10)
      const patterns = optionalStringList(args.pattern, 'pattern', PATTERNS.length)
      for (const pattern of patterns)
        if (!PATTERNS.includes(pattern as (typeof PATTERNS)[number]))
          throw new Error(`pattern must be one of: ${PATTERNS.join(', ')}`)
      const organisms = optionalStringList(args.organism, 'organism')
      const datasources = optionalStringList(args.datasource, 'datasource')
      const params: Array<[string, string | number | boolean | undefined]> = [
        ['kind', kind],
        ['format', format],
        ['limit', limit],
        ['subpw', args.subpathways === true]
      ]
      for (const value of source) params.push(['source', value])
      for (const value of target) params.push(['target', value])
      if (direction !== undefined) params.push(['direction', direction])
      if (kind === 'PATHSFROMTO') params.push(['limitType', limitType])
      for (const pattern of patterns) params.push(['pattern', pattern])
      for (const organism of organisms) params.push(['organism', organism])
      for (const datasource of datasources) params.push(['datasource', datasource])
      const content = await fetchExport(ctx, queryUrl('/graph', params), format)
      if (typeof content === 'string') {
        return {
          tool: 'pathway_commons_graph',
          kind,
          format,
          source,
          ...(target.length ? { target } : {}),
          ...textSummary(format, content)
        }
      }
      return {
        tool: 'pathway_commons_graph',
        kind,
        format,
        source,
        ...(target.length ? { target } : {}),
        content
      }
    }
  },
  {
    id: 'pathway_commons_export',
    connector: 'pathway-commons',
    description:
      'Fetch a BioPAX sub-model for one or more Pathway Commons IDs/URIs and export it as BioPAX, GSEA GMT, JSON-LD, SIF, TXT, or SBGN. Use a URI returned by search/top_pathways for precise pathway export.',
    input: exportInput,
    required: ['uri'],
    totalTimeoutMs: 45_000,
    maxResponseBytes: MAX_GRAPH_RESPONSE_BYTES,
    returns:
      '{tool,format,uri,n_records?,records?,n_nodes?,nodes?,n_gene_sets?,content?}; TXT includes edge and node records, and GSEA content is a GMT export string.',
    example:
      'const result = await host.mcp("pathway-commons", "pathway_commons_export", {"uri": ["R-HSA-201451"], "format": "GSEA"})',
    run: async (ctx, args) => {
      const uri = stringList(args.uri, 'uri')
      const format = enumValue(args.format, 'format', FORMATS) as Format
      const patterns = optionalStringList(args.pattern, 'pattern', PATTERNS.length)
      for (const pattern of patterns)
        if (!PATTERNS.includes(pattern as (typeof PATTERNS)[number]))
          throw new Error(`pattern must be one of: ${PATTERNS.join(', ')}`)
      const params: Array<[string, string | number | boolean | undefined]> = [
        ['format', format],
        ['subpw', args.subpathways === true]
      ]
      for (const value of uri) params.push(['uri', value])
      for (const pattern of patterns) params.push(['pattern', pattern])
      const content = await fetchExport(ctx, queryUrl('/get', params), format)
      return {
        tool: 'pathway_commons_export',
        format,
        uri,
        ...(typeof content === 'string' ? textSummary(format, content) : { content })
      }
    }
  }
]
