import type { ToolDescriptor } from '../../connector-core/types'

// Public read API: https://api.mavedb.org/openapi.json. Search pagination is in the
// POST body; CSV pagination uses start/limit; mapped-variants has no pagination.
const BASE = 'https://api.mavedb.org/api/v1'
const EXPERIMENT_PATTERN = '^urn:mavedb:[0-9]{8}-(?:[a-z]+|0)$'
const SCORE_SET_PATTERN = '^urn:mavedb:[0-9]{8}-(?:[a-z]+|0)-[1-9][0-9]*$'
const scoreSetUrn = { type: 'string', pattern: SCORE_SET_PATTERN }
const experimentUrn = { type: 'string', pattern: EXPERIMENT_PATTERN }
const MAX_OFFSET = 1_000_000_000

type RecordValue = Record<string, unknown>

function urn(value: unknown, experiment = false): string {
  const pattern = experiment ? EXPERIMENT_PATTERN : SCORE_SET_PATTERN
  if (typeof value !== 'string' || !new RegExp(pattern).test(value)) {
    throw new Error(`urn must be a published MaveDB ${experiment ? 'experiment' : 'score set'} URN`)
  }
  return value
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MaveDB returned a malformed record')
  }
  return value as RecordValue
}

function records(value: unknown, identifier: string): RecordValue[] {
  if (!Array.isArray(value)) throw new Error('MaveDB returned a malformed list')
  return value.map((item) => {
    const row = record(item)
    if (typeof row[identifier] !== 'string' || !row[identifier]) {
      throw new Error(`MaveDB record is missing ${identifier}`)
    }
    return row
  })
}

function resource(value: unknown, expectedUrn: string): RecordValue {
  const row = record(value)
  if (row.urn !== expectedUrn) throw new Error('MaveDB returned an unexpected resource URN')
  return row
}

function scoreSetUrl(id: string): string {
  return `${BASE}/score-sets/${encodeURIComponent(id)}`
}

export const VARIANTS_MAVEDB_TOOLS: ToolDescriptor[] = [
  {
    id: 'mavedb_search_score_sets',
    connector: 'variants',
    description:
      'Search public MaveDB multiplexed assays of variant effect (MAVE) score sets by text, such as a gene symbol, protein or assay. No API key or contact email is required. Returns one page with the upstream total when known; functional scores are assay-specific and are not clinical classifications or population frequencies.',
    input: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' },
        offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      required: ['text'],
      additionalProperties: false
    },
    required: ['text'],
    returns:
      '`{ text, offset, limit, total: number|null, next_offset: number|null, score_sets: [...] }`. Score set records retain upstream fields (urn, title, targetGenes, experiment, numVariants and publication metadata). An empty first page returns total=0. An empty page at offset>0 returns total=null (unknown) and next_offset=null: upstream may report the offset instead of the actual total. No extra count request is made.',
    example:
      'const result = await host.mcp("variants", "mavedb_search_score_sets", {"text":"BRCA1","limit":20})',
    run: async (ctx, a) => {
      if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 1000) {
        throw new Error('text must contain between 1 and 1000 characters')
      }
      const text = a.text.trim()
      const offset = integer(a.offset, 'offset', 0, 0, MAX_OFFSET)
      const limit = integer(a.limit, 'limit', 20, 1, 100)
      const raw = record(
        await ctx.postJson(`${BASE}/score-sets/search`, { text, published: true, offset, limit })
      )
      const scoreSets = records(raw.scoreSets, 'urn')
      const reportedTotal = raw.numScoreSets
      if (
        !Number.isSafeInteger(reportedTotal) ||
        (reportedTotal as number) < 0 ||
        scoreSets.length > limit ||
        (scoreSets.length > 0 && offset + scoreSets.length > (reportedTotal as number)) ||
        (scoreSets.length === 0 && offset < (reportedTotal as number))
      ) {
        throw new Error('MaveDB returned inconsistent search pagination')
      }
      // Upstream can compute numScoreSets as offset + page length. An empty page
      // beyond offset zero therefore cannot establish the actual match count.
      const total = scoreSets.length === 0 && offset > 0 ? null : (reportedTotal as number)
      return {
        text,
        offset,
        limit,
        total,
        next_offset:
          total !== null && offset + scoreSets.length < total ? offset + scoreSets.length : null,
        score_sets: scoreSets
      }
    }
  },
  {
    id: 'mavedb_get_score_set',
    connector: 'variants',
    description:
      'Retrieve a published MaveDB score set by URN, including targets, assay metadata, license, publications and experiment relationships. Includes official full CSV and mapped-variant download URLs for manual download by the user; do not fetch these URLs with raw HTTP to bypass host.mcp. Read the assay methods and score calibration before interpreting functional effects.',
    input: {
      type: 'object',
      properties: { urn: scoreSetUrn },
      required: ['urn'],
      additionalProperties: false
    },
    required: ['urn'],
    returns:
      '`{ urn, score_set: {...}, scores_download_url, mapped_variants_download_url }`. The complete upstream score set is preserved. Unavailable/private resources and HTTP errors propagate as errors.',
    example:
      'const result = await host.mcp("variants", "mavedb_get_score_set", {"urn":"urn:mavedb:00000003-a-1"})',
    run: async (ctx, a) => {
      const id = urn(a.urn)
      const url = scoreSetUrl(id)
      return {
        urn: id,
        score_set: resource(await ctx.fetchJson(url), id),
        scores_download_url: `${url}/scores`,
        mapped_variants_download_url: `${url}/mapped-variants`
      }
    }
  },
  {
    id: 'mavedb_download_scores',
    connector: 'variants',
    description:
      'Download a CSV page of MaveDB variant scores (default 1000 rows, maximum 10000). Uses start/limit, not offset. Returns original CSV text, including all score columns and NA values, for saving with Notebook file APIs; this tool does not write a local file. Also returns the unpaginated official download URL for manual download by the user; do not fetch these URLs with raw HTTP to bypass host.mcp. Use numVariants from mavedb_get_score_set to plan pages; a page is not the full dataset.',
    input: {
      type: 'object',
      properties: {
        urn: scoreSetUrn,
        start: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 }
      },
      required: ['urn'],
      additionalProperties: false
    },
    required: ['urn'],
    returns:
      '`{ urn, start, limit, format: "csv", content: string, url, download_url }`. Content is the unchanged upstream CSV page; start/limit describe the request, not an inferred returned row count. No score normalization or clinical interpretation is performed.',
    example:
      'const result = await host.mcp("variants", "mavedb_download_scores", {"urn":"urn:mavedb:00000003-a-1","start":0,"limit":1000})',
    run: async (ctx, a) => {
      const id = urn(a.urn)
      const start = integer(a.start, 'start', 0, 0, MAX_OFFSET)
      const limit = integer(a.limit, 'limit', 1000, 1, 10000)
      const downloadUrl = `${scoreSetUrl(id)}/scores`
      const url = `${downloadUrl}?start=${start}&limit=${limit}`
      const content = await ctx.fetchText(url, 'text/csv')
      // Reject JSON/HTML success bodies rather than present an error page as score data.
      if (!/^\uFEFF?accession,/.test(content)) throw new Error('MaveDB returned invalid scores CSV')
      return { urn: id, start, limit, format: 'csv', content, url, download_url: downloadUrl }
    }
  },
  {
    id: 'mavedb_get_mapped_variants',
    connector: 'variants',
    description:
      'Retrieve existing MaveDB variant mappings for a published score set, including GA4GH VRS preMapped/postMapped objects, reference sequence identifiers, VRS version and mapping errors. This reads mappings already computed by MaveDB; it does not submit variants or perform liftover. The upstream endpoint is unpaginated and the shared 64 MiB response limit applies. For larger datasets, offer the official URL from mavedb_get_score_set for manual download by the user; do not fetch these URLs with raw HTTP to bypass host.mcp. HTTP 404 can mean no mapping records exist, not only that the score set URN is unavailable. Returned records may include failed mappings.',
    input: {
      type: 'object',
      properties: { urn: scoreSetUrn },
      required: ['urn'],
      additionalProperties: false
    },
    required: ['urn'],
    returns:
      '`{ urn, download_url, mapped_variants: [...] }`. All upstream mapping fields, null mappings, current flags and errorMessage values are preserved. HTTP failures are errors, not empty results.',
    example:
      'const result = await host.mcp("variants", "mavedb_get_mapped_variants", {"urn":"urn:mavedb:00000003-a-1"})',
    run: async (ctx, a) => {
      const id = urn(a.urn)
      const url = `${scoreSetUrl(id)}/mapped-variants`
      return {
        urn: id,
        download_url: url,
        mapped_variants: records(await ctx.fetchJson(url), 'variantUrn')
      }
    }
  },
  {
    id: 'mavedb_get_experiment',
    connector: 'variants',
    description:
      'Retrieve a public MaveDB experiment by experiment URN (without the score set suffix), including methods, publications, experiment set and scoreSetUrns. Supports the special -0 meta-analysis experiment as well as letter-indexed experiments. No authentication is required.',
    input: {
      type: 'object',
      properties: { urn: experimentUrn },
      required: ['urn'],
      additionalProperties: false
    },
    required: ['urn'],
    returns:
      '`{ urn, experiment: {...} }` with complete upstream experiment metadata. HTTP errors propagate.',
    example:
      'const result = await host.mcp("variants", "mavedb_get_experiment", {"urn":"urn:mavedb:00000003-a"})',
    run: async (ctx, a) => {
      const id = urn(a.urn, true)
      return {
        urn: id,
        experiment: resource(
          await ctx.fetchJson(`${BASE}/experiments/${encodeURIComponent(id)}`),
          id
        )
      }
    }
  },
  {
    id: 'mavedb_get_experiment_score_sets',
    connector: 'variants',
    description:
      'List the score sets visible to a public reader of a MaveDB experiment. The upstream endpoint filters by visibility and supersession chains, so this is not a complete version history. It returns the selected list without pagination. HTTP 404 can mean no associated score sets are available, not only that the experiment URN is unavailable. Use the returned score set URNs to retrieve functional scores or mappings.',
    input: {
      type: 'object',
      properties: { urn: experimentUrn },
      required: ['urn'],
      additionalProperties: false
    },
    required: ['urn'],
    returns:
      '`{ urn, score_sets: [...] }` preserving full records from the upstream visible, supersession-filtered list. HTTP failures, including no-associated-score-sets 404 responses, propagate as errors rather than empty lists.',
    example:
      'const result = await host.mcp("variants", "mavedb_get_experiment_score_sets", {"urn":"urn:mavedb:00000003-a"})',
    run: async (ctx, a) => {
      const id = urn(a.urn, true)
      return {
        urn: id,
        score_sets: records(
          await ctx.fetchJson(`${BASE}/experiments/${encodeURIComponent(id)}/score-sets`),
          'urn'
        )
      }
    }
  }
]
