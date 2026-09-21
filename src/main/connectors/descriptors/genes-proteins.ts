import type { ToolContext, ToolDescriptor } from '../types'

// mygene.info batch gene resolution + UniProtKB record retrieval. mygene answers a POST /query with a
// JSON array (one item per query term, misses flagged notfound:true); UniProt is queried with a single
// batched OR-query over accessions and served as TSV (token-lean tabular), FASTA, or flat-file text.
const MYGENE = 'https://mygene.info/v3'
const UNIPROT = 'https://rest.uniprot.org/uniprotkb'

// mygene batch caps at 1000 terms/request; UniProt OR-queries are chunked to keep the URL bounded.
const MYGENE_BATCH = 1000
const UNIPROT_CHUNK = 100
const UNIPROT_SEARCH_FIELDS =
  'accession,id,reviewed,protein_name,gene_names,organism_id,organism_name,length'
const UNIPROT_SEARCH_TEXT = '^(?=[\\s\\S]*\\S)[^"\\\\*?\\u0000-\\u001f\\u007f]+$'
const UNIPROT_CURSOR = '^[^\\s\\u0000-\\u001f\\u007f]+$'

function invalidUniProtSearch(detail: string): never {
  throw new Error(`Invalid UniProt search response: ${detail}`)
}

function searchObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidUniProtSearch(field)
  return value as Record<string, unknown>
}

function searchArray(value: unknown, field: string): unknown[] {
  if (value == null) return []
  if (!Array.isArray(value)) invalidUniProtSearch(field)
  return value
}

function searchText(value: unknown, field: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string') invalidUniProtSearch(field)
  return value.trim() || null
}

function searchInteger(value: unknown, field: string): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalidUniProtSearch(field)
  return value
}

function searchRecord(value: unknown): Record<string, unknown> {
  const row = searchObject(value, 'expected an entry object')
  const accession = searchText(row.primaryAccession, 'primaryAccession')
  if (
    !accession ||
    !/^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/.test(accession)
  )
    invalidUniProtSearch('missing or invalid primaryAccession')
  if (
    row.entryType !== 'UniProtKB reviewed (Swiss-Prot)' &&
    row.entryType !== 'UniProtKB unreviewed (TrEMBL)'
  )
    invalidUniProtSearch('missing or invalid entryType')
  const description =
    row.proteinDescription == null ? {} : searchObject(row.proteinDescription, 'proteinDescription')
  const proteinNames = [
    ...(description.recommendedName == null ? [] : [description.recommendedName]),
    ...searchArray(description.submissionNames, 'submissionNames'),
    ...searchArray(description.alternativeNames, 'alternativeNames')
  ]
    .map((name) => {
      const fullName = searchObject(name, 'protein name').fullName
      return fullName == null
        ? null
        : searchText(searchObject(fullName, 'fullName').value, 'fullName.value')
    })
    .filter((name): name is string => name !== null)
  const geneNames = searchArray(row.genes, 'genes').flatMap((value) => {
    const gene = searchObject(value, 'gene')
    return [
      ...(gene.geneName == null ? [] : [gene.geneName]),
      ...searchArray(gene.synonyms, 'synonyms'),
      ...searchArray(gene.orderedLocusNames, 'orderedLocusNames'),
      ...searchArray(gene.orfNames, 'orfNames')
    ]
      .map((name) => searchText(searchObject(name, 'gene name').value, 'gene name value'))
      .filter((name): name is string => name !== null)
  })
  const organism = row.organism == null ? {} : searchObject(row.organism, 'organism')
  const sequence = row.sequence == null ? {} : searchObject(row.sequence, 'sequence')
  return {
    accession,
    entry_name: searchText(row.uniProtkbId, 'uniProtkbId'),
    reviewed: row.entryType === 'UniProtKB reviewed (Swiss-Prot)',
    protein_names: [...new Set(proteinNames)],
    gene_names: [...new Set(geneNames)],
    organism_id: searchInteger(organism.taxonId, 'organism.taxonId'),
    organism_name: searchText(organism.scientificName, 'organism.scientificName'),
    length: searchInteger(sequence.length, 'sequence.length')
  }
}

function searchNextCursor(headers: Headers, current: unknown): string | null {
  const link = headers.get('link')
  if (!link) return null
  const links = [...link.matchAll(/<([^>]+)>\s*;\s*rel="?([^";,]+)"?/g)]
  if (!links.length) invalidUniProtSearch('malformed pagination Link')
  const next = links.filter((match) => match[2].split(/\s+/).includes('next'))
  if (!next.length) return null
  if (next.length > 1) invalidUniProtSearch('multiple next links')
  let url: URL
  try {
    url = new URL(next[0][1])
  } catch {
    return invalidUniProtSearch('invalid next link')
  }
  const cursor = url.searchParams.get('cursor')
  if (
    url.origin !== 'https://rest.uniprot.org' ||
    url.pathname !== '/uniprotkb/search' ||
    url.username ||
    url.password ||
    url.hash ||
    !cursor ||
    [...cursor].length > 4096 ||
    !new RegExp(UNIPROT_CURSOR).test(cursor) ||
    cursor === current
  )
    invalidUniProtSearch('invalid or repeated next cursor')
  // Never fetch a Link target: callers send only its opaque cursor back to the fixed endpoint.
  return cursor
}

// One mygene hit: carries its originating `query`, an `_id`, the requested fields, or notfound:true.
type MygeneHit = {
  query?: string
  _id?: string
  notfound?: boolean
  [key: string]: unknown
}

// POSTs the terms to mygene in <=1000-term chunks and concatenates the per-chunk result arrays.
async function mygeneBatch(
  ctx: ToolContext,
  terms: string[],
  body: Record<string, unknown>
): Promise<MygeneHit[]> {
  const out: MygeneHit[] = []
  for (let i = 0; i < terms.length; i += MYGENE_BATCH) {
    const chunk = terms.slice(i, i + MYGENE_BATCH)
    const resp = (await ctx.postJson(`${MYGENE}/query`, { ...body, q: chunk })) as MygeneHit[]
    for (const hit of resp ?? []) out.push(hit)
  }
  return out
}

// Splits accessions into URL-safe OR-query chunks.
function chunkAccessions(accessions: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < accessions.length; i += UNIPROT_CHUNK) {
    chunks.push(accessions.slice(i, i + UNIPROT_CHUNK))
  }
  return chunks
}

// Builds the batched active-record filter, e.g. ((accession:P04637)OR(sec_acc:P04637))OR(...).
function orQuery(chunk: string[]): string {
  return `(${chunk.map((a) => `((accession:${a})OR(sec_acc:${a}))`).join('OR')}) AND active:true`
}

// Parses a UniProt TSV payload into column->value objects keyed by the header row (skips the header
// and blank lines). Rows shorter than the header are padded with empty strings.
function parseTsv(tsv: string): Record<string, string>[] {
  const lines = tsv.split('\n').filter((l) => l.length > 0)
  if (lines.length <= 1) return []
  const headers = lines[0].split('\t')
  return lines.slice(1).map((line) => {
    const cells = line.split('\t')
    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? ''
    })
    return row
  })
}

// One parsed multi-record entry: the accessions it answers for plus its verbatim text block.
type ParsedEntry = { accessions: string[]; text: string }

// Splits a multi-record FASTA payload into per-entry blocks; the accession is the pipe-delimited
// middle field of each ">db|ACCESSION|NAME ..." header.
function parseFasta(fasta: string): ParsedEntry[] {
  const trimmed = fasta.trim()
  if (trimmed === '') return []
  return trimmed.split(/\n(?=>)/).map((block) => {
    const header = block.split('\n')[0]
    const m = /^>[^|]*\|([^|]+)\|/.exec(header)
    return { accessions: m ? [m[1]] : [], text: `${block.trimEnd()}\n` }
  })
}

// Splits a multi-record UniProt flat-file payload on the // record terminator; each record's
// accessions are read off its AC lines (primary + secondary, semicolon-separated).
function parseFlatFile(txt: string): ParsedEntry[] {
  return txt
    .split(/^\/\/$/m)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const accessions: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('AC ')) {
          for (const token of line.slice(2).split(';')) {
            const acc = token.trim()
            if (acc) accessions.push(acc)
          }
        }
      }
      return { accessions, text: `${block}\n//\n` }
    })
}

// Maps each requested accession to the text of the entry that answers for it (case-insensitive),
// returning the {accession:text} record map plus the accessions no entry covered.
function mapEntries(
  accessions: string[],
  entries: ParsedEntry[]
): { records: Record<string, string>; missing: string[] } {
  const records: Record<string, string> = {}
  const missing: string[] = []
  for (const acc of accessions) {
    const upper = acc.toUpperCase()
    const hit = entries.find((e) => e.accessions.some((a) => a.toUpperCase() === upper))
    if (hit) records[acc] = hit.text
    else missing.push(acc)
  }
  return { records, missing }
}

// The direct endpoint uses 400 for malformed/unknown accession path segments and 404 for absent
// records. Preserve the connector convention of reporting those as missing while propagating
// transport and server failures.
function isMissingDirectEntryError(err: unknown): boolean {
  return err instanceof Error && /HTTP (?:400|404)\b/.test(err.message)
}

// A FASTA header carries only the primary accession. Resolve any requested accession that the
// batched search could not map through UniProt's direct endpoint, which follows secondary-
// accession redirects to the current primary record. TXT responses include AC lines and therefore
// retain the full alias set when parsed below.
async function fetchDirectEntries(
  ctx: ToolContext,
  accessions: string[],
  format: 'fasta' | 'txt'
): Promise<{ records: Record<string, string>; missing: string[] }> {
  const records: Record<string, string> = {}
  const missing: string[] = []
  for (const accession of accessions) {
    try {
      const payload = await ctx.fetchText(`${UNIPROT}/${encodeURIComponent(accession)}.${format}`)
      const entries = format === 'txt' ? parseFlatFile(payload) : parseFasta(payload)
      const first = entries[0]
      if (first?.text && first.accessions.length > 0) records[accession] = first.text
      else missing.push(accession)
    } catch (err) {
      if (isMissingDirectEntryError(err)) missing.push(accession)
      else throw err
    }
  }
  return { records, missing }
}

export const GENES_PROTEINS_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_uniprot_entries',
    connector: 'genes',
    description:
      'Discover active UniProtKB protein entries by exact gene name (including synonyms), protein-name phrase and/or exact organism_id (NCBI taxonomy ID, not descendants). At least one of these filters is required; supplied filters are combined with AND. Optional reviewed=true selects Swiss-Prot, false selects TrEMBL; omitting it includes both. No organism or reviewed default. Text uses UniProt tokenized phrase matching, not arbitrary substring matching or raw query syntax; quotes, backslashes, wildcards and control characters are rejected. Returns one bounded page in accession order, not a complete protein set. For the next page, pass next_cursor as cursor with identical filters and page_size. Cursors are opaque, not offsets or durable snapshots; restart if UniProt rejects a stale cursor.',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string', minLength: 1, maxLength: 200, pattern: UNIPROT_SEARCH_TEXT },
        protein_name: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          pattern: UNIPROT_SEARCH_TEXT
        },
        organism_id: { type: 'integer', minimum: 1, maximum: 2147483647 },
        reviewed: { type: 'boolean' },
        page_size: { type: 'integer', minimum: 1, maximum: 500, default: 25 },
        cursor: { type: 'string', minLength: 1, maxLength: 4096, pattern: UNIPROT_CURSOR }
      },
      anyOf: ['gene', 'protein_name', 'organism_id'].map((field) => ({
        properties: { [field]: {} },
        required: [field]
      })),
      additionalProperties: false
    },
    returns:
      '{filters:{gene:string|null,protein_name:string|null,organism_id:number|null,reviewed:boolean|null},query,page_size,n_records,total_results:number|null,has_more,next_cursor:string|null,release:string|null,records:[{accession,entry_name:string|null,reviewed:boolean,protein_names:string[],gene_names:string[],organism_id:number|null,organism_name:string|null,length:number|null}]}. total_results and release come from upstream headers, or null if absent; n_records is only this page. protein_names contains top-level recommended, submitted and alternative full names; gene_names includes names, synonyms and locus/ORF names, with duplicates removed. Missing names are empty arrays, not proof that a protein lacks a name/gene. length is amino-acid count; sequences and full annotations are not returned. Pass accession values to get_uniprot_entries for fields, FASTA or full text. No automatic page traversal or local result cache.',
    example:
      'const result = await host.mcp("genes", "search_uniprot_entries", {"gene": "TP53", "organism_id": 9606, "reviewed": true, "page_size": 25})',
    run: async (ctx, args) => {
      const clauses = ['active:true']
      const texts: Record<string, string | null> = { gene: null, protein_name: null }
      for (const field of ['gene', 'protein_name']) {
        const value = args[field]
        if (value === undefined) continue
        if (
          typeof value !== 'string' ||
          [...value].length > 200 ||
          !new RegExp(UNIPROT_SEARCH_TEXT).test(value)
        )
          throw new Error(
            `${field} must be nonempty text of at most 200 Unicode characters without quotes, backslashes, wildcards or control characters`
          )
        texts[field] = value.trim()
        clauses.push(`${field === 'gene' ? 'gene_exact' : field}:"${texts[field]}"`)
      }
      if (args.organism_id !== undefined) {
        if (
          typeof args.organism_id !== 'number' ||
          !Number.isInteger(args.organism_id) ||
          args.organism_id < 1 ||
          args.organism_id > 2147483647
        )
          throw new Error('organism_id must be a positive NCBI taxonomy integer')
        clauses.push(`organism_id:${args.organism_id}`)
      }
      if (clauses.length === 1) throw new Error('provide gene, protein_name or organism_id')
      if (args.reviewed !== undefined) {
        if (typeof args.reviewed !== 'boolean') throw new Error('reviewed must be a boolean')
        clauses.push(`reviewed:${args.reviewed}`)
      }
      const pageSize = args.page_size ?? 25
      if (
        typeof pageSize !== 'number' ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 500
      )
        throw new Error('page_size must be an integer from 1 to 500')
      if (
        args.cursor !== undefined &&
        (typeof args.cursor !== 'string' ||
          [...args.cursor].length > 4096 ||
          !new RegExp(UNIPROT_CURSOR).test(args.cursor))
      )
        throw new Error('cursor must be a nonempty opaque token of at most 4096 characters')
      const query = clauses.join(' AND ')
      const params = new URLSearchParams({
        query,
        format: 'json',
        fields: UNIPROT_SEARCH_FIELDS,
        size: String(pageSize),
        sort: 'accession asc'
      })
      if (typeof args.cursor === 'string') params.set('cursor', args.cursor)
      const { body, headers } = await ctx.fetchJsonWithHeaders(`${UNIPROT}/search?${params}`)
      const payload = searchObject(body, 'expected a result object')
      if (!Array.isArray(payload.results) || payload.results.length > pageSize)
        invalidUniProtSearch('missing or oversized results')
      const records = payload.results.map(searchRecord)
      if (new Set(records.map((record) => record.accession)).size !== records.length)
        invalidUniProtSearch('duplicate accession')
      const totalHeader = headers.get('x-total-results')
      const total = totalHeader === null ? null : Number(totalHeader)
      if (
        total !== null &&
        (!/^\d+$/.test(totalHeader!) || !Number.isSafeInteger(total) || total < records.length)
      )
        invalidUniProtSearch('invalid X-Total-Results')
      const nextCursor = searchNextCursor(headers, args.cursor)
      if (nextCursor && !records.length) invalidUniProtSearch('empty page with a next cursor')
      if (args.cursor === undefined && total !== null && total > records.length && !nextCursor)
        invalidUniProtSearch('missing next cursor for an incomplete first page')
      return {
        filters: {
          ...texts,
          organism_id: args.organism_id ?? null,
          reviewed: args.reviewed ?? null
        },
        query,
        page_size: pageSize,
        n_records: records.length,
        total_results: total,
        has_more: nextCursor !== null,
        next_cursor: nextCursor,
        release: headers.get('x-uniprot-release'),
        records
      }
    }
  },
  {
    id: 'query_genes',
    connector: 'genes',
    description:
      'Resolve gene identifiers/symbols via mygene.info (batched, up to 1000 terms/request). Use this to map gene symbols to Ensembl gene IDs, Entrez IDs, names, and any other mygene.info field — or the reverse (set `scopes` to the namespace of your input terms, e.g. "entrezgene", "ensembl.gene", "symbol,alias"). Args: terms (query terms, e.g. ["TP53","BRCA1"]; terms containing commas are not supported); scopes (comma-separated identifier namespaces to match terms against); fields (comma-separated mygene fields to return, or "all"); species (common name "human"/"mouse" or NCBI taxid). Returns {n_input, n_records, not_found, records}. A term matching several genes yields several records (each carries its `query`). Records are deterministically ordered (input order, then _id).',
    input: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' } },
        scopes: { type: 'string' },
        fields: { type: 'string', default: 'symbol,name,taxid,entrezgene,ensembl.gene' },
        species: { type: 'string' }
      },
      required: ['terms']
    },
    required: ['terms'],
    returns:
      '{n_input, n_records, not_found:[terms with no match], records:[mygene hit objects, each with `query`, `_id` and the requested fields]} — records ordered by input position of `query`, then `_id`.',
    example:
      'const result = await host.mcp("genes", "query_genes", {"terms": ["TP53", "BRCA1"], "scopes": "symbol,alias", "fields": "symbol,name,entrezgene,ensembl.gene", "species": "human"})',
    run: async (ctx, a) => {
      const terms = Array.isArray(a.terms) ? (a.terms as unknown[]).map(String) : []
      // Commas would be misread as a multi-value delimiter by mygene — reject them explicitly.
      const withComma = terms.find((t) => t.includes(','))
      if (withComma != null) {
        throw new Error(`query_genes: term '${withComma}' contains a comma, which is not supported`)
      }
      if (terms.length === 0) return { n_input: 0, n_records: 0, not_found: [], records: [] }

      // Only forward the optional scopes/species; fields defaults to a lean identity set.
      const body: Record<string, unknown> = {
        fields:
          a.fields != null && String(a.fields) !== ''
            ? String(a.fields)
            : 'symbol,name,taxid,entrezgene,ensembl.gene'
      }
      if (a.scopes != null && String(a.scopes) !== '') body.scopes = String(a.scopes)
      if (a.species != null && String(a.species) !== '') body.species = String(a.species)

      const hits = await mygeneBatch(ctx, terms, body)
      const records = hits.filter((h) => h.notfound !== true)

      // not_found: input terms for which no real (non-notfound) record came back.
      const foundQueries = new Set(records.map((r) => String(r.query)))
      const notFound = terms.filter((t) => !foundQueries.has(t))

      // Deterministic order: first input position of the record's `query`, then `_id`.
      const firstPos = new Map<string, number>()
      terms.forEach((t, i) => {
        if (!firstPos.has(t)) firstPos.set(t, i)
      })
      records.sort((x, y) => {
        const px = firstPos.get(String(x.query)) ?? Number.MAX_SAFE_INTEGER
        const py = firstPos.get(String(y.query)) ?? Number.MAX_SAFE_INTEGER
        if (px !== py) return px - py
        return String(x._id ?? '').localeCompare(String(y._id ?? ''))
      })

      return {
        n_input: terms.length,
        n_records: records.length,
        not_found: notFound,
        records
      }
    }
  },
  {
    id: 'get_uniprot_entries',
    connector: 'genes',
    description:
      'Fetch UniProtKB records for a list of primary or secondary accessions (batched OR-queries first; unresolved aliases use a direct per-accession fallback). Three modes: `fields` given → token-lean tabular retrieval of just those UniProt fields (e.g. ["accession","id","protein_name","gene_names","organism_name","length","sequence"]); `format` is ignored. format="fasta" → per-accession FASTA sequences. format="txt" → per-accession full UniProt flat-file text (complete annotation; can be very large — prefer `fields`). Args: accessions (e.g. ["P04637","P38398"]); format ("fasta"/"txt", ignored when `fields` given); fields (optional UniProt REST field names for tabular mode). Returns: fields mode {accessions, fields, n_records, records:[{<column>:value}]}; fasta/txt mode {accessions, format, n_found, missing, records:{accession:text}} — `missing` lists accessions UniProt returned no record for.',
    input: {
      type: 'object',
      properties: {
        accessions: { type: 'array', items: { type: 'string' } },
        format: { type: 'string', enum: ['fasta', 'txt'] },
        fields: { type: 'array', items: { type: 'string' } }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      'fields mode {accessions, fields, n_records, records:[{<column>:value}]} (columns are the UniProt TSV headers); fasta/txt mode {accessions, format, n_found, missing:[...], records:{accession:text}}.',
    example:
      'const result = await host.mcp("genes", "get_uniprot_entries", {"accessions": ["P04637", "P38398"], "fields": ["accession", "id", "protein_name", "gene_names", "organism_name", "length"]})',
    run: async (ctx, a) => {
      const accessions = Array.isArray(a.accessions) ? (a.accessions as unknown[]).map(String) : []
      const fields = Array.isArray(a.fields) ? (a.fields as unknown[]).map(String) : []
      const hasFields = fields.length > 0
      const chunks = chunkAccessions(accessions)

      // Mode 1 — fields given: TSV tabular retrieval, records keyed by UniProt column headers.
      if (hasFields) {
        const records: Record<string, string>[] = []
        for (const chunk of chunks) {
          const url =
            `${UNIPROT}/search?query=${encodeURIComponent(orQuery(chunk))}` +
            `&fields=${fields.join(',')}&format=tsv&size=500`
          const tsv = await ctx.fetchText(url)
          for (const row of parseTsv(tsv)) records.push(row)
        }
        return { accessions, fields, n_records: records.length, records }
      }

      // Modes 2/3 — no fields: FASTA (default) or full flat-file text, split into a per-accession map.
      const format = a.format != null && String(a.format) === 'txt' ? 'txt' : 'fasta'
      let combined = ''
      for (const chunk of chunks) {
        const url =
          `${UNIPROT}/search?query=${encodeURIComponent(orQuery(chunk))}` +
          `&format=${format}&size=500`
        combined += await ctx.fetchText(url)
      }
      const entries = format === 'txt' ? parseFlatFile(combined) : parseFasta(combined)
      const mapped = mapEntries(accessions, entries)
      const direct = mapped.missing.length
        ? await fetchDirectEntries(ctx, mapped.missing, format)
        : { records: {}, missing: [] }
      const records = { ...mapped.records, ...direct.records }
      const missing = direct.missing
      return {
        accessions,
        format,
        n_found: Object.keys(records).length,
        missing,
        records
      }
    }
  }
]
