import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { objectInput, officialFileLinks, provenance } from './official-file-links'

const identifier = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[^,\\r\\n]+$' }
const identifiers = { type: 'array', minItems: 1, maxItems: 200, items: identifier }
const node = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9 _-]+$' }
const taxon = { type: 'integer', minimum: 1, maximum: 100000000, default: 9606 }
const BIO = 'https://biodbnet-abcc.ncifcrf.gov/webServices/rest.php/biodbnetRestApi.json'

// REST identifiers/types are supplied by the discovery methods, never inferred from a
// zero-hit conversion. Each request is handled by the existing engine transport policy.
type BioMethod = {
  id: string
  method: string
  properties: Record<string, unknown>
  required: string[]
  example: Record<string, unknown>
  params: (args: Record<string, unknown>) => Record<string, string>
}
const bioMethods: BioMethod[] = [
  {
    id: 'list_input_types',
    method: 'getinputs',
    properties: {},
    required: [],
    example: {},
    params: () => ({})
  },
  {
    id: 'list_output_types',
    method: 'getoutputsforinput',
    properties: { input_type: node },
    required: ['input_type'],
    example: { input_type: 'genesymbol' },
    params: (a: Record<string, unknown>) => ({ input: String(a.input_type) })
  },
  {
    id: 'convert_ids',
    method: 'db2db',
    properties: {
      input_type: node,
      values: identifiers,
      outputs: { type: 'array', minItems: 1, maxItems: 20, items: node },
      taxon_id: taxon
    },
    required: ['input_type', 'values', 'outputs'],
    example: { input_type: 'genesymbol', values: ['TP53'], outputs: ['geneid'], taxon_id: 9606 },
    params: (a: Record<string, unknown>) => ({
      input: String(a.input_type),
      inputValues: (a.values as string[]).join(','),
      outputs: (a.outputs as string[]).join(','),
      taxonId: String(a.taxon_id ?? 9606),
      format: 'row'
    })
  },
  {
    id: 'recognize_ids',
    method: 'dbfind',
    properties: { values: identifiers, output_type: node, taxon_id: taxon },
    required: ['values', 'output_type'],
    example: { values: ['TP53'], output_type: 'geneid' },
    params: (a: Record<string, unknown>) => ({
      inputValues: (a.values as string[]).join(','),
      output: String(a.output_type),
      taxonId: String(a.taxon_id ?? 9606),
      format: 'row'
    })
  },
  {
    id: 'map_orthologs',
    method: 'dbortho',
    properties: {
      input_type: node,
      values: identifiers,
      input_taxon: taxon,
      output_taxon: { ...taxon, default: 10090 },
      output_type: node
    },
    required: ['input_type', 'values', 'output_type'],
    example: {
      input_type: 'genesymbol',
      values: ['TP53'],
      output_type: 'genesymbol',
      input_taxon: 9606,
      output_taxon: 10090
    },
    params: (a: Record<string, unknown>) => ({
      input: String(a.input_type),
      inputValues: (a.values as string[]).join(','),
      output: String(a.output_type),
      inputTaxon: String(a.input_taxon ?? 9606),
      outputTaxon: String(a.output_taxon ?? 10090),
      format: 'row'
    })
  },
  {
    id: 'list_pathways',
    method: 'getpathways',
    properties: { taxon_id: taxon },
    required: [],
    example: { taxon_id: 9606 },
    params: (a: Record<string, unknown>) => ({ pathways: '1', taxonId: String(a.taxon_id ?? 9606) })
  }
]

export const MOLECULAR_DATA_TOOLS: ToolDescriptor[] = [
  ...bioMethods.map(
    (method): ToolDescriptor => ({
      id: method.id,
      connector: 'biodbnet',
      credentialKeys: [],
      description: `Call the official bioDBnet ${method.method} REST operation. Discover supported node names before conversion. Preserve unmapped inputs and multiple outputs; absence is not proof that no biological mapping exists.`,
      input: objectInput(method.properties, method.required),
      required: method.required,
      exampleArgs: method.example,
      maxResponseBytes: 4_000_000,
      returns:
        '{ source, source_url, retrieved_at, operation, result }. Full upstream JSON is retained within the bounded response budget. Upstream errors are errors; no local database, mapping inference or implicit selection of one output is performed.',
      run: async (ctx, args) => {
        const url = new URL(BIO)
        url.search = new URLSearchParams({
          method: method.method,
          ...method.params(args)
        }).toString()
        const result = await ctx.fetchJson(url.href)
        if (!result || typeof result !== 'object') throw new Error('Invalid bioDBnet JSON response')
        if (
          (Array.isArray(result) ? result : [result]).some(
            (item) =>
              item &&
              typeof item === 'object' &&
              Object.keys(item).some((key) => /^(error|errors)$/i.test(key))
          )
        )
          throw new Error('bioDBnet returned an error response')
        if (
          ['db2db', 'dbfind', 'dbortho'].includes(method.method) &&
          (!Array.isArray(result) ||
            result.some((row) => !row || typeof row !== 'object' || Array.isArray(row)))
        ) {
          throw new Error('Invalid bioDBnet mapping rows')
        }
        return { ...provenance('bioDBnet', url.href), operation: method.method, result }
      }
    })
  ),
  {
    id: 'rank_transcription_factors',
    connector: 'chea3',
    credentialKeys: [],
    description:
      'Submit a public gene-symbol list to the official ChEA3 enrichment API. Returns each library ranking separately; ranks and scores are hypothesis evidence, not causal validation. The request is submitted once and does not identify all recognized input genes.',
    input: objectInput(
      {
        genes: {
          type: 'array',
          minItems: 1,
          maxItems: 2000,
          items: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,80}$' }
        },
        query_name: { type: 'string', minLength: 1, maxLength: 100, default: 'query' },
        top_n: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      ['genes']
    ),
    required: ['genes'],
    exampleArgs: { genes: ['FOXM1', 'SMAD9', 'MYC', 'SMAD3', 'STAT1', 'STAT3'], top_n: 5 },
    maxResponseBytes: 8_000_000,
    returns:
      '{ source, source_url, retrieved_at, submitted_gene_count, recognized_gene_count: null, libraries: { library: { records, total_records, truncated } } }. Inputs are deduplicated without inventing recognized genes.',
    run: async (ctx, args) => {
      const url = 'https://maayanlab.cloud/chea3/api/enrich/'
      const genes = [...new Set(args.genes as string[])]
      const raw = z
        .record(z.string(), z.array(z.record(z.string(), z.unknown())))
        .parse(
          await ctx.postJson(
            url,
            { query_name: args.query_name ?? 'query', gene_set: genes },
            { retry: false }
          )
        )
      if (!Object.keys(raw).length) throw new Error('ChEA3 did not return library rankings')
      const n = Number(args.top_n ?? 20)
      return {
        ...provenance('ChEA3', url),
        submitted_gene_count: genes.length,
        recognized_gene_count: null,
        libraries: Object.fromEntries(
          Object.entries(raw).map(([library, rows]) => [
            library,
            { records: rows.slice(0, n), total_records: rows.length, truncated: rows.length > n }
          ])
        )
      }
    }
  },
  {
    id: 'list_gmt_libraries',
    connector: 'chea3',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Discover official ChEA3 GMT file links from its download page. Primary, additional and benchmarking libraries may differ; a downloadable library is not automatically the library used by an online result. No files are downloaded by this method.',
    input: objectInput({}),
    exampleArgs: {},
    returns:
      '{ source, source_url, retrieved_at, files: [{filename,url}] }. A changed/challenge page fails explicitly; a result is a file catalog, not a completed download.',
    run: async (ctx) => {
      const url = 'https://maayanlab.cloud/chea3/'
      return {
        ...provenance('ChEA3', url),
        files: officialFileLinks(
          await ctx.fetchText(url, 'text/html'),
          url,
          (link) =>
            link.origin === 'https://maayanlab.cloud' &&
            link.pathname.startsWith('/chea3/') &&
            /\.gmt$/i.test(link.pathname)
        )
      }
    }
  },
  {
    id: 'get_cell_line_rdf',
    connector: 'cellosaurus',
    credentialKeys: [],
    description:
      'Retrieve RDF for one Cellosaurus accession from the official dereferencing service. The returned RDF text stays in the request result; there is no connector-owned file store or ontology download.',
    input: objectInput(
      {
        accession: { type: 'string', pattern: '^CVCL_[A-Z0-9]{4}$' },
        format: { type: 'string', enum: ['ttl', 'rdf', 'jsonld'], default: 'ttl' }
      },
      ['accession']
    ),
    required: ['accession'],
    exampleArgs: { accession: 'CVCL_0030', format: 'ttl' },
    maxResponseBytes: 2_000_000,
    returns:
      '{ source, source_url, retrieved_at, accession, format, content }. HTML access pages are errors. RDF knowledge does not authenticate a physical cell sample.',
    run: async (ctx, args) => {
      const format = String(args.format ?? 'ttl')
      const url = `https://purl.expasy.org/cellosaurus/rdf/cvcl/${args.accession}.${format}`
      const content = await ctx.fetchText(
        url,
        format === 'ttl'
          ? 'text/turtle'
          : format === 'rdf'
          ? 'application/rdf+xml'
          : 'application/ld+json'
      )
      if (!content.trim() || /^\s*(?:<!doctype html|<html\b)/i.test(content))
        throw new Error('Cellosaurus did not return RDF')
      if (format === 'jsonld') JSON.parse(content)
      return { ...provenance('Cellosaurus RDF', url), accession: args.accession, format, content }
    }
  },
  {
    id: 'query_knowledge_graph',
    connector: 'cellosaurus',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Run a bounded Cellosaurus SPARQL SELECT against the local official graph. Only PREFIX/SELECT queries without SERVICE, FROM or updates are supported; the supplied query is nested and limited, never broadened on zero results.',
    input: objectInput(
      {
        query: { type: 'string', minLength: 1, maxLength: 12000 },
        max_rows: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      ['query']
    ),
    required: ['query'],
    exampleArgs: {
      query: 'SELECT ?s WHERE { ?s a <http://www.w3.org/2002/07/owl#Class> }',
      max_rows: 2
    },
    returns:
      '{ source, source_url, retrieved_at, variables, records: [SPARQL bindings], max_rows, truncated }. Binding types and language/datatype metadata are preserved; an empty result only describes this query.',
    run: async (ctx, args) => {
      const text = String(args.query).replace(/^\s*#[^\n]*$/gm, '')
      if (
        !/^\s*(?:PREFIX\s+\w*:\s*<[^>]+>\s*)*SELECT\b/i.test(text) ||
        /\b(?:SERVICE|FROM|LOAD|INSERT|DELETE|CLEAR|DROP|CREATE|MOVE|COPY|ADD)\b/i.test(text)
      )
        throw new Error(
          'Only a local-graph SELECT without external datasets or updates is supported'
        )
      const prolog = text.match(/^\s*((?:PREFIX\s+\w*:\s*<[^>]+>\s*)*)/i)![1]
      const n = Number(args.max_rows ?? 20)
      const url = new URL('https://sparql.cellosaurus.org/sparql')
      url.search = new URLSearchParams({
        query: `${prolog}\nSELECT * WHERE { { ${text.slice(
          text.indexOf(prolog) + prolog.length
        )} } } LIMIT ${n + 1}`,
        format: 'application/sparql-results+json'
      }).toString()
      const raw = z
        .object({
          head: z.object({ vars: z.array(z.string()) }),
          results: z.object({ bindings: z.array(z.record(z.string(), z.unknown())) })
        })
        .parse(JSON.parse(await ctx.fetchText(url.href, 'application/sparql-results+json')))
      return {
        ...provenance('Cellosaurus SPARQL', url.href),
        variables: raw.head.vars,
        records: raw.results.bindings.slice(0, n),
        max_rows: n,
        truncated: raw.results.bindings.length > n
      }
    }
  },
  {
    id: 'search_str_similarity',
    connector: 'cellosaurus',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Compare an explicitly supplied cell-line STR profile with the official CLASTR service. Marker alleles are sent upstream. Similarity depends on loci and scoring options; it does not certify sample identity or absence of contamination.',
    input: objectInput(
      {
        markers: {
          type: 'object',
          minProperties: 1,
          maxProperties: 50,
          propertyNames: { pattern: '^[A-Za-z0-9_-]{1,30}$' },
          additionalProperties: { type: 'string', pattern: '^[XYxy0-9., ]{1,100}$' }
        },
        species: { type: 'string', enum: ['human', 'mouse', 'dog'], default: 'human' },
        algorithm: { type: 'integer', enum: [1, 2, 3], default: 1 },
        scoring_mode: { type: 'integer', enum: [1, 2, 3], default: 1 },
        score_filter: { type: 'integer', minimum: 0, maximum: 100, default: 70 },
        min_markers: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
        max_results: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      ['markers']
    ),
    required: ['markers'],
    exampleArgs: { markers: { D5S818: '12,13' }, min_markers: 1, max_results: 2 },
    returns:
      '{ source, source_url, retrieved_at, species, result, note }. Official scores/thresholds are not converted into an authentication decision.',
    run: async (ctx, args) => {
      const options = {
        species: String(args.species ?? 'human'),
        algorithm: String(args.algorithm ?? 1),
        scoringMode: String(args.scoring_mode ?? 1),
        scoreFilter: String(args.score_filter ?? 70),
        minMarkers: String(args.min_markers ?? 8),
        maxResults: String(args.max_results ?? 20),
        outputFormat: 'json'
      }
      const markers = args.markers as Record<string, string>
      const reserved = new Set(Object.keys(options).map((key) => key.toLowerCase()))
      if (Object.keys(markers).some((key) => reserved.has(key.toLowerCase())))
        throw new Error('STR marker names cannot replace CLASTR options')
      const url = new URL('https://www.cellosaurus.org/str-search/api/query')
      url.search = new URLSearchParams({ ...markers, ...options }).toString()
      const result = await ctx.fetchJson(url.href)
      if (!result || typeof result !== 'object') throw new Error('Invalid CLASTR response')
      return {
        ...provenance('Cellosaurus CLASTR', url.href),
        species: options.species,
        result,
        note: 'Similarity is not sample authentication.'
      }
    }
  },
  {
    id: 'list_cellosaurus_files',
    connector: 'cellosaurus',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Discover official Cellosaurus data-file links. No ontology, file or dataset is downloaded or persisted automatically.',
    input: objectInput({}),
    exampleArgs: {},
    returns:
      '{ source, source_url, retrieved_at, files: [{filename,url}] }. File links remain official references, not local paths or completed downloads.',
    run: async (ctx) => {
      const url = 'https://ftp.expasy.org/databases/cellosaurus/'
      return {
        ...provenance('Cellosaurus files', url),
        files: officialFileLinks(
          await ctx.fetchText(url, 'text/html'),
          url,
          (link) =>
            link.origin === 'https://ftp.expasy.org' &&
            link.pathname.startsWith('/databases/cellosaurus/') &&
            /\.(?:txt|xml|json|gz)$/i.test(link.pathname)
        )
      }
    }
  }
]
