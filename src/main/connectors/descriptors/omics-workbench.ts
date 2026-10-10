import type { ToolContext, ToolDescriptor } from '../../connector-core/types'

// Public read-only API: https://www.metabolomicsworkbench.org/tools/MWRestAPIv1.1.pdf
const BASE = 'https://www.metabolomicsworkbench.org/rest'
const COMPOUND_FIELDS = [
  'regno',
  'formula',
  'inchi_key',
  'lm_id',
  'pubchem_cid',
  'hmdb_id',
  'kegg_id',
  'chebi_id',
  'metacyc_id'
] as const
// The upstream last_name/summary route can return no matches for known study authors.
const STUDY_FIELDS = ['study_title', 'institute'] as const
const SECTIONS = ['summary', 'factors', 'analysis', 'metabolites'] as const
const querySchema = { type: 'string', minLength: 1, maxLength: 200 }
const limitSchema = {
  type: 'integer',
  minimum: 1,
  maximum: 1000,
  default: 100,
  description:
    'Maximum returned records, applied locally after fetching one bounded response. The API has no pagination.'
}

type RecordRow = Record<string, unknown>
const isRecord = (value: unknown): value is RecordRow =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function queryValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new Error('query must be a non-empty string of at most 200 characters')
  }
  const query = value.trim()
  const hasControl = [...query].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (query === '.' || query === '..' || /[/\\]/u.test(query) || hasControl) {
    throw new Error('query must not contain path separators or control characters')
  }
  return query
}

function choice(value: unknown, choices: readonly string[], label: string): string {
  if (typeof value !== 'string' || !choices.includes(value)) {
    throw new Error(`${label} must be one of: ${choices.join(', ')}`)
  }
  return value
}

function resultLimit(value: unknown): number {
  if (value === undefined) return 100
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    throw new Error('limit must be an integer between 1 and 1000')
  }
  return value as number
}

async function readRecords(
  ctx: ToolContext,
  url: string,
  identity: string,
  limit: number
): Promise<RecordRow> {
  // Do not append /json: live study summary endpoints can return TSV for that suffix.
  const raw = await ctx.fetchJson(url)
  let rows: unknown[]
  if (Array.isArray(raw)) rows = raw
  else if (isRecord(raw) && identity in raw) rows = [raw]
  else if (
    isRecord(raw) &&
    Object.keys(raw).every(
      (key) => /^\d+$/.test(key) || (identity === 'regno' && /^Row[1-9]\d*$/.test(key))
    )
  ) {
    rows = Object.values(raw)
  } else {
    throw new Error('Metabolomics Workbench returned an unexpected response')
  }
  if (rows.some((row) => !isRecord(row) || typeof row[identity] !== 'string' || !row[identity])) {
    throw new Error('Metabolomics Workbench returned a malformed record')
  }
  return {
    source: 'Metabolomics Workbench',
    source_url: url,
    records: rows.slice(0, limit),
    returned: Math.min(rows.length, limit),
    total_received: rows.length,
    truncated: rows.length > limit
  }
}

const common = {
  connector: 'omics-archives',
  maxResponseBytes: 5 * 1024 * 1024,
  returns:
    '{source, source_url, records: [upstream record with original fields], returned, total_received, truncated}. Counts describe this response, not a verified database total. limit caps local output only.'
}

const studyReturns =
  `${common.returns} Upstream study_url values are preserved without correction and may contain the search term instead of a study ID. ` +
  'Use source_url to trace the API response and study_id with workbench_get_study to retrieve a study.'

export const WORKBENCH_OMICS_TOOLS: ToolDescriptor[] = [
  {
    ...common,
    id: 'workbench_search_compounds',
    description:
      'Look up Metabolomics Workbench compounds by registry number, formula, InChIKey, or a PubChem, HMDB, KEGG, ChEBI, LIPID MAPS or MetaCyc cross-reference. Returns available SMILES, structure identifiers, formula, exact mass and cross-references. Compound names are not a supported input; resolve names with PubChem first.',
    input: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: COMPOUND_FIELDS },
        query: querySchema,
        limit: limitSchema
      },
      required: ['field', 'query'],
      additionalProperties: false
    },
    required: ['field', 'query'],
    example:
      'const result = await host.mcp("omics-archives", "workbench_search_compounds", {"field": "pubchem_cid", "query": "5793"})',
    run: async (ctx, args) => {
      const field = choice(args.field, COMPOUND_FIELDS, 'field')
      const query = queryValue(args.query)
      const limit = resultLimit(args.limit)
      return readRecords(
        ctx,
        `${BASE}/compound/${field}/${encodeURIComponent(query)}/all`,
        'regno',
        limit
      )
    }
  },
  {
    ...common,
    id: 'workbench_search_studies',
    returns: studyReturns,
    description:
      'Search public Metabolomics Workbench study summaries by a title substring or institute. Returns study IDs and available species, sample counts, analysis types and license metadata. Use workbench_get_study for a selected study’s samples, experimental factors, analyses or metabolite annotations.',
    input: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: STUDY_FIELDS, default: 'study_title' },
        query: querySchema,
        limit: limitSchema
      },
      required: ['query'],
      additionalProperties: false
    },
    required: ['query'],
    example:
      'const result = await host.mcp("omics-archives", "workbench_search_studies", {"query": "Diabetes", "limit": 20})',
    run: async (ctx, args) => {
      const field = choice(
        args.field === undefined ? 'study_title' : args.field,
        STUDY_FIELDS,
        'field'
      )
      const query = queryValue(args.query)
      const limit = resultLimit(args.limit)
      return readRecords(
        ctx,
        `${BASE}/study/${field}/${encodeURIComponent(query)}/summary`,
        'study_id',
        limit
      )
    }
  },
  {
    ...common,
    id: 'workbench_get_study',
    returns: `{study_id, section, ...result}; result: ${studyReturns}`,
    description:
      'Retrieve one public Metabolomics Workbench study (ST followed by six digits). Select summary for the study record; factors for samples, sample sources and experimental variables; analysis for instrument and experimental metadata; metabolites for measured metabolite annotations and cross-references. Preserves upstream fields and factor text. Does not download raw files or measurement matrices.',
    input: {
      type: 'object',
      properties: {
        study_id: { type: 'string', pattern: '^ST[0-9]{6}$' },
        section: { type: 'string', enum: SECTIONS, default: 'summary' },
        limit: limitSchema
      },
      required: ['study_id'],
      additionalProperties: false
    },
    required: ['study_id'],
    example:
      'const result = await host.mcp("omics-archives", "workbench_get_study", {"study_id": "ST000001", "section": "factors"})',
    run: async (ctx, args) => {
      if (typeof args.study_id !== 'string' || !/^ST[0-9]{6}$/.test(args.study_id)) {
        throw new Error('study_id must be ST followed by six digits')
      }
      const section = choice(
        args.section === undefined ? 'summary' : args.section,
        SECTIONS,
        'section'
      )
      const limit = resultLimit(args.limit)
      const result = await readRecords(
        ctx,
        `${BASE}/study/study_id/${args.study_id}/${section}`,
        'study_id',
        limit
      )
      return { study_id: args.study_id, section, ...result }
    }
  }
]
