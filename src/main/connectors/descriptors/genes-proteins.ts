import type { ToolContext, ToolDescriptor } from '../types'

// mygene.info batch gene resolution + UniProtKB record retrieval. mygene answers a POST /query with a
// JSON array (one item per query term, misses flagged notfound:true); UniProt is queried with a single
// batched OR-query over accessions and served as TSV (token-lean tabular), FASTA, or flat-file text.
const MYGENE = 'https://mygene.info/v3'
const UNIPROT = 'https://rest.uniprot.org/uniprotkb'

// mygene batch caps at 1000 terms/request; UniProt OR-queries are chunked to keep the URL bounded.
const MYGENE_BATCH = 1000
const UNIPROT_CHUNK = 100

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

// Builds the batched OR filter, e.g. (accession:P04637)OR(accession:P38398).
function orQuery(chunk: string[]): string {
  return chunk.map((a) => `(accession:${a})`).join('OR')
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

export const GENES_PROTEINS_TOOLS: ToolDescriptor[] = [
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
      'Fetch UniProtKB records for a list of accessions (batched OR-queries, not per-accession). Three modes: `fields` given → token-lean tabular retrieval of just those UniProt fields (e.g. ["accession","id","protein_name","gene_names","organism_name","length","sequence"]); `format` is ignored. format="fasta" → per-accession FASTA sequences. format="txt" → per-accession full UniProt flat-file text (complete annotation; can be very large — prefer `fields`). Args: accessions (e.g. ["P04637","P38398"]); format ("fasta"/"txt", ignored when `fields` given); fields (optional UniProt REST field names for tabular mode). Returns: fields mode {accessions, fields, n_records, records:[{<column>:value}]}; fasta/txt mode {accessions, format, n_found, missing, records:{accession:text}} — `missing` lists accessions UniProt returned no record for.',
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
      const { records, missing } = mapEntries(accessions, entries)
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
