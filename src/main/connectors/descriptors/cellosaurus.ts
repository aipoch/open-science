import { ConnectorHttpError } from '../../connector-core/engine'
import type { ToolDescriptor } from '../../connector-core/types'

// Contract: https://api.cellosaurus.org/openapi.json and /api-fields.
// JSON uses the Cellosaurus XML-style envelope, not Solr's response.docs format.
const API = 'https://api.cellosaurus.org'
const IDENTITY_FIELDS = 'acas,id,sy,ox,ca,problematic,caution,registration,dt'
const DETAIL_FIELDS = `${IDENTITY_FIELDS},sx,ag,di,derived-from-site,cell-type,from,hi,dr`
const MAX_OFFSET = 1_000_000
const QUALITY_NOTE =
  'These are curated Cellosaurus records, not a quality test of your sample. No recorded problem does not establish authentication or absence of contamination.'
type Obj = Record<string, unknown>

function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Cellosaurus response: expected an object')
  }
  return value as Obj
}

function records(value: unknown): Obj[] {
  if (!Array.isArray(value)) throw new Error('Invalid Cellosaurus response: expected an array')
  return value.map(object)
}

// Optional fields are absent when uncurated. A present malformed field must not become an
// empty list, especially for problematic/caution comments and external database mappings.
function list(row: Obj, key: string): Obj[] {
  return row[key] === undefined ? [] : records(row[key])
}

function text(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') throw new Error('Invalid Cellosaurus response: expected text')
  return value
}

function cellLines(raw: unknown): Obj[] {
  return records(object(object(raw).Cellosaurus)['cell-line-list'])
}

function accession(value: unknown): string {
  const input = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!/^(?:RRID:)?CVCL_[A-Z0-9]{4}$/.test(input)) {
    throw new Error('accession must be a CVCL identifier or RRID:CVCL identifier')
  }
  return input.replace(/^RRID:/, '')
}

function identity(row: Obj): Obj {
  const accessions = list(row, 'accession-list')
  const primary = accessions.find((item) => item.type === 'primary')?.value
  if (typeof primary !== 'string' || !/^CVCL_[A-Z0-9]{4}$/.test(primary)) {
    throw new Error('Invalid Cellosaurus response: missing primary accession')
  }
  const names = list(row, 'name-list')
  const name = names.find((item) => item.type === 'identifier')?.value
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Invalid Cellosaurus response: missing cell line name')
  }
  const comments = list(row, 'comment-list')
  for (const comment of comments) {
    if (typeof comment.category !== 'string' || typeof comment.value !== 'string') {
      throw new Error('Invalid Cellosaurus response: malformed comment')
    }
  }
  const problems = comments.filter((item) => item.category === 'Problematic cell line')
  return {
    accession: primary,
    rrid: `RRID:${primary}`,
    name,
    synonyms: names.filter((item) => item.type === 'synonym').map((item) => text(item.value)),
    secondary_accessions: accessions
      .filter((item) => item.type === 'secondary')
      .map((item) => text(item.value)),
    species: list(row, 'species-list'),
    category: text(row.category),
    quality: {
      status: problems.length ? 'problematic_recorded' : 'no_problem_recorded',
      problems,
      cautions: comments.filter((item) => item.category === 'Caution'),
      registrations: list(row, 'registration-list'),
      note: QUALITY_NOTE
    },
    source_url: `https://www.cellosaurus.org/${primary}`,
    created: text(row.created),
    last_updated: text(row['last-updated']),
    entry_version: text(row['entry-version'])
  }
}

function detail(row: Obj): Obj {
  return {
    ...identity(row),
    sex: text(row.sex),
    age: text(row.age),
    diseases: list(row, 'disease-list'),
    derived_from_sites: list(row, 'derived-from-site-list'),
    cell_type: row['cell-type'] === undefined ? null : object(row['cell-type']),
    established_by: list(row, 'comment-list').filter((item) => item.category === 'From'),
    parent_cell_lines: list(row, 'derived-from'),
    cross_references: list(row, 'xref-list')
  }
}

export const CELLOSAURUS_TOOLS: ToolDescriptor[] = [
  {
    connector: 'cellosaurus',
    id: 'search_cell_lines',
    description:
      'Search Cellosaurus recommended names and synonyms using a literal phrase (not raw Solr syntax). Returns candidates, not an unambiguous identity match. Use get_cell_line with the selected CVCL accession for origin, diseases and external mappings.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, default: 0 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ query, offset, limit, returned, next_offset, pagination_limited, cell_lines: [{ accession, rrid, name, synonyms, secondary_accessions, species, category, quality: { status, problems, cautions, registrations, note }, source_url, created, last_updated, entry_version }] }`. One extra row determines next_offset; the API supplies no total. Results are ordered by accession. An empty cell_lines list means the requested page has no records; only an empty page at offset=0 means no name/synonym match. quality.status is problematic_recorded or no_problem_recorded, never a sample certification. HTTP and malformed-response errors propagate.',
    example:
      'const result = await host.mcp("cellosaurus", "search_cell_lines", {"query": "HeLa", "limit": 20})',
    run: async (ctx, args) => {
      const query = String(args.query).trim()
      if (!query) throw new Error('query must contain a cell line name or synonym')
      const limit = Number(args.limit ?? 20)
      const offset = Number(args.offset ?? 0)
      const params = new URLSearchParams({
        q: `idsy:"${query.replace(/[\\"]/g, '\\$&')}"`,
        rows: String(limit + 1),
        start: String(offset),
        sort: 'ac asc',
        format: 'json',
        fields: IDENTITY_FIELDS
      })
      const rows = cellLines(await ctx.fetchJson(`${API}/search/cell-line?${params}`))
      if (rows.length > limit + 1) throw new Error('Invalid Cellosaurus response: oversized page')
      const hasMore = rows.length > limit
      return {
        query,
        offset,
        limit,
        returned: Math.min(rows.length, limit),
        next_offset: hasMore && offset + limit <= MAX_OFFSET ? offset + limit : null,
        pagination_limited: hasMore && offset + limit > MAX_OFFSET,
        cell_lines: rows.slice(0, limit).map(identity)
      }
    }
  },
  {
    connector: 'cellosaurus',
    id: 'get_cell_line',
    description:
      'Resolve a Cellosaurus CVCL accession or RRID:CVCL identifier. Retrieve identity, species, tissue/cell-type origin, establishing laboratory, donor disease/age/sex, parent cell lines, curated contamination/misidentification and caution records, ICLAC registrations, and external database mappings. Missing annotations do not establish sample quality.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accession: {
          type: 'string',
          minLength: 9,
          maxLength: 40,
          pattern: '^\\s*(?:[Rr][Rr][Ii][Dd]:)?[Cc][Vv][Cc][Ll]_[A-Za-z0-9]{4}\\s*$',
          description:
            'CVCL_0030 or RRID:CVCL_0030; case and surrounding whitespace are normalized.'
        }
      },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ accession, rrid, name, synonyms, secondary_accessions, species, category, sex, age, diseases, derived_from_sites, cell_type, established_by, parent_cell_lines, quality: { status, problems, cautions, registrations, note }, cross_references, source_url, created, last_updated, entry_version }`. Annotations retain upstream objects, evidence text and database identifiers/URLs. Optional uncurated lists are empty; scalar fields are null. No recorded problem is not evidence of authentication or absence of contamination. A detail HTTP 404 triggers one exact primary/secondary accession search; a unique matching record resolves an old CVCL/RRID to its current primary accession and RRID. No match preserves the original HTTP 404; ambiguous/mismatched records fail. Other HTTP, network and malformed-response failures propagate without identity fallback.',
    example:
      'const result = await host.mcp("cellosaurus", "get_cell_line", {"accession": "RRID:CVCL_1906"})',
    run: async (ctx, args) => {
      const id = accession(args.accession)
      const params = new URLSearchParams({ format: 'json', fields: DETAIL_FIELDS })
      let rows: Obj[]
      try {
        rows = cellLines(await ctx.fetchJson(`${API}/cell-line/${id}?${params}`))
      } catch (error) {
        if (!(error instanceof ConnectorHttpError) || error.status !== 404) throw error
        // The detail endpoint accepts primary accessions only. ACAS retains identifiers of
        // merged records; request two matches so an ambiguous result cannot be picked silently.
        const lookup = new URLSearchParams({
          q: `acas:"${id}"`,
          rows: '2',
          start: '0',
          format: 'json',
          fields: DETAIL_FIELDS
        })
        rows = cellLines(await ctx.fetchJson(`${API}/search/cell-line?${lookup}`))
        if (rows.length === 0) throw error
      }
      if (rows.length !== 1 || !list(rows[0], 'accession-list').some((item) => item.value === id)) {
        throw new Error('Invalid Cellosaurus response: accession mismatch or missing record')
      }
      return detail(rows[0])
    }
  }
]
