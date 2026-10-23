import { abortableDelay, type ToolContext, type ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://rest.kegg.jp'
const TERMS =
  'Public KEGG API is for eligible academic use only; non-academic use and service provision require appropriate licensing. Enabling this connector does not grant a license.'
let nextRequestAt = 0
async function read(ctx: ToolContext, path: string): Promise<string> {
  for (;;) {
    ctx.signal?.throwIfAborted()
    const wait = nextRequestAt - Date.now()
    if (wait <= 0) {
      nextRequestAt = Date.now() + 400
      break
    }
    await abortableDelay(wait, ctx.signal)
  }
  return ctx.fetchText(`${API}/${path}`, 'text/plain', { retry: false })
}
function pairs(raw: string): string[][] {
  if (!raw.trim()) return []
  return raw
    .trimEnd()
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r$/u, '').split('\t')
      if (parts.length !== 2 || !parts[0] || !parts[1] || parts.some((p) => p.length > 4000))
        throw new Error('KEGG returned malformed tabular data')
      return parts
    })
}
const common = { connector: 'kegg', credentialKeys: [], maxResponseBytes: 2_000_000 }
const limit = { type: 'integer', minimum: 1, maximum: 100 }
const gene = { type: 'string', maxLength: 80, pattern: '^[a-z][a-z0-9]{1,4}:[A-Za-z0-9_.-]+$' }
export const KEGG_TOOLS: ToolDescriptor[] = [
  {
    ...common,
    id: 'search_entries',
    description: `Search KEGG pathway, KO, compound or reaction names. Returns a capped list, not server-side pagination; narrow the query when truncated. ${TERMS}`,
    input: {
      type: 'object',
      properties: {
        database: { type: 'string', enum: ['pathway', 'ko', 'compound', 'reaction'] },
        query: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        limit
      },
      required: ['database', 'query'],
      additionalProperties: false
    },
    required: ['database', 'query'],
    exampleArgs: { database: 'pathway', query: 'glycolysis' },
    returns:
      '{ source_url, records:[{id,name}], returned, matched, truncated }. matched counts rows in the bounded upstream response, not a global total.',
    run: async (ctx, args) => {
      const path = `find/${args.database}/${encodeURIComponent(String(args.query).trim())}`
      const rows = pairs(await read(ctx, path))
      const patterns: Record<string, RegExp> = {
        pathway: /^(?:path:)?map\d{5}$/u,
        ko: /^(?:ko:)?K\d{5}$/u,
        compound: /^(?:cpd:)?C\d{5}$/u,
        reaction: /^(?:rn:)?R\d{5}$/u
      }
      if (rows.some(([id]) => !patterns[String(args.database)]!.test(id!)))
        throw new Error('KEGG returned an unexpected search identifier')
      const records = rows
        .slice(0, Number(args.limit ?? 20))
        .map(([id, name]) => ({ id: id!.replace(/^[a-z]+:/u, ''), name }))
      return {
        source_url: `${API}/${path}`,
        records,
        returned: records.length,
        matched: rows.length,
        truncated: rows.length > records.length
      }
    }
  },
  {
    ...common,
    id: 'get_entry',
    description: `Read one KEGG pathway, KO, compound or reaction summary. Returns selected flatfile fields with explicit truncation; excludes bulk GENES, sequences and pathway images. HTTP 404 is not an empty record. ${TERMS}`,
    input: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^(?:[KCR][0-9]{5}|(?:map|[a-z]{3,4})[0-9]{5})$' }
      },
      required: ['id'],
      additionalProperties: false
    },
    required: ['id'],
    exampleArgs: { id: 'hsa00010' },
    returns:
      '{ source_url, id, fields, truncated, selected_fields_only:true }. fields contains at most 30 lines of 500 characters each per selected field. Unselected sections are intentionally omitted.',
    run: async (ctx, args) => {
      const path = `get/${args.id}`,
        raw = await read(ctx, path)
      if (!raw.startsWith('ENTRY ') || !raw.trimEnd().endsWith('///'))
        throw new Error('KEGG returned an incomplete flatfile record')
      const identity = /^ENTRY\s+(\S+)/u.exec(raw)?.[1]
      if (identity !== args.id) throw new Error('KEGG returned a different entry identifier')
      const allowed = new Set([
        'ENTRY',
        'NAME',
        'SYMBOL',
        'DEFINITION',
        'DESCRIPTION',
        'FORMULA',
        'EXACT_MASS',
        'MOL_WEIGHT',
        'EQUATION',
        'ENZYME',
        'PATHWAY',
        'MODULE',
        'ORTHOLOGY',
        'DBLINKS'
      ])
      const fields: Record<string, string[]> = {}
      let key = '',
        truncated = false
      for (const line of raw.split('\n')) {
        if (line.trim() === '///') continue
        const field = line.slice(0, 12).trim()
        if (field) key = field
        if (!allowed.has(key)) continue
        const value = line.slice(12).trim()
        if (!value) continue
        const values = (fields[key] ??= [])
        if (values.length >= 30) {
          truncated = true
          continue
        }
        if (value.length > 500) truncated = true
        values.push(value.slice(0, 500))
      }
      return {
        source_url: `${API}/${path}`,
        id: args.id,
        fields,
        truncated,
        selected_fields_only: true
      }
    }
  },
  {
    ...common,
    id: 'map_gene',
    description: `Map one organism-qualified KEGG gene to pathways or UniProt accessions. Preserves one-to-many matches; no automatic choice of a canonical protein. Results are capped without server-side pagination. ${TERMS}`,
    input: {
      type: 'object',
      properties: { gene, target: { type: 'string', enum: ['pathway', 'uniprot'] }, limit },
      required: ['gene', 'target'],
      additionalProperties: false
    },
    required: ['gene', 'target'],
    exampleArgs: { gene: 'hsa:7157', target: 'uniprot' },
    returns:
      '{ source_url, mappings:[{from,to}], matched, truncated }. Empty matches do not prove absence of biological relationships.',
    run: async (ctx, args) => {
      const path = `${args.target === 'pathway' ? 'link/pathway' : 'conv/uniprot'}/${encodeURIComponent(String(args.gene))}`
      const rows = pairs(await read(ctx, path))
      const target = args.target === 'pathway' ? /^path:[a-z]{2,4}\d{5}$/u : /^up:[A-Z0-9]+$/u
      if (rows.some(([from, to]) => from !== args.gene || !target.test(to!)))
        throw new Error('KEGG returned inconsistent mapping identities')
      const mappings = rows.slice(0, Number(args.limit ?? 50)).map(([from, to]) => ({ from, to }))
      return {
        source_url: `${API}/${path}`,
        mappings,
        matched: rows.length,
        truncated: rows.length > mappings.length
      }
    }
  }
]
