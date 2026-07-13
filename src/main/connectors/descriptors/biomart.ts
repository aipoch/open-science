import { DOMParser } from '@xmldom/xmldom'
import type { ToolDescriptor } from '../types'

const MARTSERVICE = 'https://www.ensembl.org/biomart/martservice'
const COMPLETION_STAMP = '[success]'

// Escapes a value for use inside a double-quoted XML attribute (mirrors the upstream Python
// build_query_xml, which relies on ElementTree's own attribute escaping).
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Filter values may be a string, a number, a bool (BioMart's own only/excluded convention), or an
// array (joined with commas) — mirrors upstream biomart_query.client.build_query_xml.
function filterValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'only' : 'excluded'
  if (Array.isArray(value)) return value.map(String).join(',')
  return String(value)
}

// Builds a martservice <Query> XML document (transcribed from upstream biomart_query.client's
// build_query_xml: header=0/uniqueRows=0 defaults, completionStamp always requested).
function buildQueryXml(
  dataset: string,
  attributes: string[],
  filters: Record<string, unknown>,
  virtualSchema: string
): string {
  const filterXml = Object.entries(filters)
    .map(
      ([name, value]) =>
        `<Filter name="${escapeXmlAttr(name)}" value="${escapeXmlAttr(filterValue(value))}" />`
    )
    .join('')
  const attrXml = attributes.map((a) => `<Attribute name="${escapeXmlAttr(a)}" />`).join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Query>' +
    `<Query virtualSchemaName="${escapeXmlAttr(virtualSchema)}" formatter="TSV" header="0" uniqueRows="0" datasetConfigVersion="0.6" completionStamp="1">` +
    `<Dataset name="${escapeXmlAttr(dataset)}" interface="default">${filterXml}${attrXml}</Dataset>` +
    '</Query>'
  )
}

// Parses a completed martservice TSV body into rows, validating the completion stamp and column
// count (mirrors upstream biomart_query.client._post + _parse_tsv). Throws on a rejected query
// (BioMart returns 200 with a "Query ERROR" / exception body for bad attribute/filter combos) or
// a truncated response (missing the trailing [success] marker).
function parseTsvBody(text: string, nCols: number): string[][] {
  const head = text.slice(0, 2000)
  if (
    head.trimStart().toLowerCase().startsWith('<html') ||
    head.trimStart().toLowerCase().startsWith('<!doctype html')
  ) {
    throw new Error('martservice returned an HTML page (Ensembl outage/maintenance notice)')
  }
  if (text.trimStart().startsWith('Query ERROR') || head.includes('BioMart::Exception')) {
    throw new Error(`BioMart query rejected: ${text.slice(0, 500).trim()}`)
  }
  const stripped = text.replace(/[\r\n ]+$/, '')
  if (!stripped.endsWith(COMPLETION_STAMP)) {
    throw new Error(
      'martservice response missing the [success] completion stamp (truncated download)'
    )
  }
  const body = stripped.slice(0, -COMPLETION_STAMP.length).replace(/[\r\n]+$/, '')
  const rows: string[][] = []
  if (!body) return rows
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (line === '') continue
    const fields = line.split('\t')
    if (fields.length !== nCols) {
      throw new Error(
        `malformed TSV line: expected ${nCols} columns, got ${fields.length}: ${line.slice(0, 200)}`
      )
    }
    rows.push(fields)
  }
  return rows
}

type Mart = { name: string; displayName: string }

// Ensembl BioMart martservice: XML query registry + TSV attribute queries (read-only).
export const BIOMART_TOOLS: ToolDescriptor[] = [
  {
    id: 'biomart_list_marts',
    connector: 'biomart',
    description:
      'List available Ensembl BioMart marts (name and display name) from the martservice registry.',
    input: { type: 'object', properties: {} },
    returns:
      '`[ { "name": str, "displayName": str } ]` — array of registered BioMart marts; `[]` when the registry lists none.',
    format: 'text',
    url: () => `${MARTSERVICE}?type=registry`,
    parse: (raw) => {
      const doc = new DOMParser().parseFromString(String(raw), 'text/xml')
      const marts: Mart[] = []
      const locs = doc.getElementsByTagName('MartURLLocation')
      for (let i = 0; i < locs.length; i++) {
        const el = locs[i]
        marts.push({
          name: el.getAttribute('name') ?? '',
          displayName: el.getAttribute('displayName') ?? ''
        })
      }
      return marts
    }
  },
  {
    id: 'biomart_query',
    connector: 'biomart',
    description:
      'Run a BioMart attribute query against a dataset (e.g. hsapiens_gene_ensembl) with optional filters; returns parsed TSV rows in request column order.',
    input: {
      type: 'object',
      properties: {
        dataset: { type: 'string' },
        attributes: { type: 'array', items: { type: 'string' } },
        filters: { type: 'object' },
        virtual_schema: { type: 'string', default: 'default' }
      },
      required: ['dataset', 'attributes']
    },
    required: ['dataset', 'attributes'],
    returns:
      '`{ "dataset": str, "columns": [str], "rows": [[str]] }` — `columns` echoes the requested attributes and each row is a string array in that column order. `rows` is sorted lexicographically and `[]` when nothing matches.',
    run: async (ctx, a) => {
      const dataset = String(a.dataset)
      const attributes = (a.attributes as unknown[]).map(String)
      const filters = (a.filters ?? {}) as Record<string, unknown>
      const virtualSchema = String(a.virtual_schema ?? 'default')
      const xml = buildQueryXml(dataset, attributes, filters, virtualSchema)
      // martservice's documented GET form: the XML query as a `query` URL parameter (equivalent
      // to upstream's POST body={"query": xml}; avoids needing a raw form-POST context method).
      const url = `${MARTSERVICE}?query=${encodeURIComponent(xml)}`
      const text = await ctx.fetchText(url)
      const rows = parseTsvBody(text, attributes.length)
      rows.sort((x, y) => (x.join('\t') < y.join('\t') ? -1 : x.join('\t') > y.join('\t') ? 1 : 0))
      return { dataset, columns: attributes, rows }
    }
  }
]
