import { DOMParser } from '@xmldom/xmldom'
import type { ToolDescriptor } from '../types'

const MARTSERVICE = 'https://www.ensembl.org/biomart/martservice'
const COMPLETION_STAMP = '[success]'
// Ensembl marts share a single virtual schema; the martservice attribute/filter/query endpoints key
// off the dataset name, so `mart` is part of the tool signature only for datasets discovery + parity.
const VIRTUAL_SCHEMA = 'default'

// Curated set of the most-used gene attributes, surfaced by list_common_attributes so the model gets a
// short, high-signal menu instead of the full (hundreds-long) attribute list from list_all_attributes.
const COMMON_ATTRIBUTES = new Set<string>([
  'ensembl_gene_id',
  'ensembl_gene_id_version',
  'ensembl_transcript_id',
  'ensembl_transcript_id_version',
  'ensembl_peptide_id',
  'ensembl_peptide_id_version',
  'external_gene_name',
  'external_transcript_name',
  'description',
  'chromosome_name',
  'start_position',
  'end_position',
  'strand',
  'band',
  'gene_biotype',
  'transcript_biotype',
  'source',
  'hgnc_id',
  'hgnc_symbol',
  'entrezgene_id',
  'entrezgene_accession',
  'uniprotswissprot',
  'uniprot_gn_id',
  'refseq_mrna',
  'refseq_peptide',
  'refseq_ncrna',
  'go_id',
  'name_1006',
  'transcript_length',
  'percentage_gene_gc_content',
  'ccds'
])

// Microarray probe attributes are bulky and rarely needed; list_all_attributes drops them (and the
// homologs page) to keep the response manageable.
const PROBE_PREFIX = /^(affy|agilent|illumina|codelink|phalanx)_/

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

// Builds a martservice <Query> XML document (header=0/uniqueRows=0 defaults, completionStamp always
// requested so a truncated download can be detected).
function buildQueryXml(
  dataset: string,
  attributes: string[],
  filters: Record<string, unknown>
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
    `<Query virtualSchemaName="${VIRTUAL_SCHEMA}" formatter="TSV" header="0" uniqueRows="0" datasetConfigVersion="0.6" completionStamp="1">` +
    `<Dataset name="${escapeXmlAttr(dataset)}" interface="default">${filterXml}${attrXml}</Dataset>` +
    '</Query>'
  )
}

// The GET form of the martservice query: the XML document passed as a `query` URL parameter.
function queryUrl(dataset: string, attributes: string[], filters: Record<string, unknown>): string {
  return `${MARTSERVICE}?query=${encodeURIComponent(buildQueryXml(dataset, attributes, filters))}`
}

// Parses a completed martservice TSV body into rows, validating the completion stamp and column count
// (mirrors upstream _post + _parse_tsv). Throws on a rejected query (BioMart returns 200 with a
// "Query ERROR" / exception body for bad attribute/filter combos) or a truncated response.
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

// Splits a martservice registry-style TSV body (list endpoints) into non-empty tab-delimited rows.
function tsvRows(raw: unknown): string[][] {
  return String(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t'))
}

// martservice lists an attribute/filter once per config page it appears on; collapse to the first
// occurrence by name (col0, which carries the richest description) so list_* tools return a
// deduplicated menu instead of the same id repeated across pages.
function dedupeByName(rows: string[][]): string[][] {
  const seen = new Set<string>()
  return rows.filter((r) => {
    const key = r[0] ?? ''
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Quotes a CSV field only when it contains a comma, quote, or newline (RFC-4180 minimal quoting).
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

// Renders a header + rows as a CSV string — the return shape every list_*/get_data tool produces.
function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\n')
}

// Ensembl BioMart martservice: a MART -> DATASET -> ATTRIBUTES/FILTERS registry plus TSV attribute
// queries and identifier translation (read-only). Tool names and shapes mirror the openscience BioMart
// connector: list endpoints and get_data return CSV strings; translations return a value / mapping.
export const BIOMART_TOOLS: ToolDescriptor[] = [
  {
    id: 'list_marts',
    connector: 'biomart',
    description:
      'List available Ensembl BioMart marts (databases). BioMart organizes data as MART -> DATASET -> ATTRIBUTES/FILTERS; a mart name feeds list_datasets.',
    input: { type: 'object', properties: {} },
    returns:
      'CSV string with header `name,display_name,description` — one row per mart (e.g. `ENSEMBL_MART_ENSEMBL,Ensembl Genes 116,...`). Header-only when the registry lists no marts.',
    example: 'result = host.mcp("biomart", "list_marts", {})',
    format: 'text',
    url: () => `${MARTSERVICE}?type=registry`,
    parse: (raw) => {
      const doc = new DOMParser().parseFromString(String(raw), 'text/xml')
      const locs = doc.getElementsByTagName('MartURLLocation')
      const rows: string[][] = []
      for (let i = 0; i < locs.length; i++) {
        const el = locs[i]
        if (el.getAttribute('visible') === '0') continue
        const name = el.getAttribute('name') ?? ''
        const display = el.getAttribute('displayName') ?? ''
        rows.push([name, display, display])
      }
      return toCsv(['name', 'display_name', 'description'], rows)
    }
  },
  {
    id: 'list_datasets',
    connector: 'biomart',
    description:
      'List the datasets available in a given mart (e.g. hsapiens_gene_ensembl for human genes). A dataset name feeds the attribute/filter/query tools.',
    input: {
      type: 'object',
      properties: { mart: { type: 'string' } },
      required: ['mart']
    },
    required: ['mart'],
    returns:
      'CSV string with header `name,display_name,description` — one row per dataset (`description` is the assembly/version, e.g. `GRCh38.p14`).',
    example: 'result = host.mcp("biomart", "list_datasets", {"mart": "ENSEMBL_MART_ENSEMBL"})',
    format: 'text',
    url: (a) => `${MARTSERVICE}?type=datasets&mart=${encodeURIComponent(String(a.mart))}`,
    parse: (raw) => {
      const rows = tsvRows(raw)
        .filter((f) => f[0] === 'TableSet')
        .map((f) => [f[1] ?? '', f[2] ?? '', f[4] ?? ''])
      return toCsv(['name', 'display_name', 'description'], rows)
    }
  },
  {
    id: 'list_common_attributes',
    connector: 'biomart',
    description:
      'List the commonly used attributes for a dataset (a curated high-signal subset). Use this before list_all_attributes to pick attributes for get_data. `mart` is accepted for signature parity but ignored; the query keys off `dataset`.',
    input: {
      type: 'object',
      properties: { mart: { type: 'string' }, dataset: { type: 'string' } },
      required: ['mart', 'dataset']
    },
    required: ['mart', 'dataset'],
    returns:
      'CSV string with header `name,display_name,description` — the subset of the dataset’s attributes that are commonly used identifiers/annotations.',
    example:
      'result = host.mcp("biomart", "list_common_attributes", {"mart": "ENSEMBL_MART_ENSEMBL", "dataset": "hsapiens_gene_ensembl"})',
    format: 'text',
    url: (a) => `${MARTSERVICE}?type=attributes&dataset=${encodeURIComponent(String(a.dataset))}`,
    parse: (raw) => {
      const rows = dedupeByName(
        tsvRows(raw)
          .filter((f) => COMMON_ATTRIBUTES.has(f[0] ?? ''))
          .map((f) => [f[0] ?? '', f[1] ?? '', f[2] ?? ''])
      )
      return toCsv(['name', 'display_name', 'description'], rows)
    }
  },
  {
    id: 'list_all_attributes',
    connector: 'biomart',
    description:
      'List all attributes available for a dataset, minus homologs and microarray probes (which are bulky and rarely needed). Can be large; prefer list_common_attributes first. `mart` is accepted for signature parity but ignored; the query keys off `dataset`.',
    input: {
      type: 'object',
      properties: { mart: { type: 'string' }, dataset: { type: 'string' } },
      required: ['mart', 'dataset']
    },
    required: ['mart', 'dataset'],
    returns:
      'CSV string with header `name,display_name,description` — every attribute except the homologs page and microarray-probe attributes.',
    example:
      'result = host.mcp("biomart", "list_all_attributes", {"mart": "ENSEMBL_MART_ENSEMBL", "dataset": "hsapiens_gene_ensembl"})',
    format: 'text',
    url: (a) => `${MARTSERVICE}?type=attributes&dataset=${encodeURIComponent(String(a.dataset))}`,
    parse: (raw) => {
      const rows = dedupeByName(
        tsvRows(raw)
          .filter((f) => {
            const name = f[0] ?? ''
            const page = f[3] ?? ''
            return page !== 'homologs' && !name.includes('homolog') && !PROBE_PREFIX.test(name)
          })
          .map((f) => [f[0] ?? '', f[1] ?? '', f[2] ?? ''])
      )
      return toCsv(['name', 'display_name', 'description'], rows)
    }
  },
  {
    id: 'list_filters',
    connector: 'biomart',
    description:
      'List the filters available for a dataset. Filters narrow a get_data query (e.g. chromosome_name, biotype) and are passed to get_data as a filters dict. `mart` is accepted for signature parity but ignored; the query keys off `dataset`.',
    input: {
      type: 'object',
      properties: { mart: { type: 'string' }, dataset: { type: 'string' } },
      required: ['mart', 'dataset']
    },
    required: ['mart', 'dataset'],
    returns:
      'CSV string with header `name,description` — one row per filter name and its human-readable label.',
    example:
      'result = host.mcp("biomart", "list_filters", {"mart": "ENSEMBL_MART_ENSEMBL", "dataset": "hsapiens_gene_ensembl"})',
    format: 'text',
    url: (a) => `${MARTSERVICE}?type=filters&dataset=${encodeURIComponent(String(a.dataset))}`,
    parse: (raw) => {
      const rows = dedupeByName(tsvRows(raw).map((f) => [f[0] ?? '', f[1] ?? '']))
      return toCsv(['name', 'description'], rows)
    }
  },
  {
    id: 'get_data',
    connector: 'biomart',
    description:
      'Run a BioMart query: retrieve the requested attributes for a dataset, optionally narrowed by filters. This is the main data-retrieval tool. `mart` is accepted for signature parity but ignored; the query keys off `dataset`.',
    input: {
      type: 'object',
      properties: {
        mart: { type: 'string' },
        dataset: { type: 'string' },
        attributes: { type: 'array', items: { type: 'string' } },
        filters: { type: 'object' }
      },
      required: ['mart', 'dataset', 'attributes']
    },
    required: ['mart', 'dataset', 'attributes'],
    returns:
      'CSV string whose header row is the requested attributes, followed by one row per matching record (in BioMart order). Header-only when nothing matches.',
    example:
      'result = host.mcp("biomart", "get_data", {"mart": "ENSEMBL_MART_ENSEMBL", "dataset": "hsapiens_gene_ensembl", "attributes": ["ensembl_gene_id", "external_gene_name", "chromosome_name"], "filters": {"chromosome_name": "Y", "biotype": "protein_coding"}})',
    format: 'text',
    url: (a) =>
      queryUrl(
        String(a.dataset),
        (a.attributes as unknown[]).map(String),
        (a.filters ?? {}) as Record<string, unknown>
      ),
    parse: (raw, a) => {
      const attributes = (a.attributes as unknown[]).map(String)
      const rows = parseTsvBody(String(raw), attributes.length)
      return toCsv(attributes, rows)
    }
  },
  {
    id: 'get_translation',
    connector: 'biomart',
    description:
      'Translate a single identifier from one attribute type to another (e.g. an HGNC symbol to an Ensembl gene ID) within a dataset. `mart` is accepted for signature parity but ignored; the query keys off `dataset`.',
    input: {
      type: 'object',
      properties: {
        mart: { type: 'string' },
        dataset: { type: 'string' },
        from_attr: { type: 'string' },
        to_attr: { type: 'string' },
        target: { type: 'string' }
      },
      required: ['mart', 'dataset', 'from_attr', 'to_attr', 'target']
    },
    required: ['mart', 'dataset', 'from_attr', 'to_attr', 'target'],
    returns:
      'The translated identifier as a string, or a `No translation found ...` message string when the source id has no mapping.',
    example:
      'result = host.mcp("biomart", "get_translation", {"mart": "ENSEMBL_MART_ENSEMBL", "dataset": "hsapiens_gene_ensembl", "from_attr": "hgnc_symbol", "to_attr": "ensembl_gene_id", "target": "TP53"})',
    format: 'text',
    url: (a) =>
      queryUrl(String(a.dataset), [String(a.from_attr), String(a.to_attr)], {
        [String(a.from_attr)]: String(a.target)
      }),
    parse: (raw, a) => {
      const target = String(a.target)
      const rows = parseTsvBody(String(raw), 2)
      const match = rows.find((r) => r[0] === target && r[1]) ?? rows.find((r) => r[1])
      return (
        match?.[1] ??
        `No translation found for '${target}' (${String(a.from_attr)} -> ${String(a.to_attr)}).`
      )
    }
  },
  {
    id: 'batch_translate',
    connector: 'biomart',
    description:
      'Translate many identifiers from one attribute type to another in a single query — more efficient than repeated get_translation calls. `mart` is accepted for signature parity but ignored; the query keys off `dataset`.',
    input: {
      type: 'object',
      properties: {
        mart: { type: 'string' },
        dataset: { type: 'string' },
        from_attr: { type: 'string' },
        to_attr: { type: 'string' },
        targets: { type: 'array', items: { type: 'string' } }
      },
      required: ['mart', 'dataset', 'from_attr', 'to_attr', 'targets']
    },
    required: ['mart', 'dataset', 'from_attr', 'to_attr', 'targets'],
    returns:
      '`{ "translations": { <input>: <translated> }, "not_found": [str], "found_count": int, "not_found_count": int }` — `translations` maps each resolved input id to its target id.',
    example:
      'result = host.mcp("biomart", "batch_translate", {"mart": "ENSEMBL_MART_ENSEMBL", "dataset": "hsapiens_gene_ensembl", "from_attr": "hgnc_symbol", "to_attr": "ensembl_gene_id", "targets": ["TP53", "BRCA1", "BRCA2"]})',
    format: 'text',
    url: (a) => {
      const targets = (a.targets as unknown[]).map(String)
      return queryUrl(String(a.dataset), [String(a.from_attr), String(a.to_attr)], {
        [String(a.from_attr)]: targets
      })
    },
    parse: (raw, a) => {
      const targets = (a.targets as unknown[]).map(String)
      const rows = parseTsvBody(String(raw), 2)
      const translations: Record<string, string> = {}
      for (const [from, to] of rows) {
        if (from && to && !(from in translations)) translations[from] = to
      }
      const notFound = targets.filter((t) => !(t in translations))
      return {
        translations,
        not_found: notFound,
        found_count: Object.keys(translations).length,
        not_found_count: notFound.length
      }
    }
  }
]
