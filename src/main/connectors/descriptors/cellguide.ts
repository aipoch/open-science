import type { ToolContext, ToolDescriptor } from '../types'

// CellGuide (CELLxGENE) serves static, snapshot-versioned JSON blobs from this CDN — no live
// query/search API. Everything is a GET of a snapshot-scoped blob keyed by Cell Ontology (CL) id,
// so "search" is done client-side over celltype_metadata.json and there is no name->id endpoint
// (names are resolved against that same metadata). The canonical vs computational marker blobs have
// different record shapes: computational markers are data-derived {marker_score, specificity, me,
// pc, groupby_dims}, while canonical markers are literature-curated {tissue, symbol, name,
// publication, publication_titles} with no score field.
const BASE_URL = 'https://cellguide.cellxgene.cziscience.com'

// Bound list-returning tools like the other connectors, rather than returning every row unbounded.
const DEFAULT_LIMIT = 25

type CellTypeMetadataEntry = {
  name?: string
  id?: string
  clDescription?: string
  synonyms?: string[]
}
type CellTypeMetadata = Record<string, CellTypeMetadataEntry>

type CanonicalMarkerGene = {
  tissue?: string
  symbol?: string
  name?: string
  publication?: string
  publication_titles?: string
}

type ComputationalMarkerGene = {
  me?: number
  pc?: number
  marker_score?: number
  specificity?: number
  gene_ontology_term_id?: string
  symbol?: string
  name?: string
  groupby_dims?: Record<string, unknown>
}

type OntologyRef = { label?: string; ontology_term_id?: string }
type SourceCollection = {
  collection_name?: string
  collection_url?: string
  publication_url?: string
  publication_title?: string
  tissue?: OntologyRef[]
  disease?: OntologyRef[]
  organism?: OntologyRef[]
}

type ValidatedDescription = { description?: string; references?: unknown[] }

// CL:0000622 <-> CL_0000622 <-> 0000622 (mirrors client.py's to_url_format/to_json_format).
function toUrlFormat(cellId: string): string {
  if (cellId.includes('_') && cellId.startsWith('CL_')) return cellId
  if (cellId.includes(':')) return cellId.replace(':', '_')
  if (/^\d+$/.test(cellId)) return `CL_${cellId}`
  return cellId
}

function toJsonFormat(cellId: string): string {
  if (cellId.includes(':') && cellId.startsWith('CL:')) return cellId
  if (cellId.includes('_')) return cellId.replace('_', ':')
  if (/^\d+$/.test(cellId)) return `CL:${cellId}`
  return cellId
}

async function fetchSnapshotId(ctx: ToolContext): Promise<string> {
  return (await ctx.fetchText(`${BASE_URL}/latest_snapshot_identifier`)).trim()
}

// client.py swallows fetch failures for the optional blobs (description/markers/sources may not
// exist for every cell type) and falls back to empty results; mirror that instead of failing.
async function tryFetchJson(ctx: ToolContext, url: string): Promise<unknown | undefined> {
  try {
    return await ctx.fetchJson(url)
  } catch {
    return undefined
  }
}

// The CDN has no name->id endpoint, so both an id (any of CL:x / CL_x / bare digits) and a free-text
// name/synonym are resolved against celltype_metadata.json: try a direct id lookup first, then fall
// back to a case-insensitive name/synonym match.
function resolveCellId(
  metadata: CellTypeMetadata,
  input: string
): { id: string; entry: CellTypeMetadataEntry } | undefined {
  const jsonId = toJsonFormat(input)
  const direct = metadata[jsonId]
  if (direct) return { id: jsonId, entry: direct }
  const q = input.trim().toLowerCase()
  for (const [id, entry] of Object.entries(metadata)) {
    if ((entry.name ?? '').toLowerCase() === q) return { id, entry }
    if ((entry.synonyms ?? []).some((s) => s.toLowerCase() === q)) return { id, entry }
  }
  return undefined
}

// Shared preamble for the four cell-type tools: fetch the snapshot + metadata and resolve the
// id-or-name argument, returning an { error } sentinel when the cell type is unknown.
async function loadCellType(
  ctx: ToolContext,
  input: string
): Promise<
  | { snapshot: string; jsonId: string; urlId: string; entry: CellTypeMetadataEntry }
  | { error: string }
> {
  const snapshot = await fetchSnapshotId(ctx)
  const metadata = (await ctx.fetchJson(
    `${BASE_URL}/${snapshot}/celltype_metadata.json`
  )) as CellTypeMetadata
  const resolved = resolveCellId(metadata, input)
  if (!resolved) return { error: `Cell type '${input}' not found` }
  return { snapshot, jsonId: resolved.id, urlId: toUrlFormat(resolved.id), entry: resolved.entry }
}

async function fetchDescription(
  ctx: ToolContext,
  urlId: string
): Promise<{ description: string; references: unknown[]; source: string }> {
  const validated = await tryFetchJson(
    ctx,
    `${BASE_URL}/validated_descriptions/${encodeURIComponent(urlId)}.json`
  )
  if (validated && typeof validated === 'object') {
    const v = validated as ValidatedDescription
    return { description: v.description ?? '', references: v.references ?? [], source: 'validated' }
  }
  // GPT-generated descriptions are stored as a bare JSON string, not an object.
  const gpt = await tryFetchJson(
    ctx,
    `${BASE_URL}/gpt_descriptions/${encodeURIComponent(urlId)}.json`
  )
  if (typeof gpt === 'string') return { description: gpt, references: [], source: 'gpt' }
  return { description: '', references: [], source: 'none' }
}

function formatCanonicalMarker(g: CanonicalMarkerGene): Record<string, unknown> {
  return {
    symbol: g.symbol,
    name: g.name,
    tissue: g.tissue,
    publication: g.publication || undefined,
    publicationTitle: g.publication_titles || undefined
  }
}

function formatComputationalMarker(g: ComputationalMarkerGene): Record<string, unknown> {
  return {
    symbol: g.symbol,
    name: g.name,
    geneId: g.gene_ontology_term_id,
    markerScore: g.marker_score,
    specificity: g.specificity,
    meanExpression: g.me,
    percentExpressing: g.pc,
    groupbyDims: g.groupby_dims
  }
}

function refList(refs: OntologyRef[] | undefined): Array<{ id?: string; label?: string }> {
  return (refs ?? []).map((r) => ({ id: r.ontology_term_id, label: r.label }))
}

// CellGuide CDN tools: cell-type identity/description, client-side name search, canonical or
// computational marker genes, source datasets/publications, and the anatomical tissues a cell type
// is observed in (aggregated from the source collections, since there is no per-cell tissue blob).
export const CELLGUIDE_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_cell_type_info',
    connector: 'cellguide',
    description:
      'CellGuide (CELLxGENE) cell-type info by Cell Ontology id or name: name, synonyms, ontology description, and curated/GPT description.',
    input: {
      type: 'object',
      properties: {
        cell_type: {
          type: 'string',
          description:
            "Cell Ontology id (CL:0000622, CL_0000622, or 0000622) or a cell-type name/synonym (e.g. 'acinar cell')"
        }
      },
      required: ['cell_type']
    },
    required: ['cell_type'],
    returns:
      '`{ "id": str, "name": str, "synonyms": [ str ], "ontologyDescription": str, "description": str, "descriptionSource": str, "references": [ ... ] }` — `descriptionSource` is `validated`, `gpt`, or `none` (with `description` empty). Returns `{ "error": str }` when the cell type is not found.',
    example: 'result = host.mcp("cellguide", "get_cell_type_info", {"cell_type": "acinar cell"})',
    run: async (ctx, a) => {
      const input = String(a.cell_type)
      const loaded = await loadCellType(ctx, input)
      if ('error' in loaded) return loaded

      const description = await fetchDescription(ctx, loaded.urlId)
      return {
        id: loaded.jsonId,
        name: loaded.entry.name,
        synonyms: loaded.entry.synonyms ?? [],
        ontologyDescription: loaded.entry.clDescription,
        description: description.description,
        descriptionSource: description.source,
        references: description.references
      }
    }
  },
  {
    id: 'search_cell_types',
    connector: 'cellguide',
    description:
      'Search CellGuide cell types by free text over name and synonyms (the CDN has no search endpoint, so celltype_metadata.json is filtered client-side).',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIMIT }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ "result": [ { "id": str, "name": str, "synonyms": [ str ], "ontology_description": str } ] }` — cell types whose name or a synonym contains `query` (case-insensitive), capped at `limit` (default 25).',
    example:
      'result = host.mcp("cellguide", "search_cell_types", {"query": "T cell", "limit": 25})',
    run: async (ctx, a) => {
      const query = String(a.query).trim().toLowerCase()
      const limit = Number(a.limit ?? DEFAULT_LIMIT)

      const snapshot = await fetchSnapshotId(ctx)
      const metadata = (await ctx.fetchJson(
        `${BASE_URL}/${snapshot}/celltype_metadata.json`
      )) as CellTypeMetadata

      const matches: Array<{
        id: string
        name?: string
        synonyms: string[]
        ontology_description?: string
      }> = []
      for (const [id, entry] of Object.entries(metadata)) {
        const synonyms = entry.synonyms ?? []
        const hit =
          (entry.name ?? '').toLowerCase().includes(query) ||
          synonyms.some((s) => s.toLowerCase().includes(query))
        if (!hit) continue
        matches.push({ id, name: entry.name, synonyms, ontology_description: entry.clDescription })
        if (matches.length >= limit) break
      }
      return { result: matches }
    }
  },
  {
    id: 'get_marker_genes',
    connector: 'cellguide',
    description:
      'CellGuide marker genes for a cell type (id or name): computational (data-derived, scored) or canonical (literature-curated).',
    input: {
      type: 'object',
      properties: {
        cell_type: { type: 'string' },
        marker_type: {
          type: 'string',
          enum: ['computational', 'canonical'],
          default: 'computational'
        },
        limit: { type: 'integer', default: DEFAULT_LIMIT }
      },
      required: ['cell_type']
    },
    required: ['cell_type'],
    returns:
      '`{ "id": str, "name": str, "markerType": str, "returned": int, "markerGenes": [ ... ] }`. Computational items: `{ "symbol": str, "name": str, "geneId": str, "markerScore": float, "specificity": float, "meanExpression": float, "percentExpressing": float, "groupbyDims": { ... } }` sorted by `markerScore` desc. Canonical items: `{ "symbol": str, "name": str, "tissue": str, "publication": str, "publicationTitle": str }`. Capped at `limit` (default 25); an empty list means no markers are curated/computed for this cell type. `{ "error": str }` when the cell type is not found.',
    example:
      'result = host.mcp("cellguide", "get_marker_genes", {"cell_type": "CL:0000084", "marker_type": "computational", "limit": 25})',
    run: async (ctx, a) => {
      const input = String(a.cell_type)
      const markerType = a.marker_type === 'canonical' ? 'canonical' : 'computational'
      const limit = Number(a.limit ?? DEFAULT_LIMIT)

      const loaded = await loadCellType(ctx, input)
      if ('error' in loaded) return loaded

      const path =
        markerType === 'canonical' ? 'canonical_marker_genes' : 'computational_marker_genes'
      const raw = await tryFetchJson(
        ctx,
        `${BASE_URL}/${loaded.snapshot}/${path}/${encodeURIComponent(loaded.urlId)}.json`
      )
      const rows = Array.isArray(raw) ? raw : []

      let markerGenes: Array<Record<string, unknown>>
      if (markerType === 'canonical') {
        markerGenes = (rows as CanonicalMarkerGene[]).slice(0, limit).map(formatCanonicalMarker)
      } else {
        // Data-derived markers carry a marker_score; surface the strongest ones first.
        markerGenes = (rows as ComputationalMarkerGene[])
          .slice()
          .sort((x, y) => (y.marker_score ?? 0) - (x.marker_score ?? 0))
          .slice(0, limit)
          .map(formatComputationalMarker)
      }

      return {
        id: loaded.jsonId,
        name: loaded.entry.name,
        markerType,
        returned: markerGenes.length,
        markerGenes
      }
    }
  },
  {
    id: 'get_source_data',
    connector: 'cellguide',
    description:
      'CellGuide source datasets and publications contributing to a cell type (id or name): collection name/url, publication, and the tissues/diseases/organisms each covers.',
    input: {
      type: 'object',
      properties: {
        cell_type: { type: 'string' }
      },
      required: ['cell_type']
    },
    required: ['cell_type'],
    returns:
      '`{ "id": str, "name": str, "count": int, "sources": [ { "collectionName": str, "collectionUrl": str, "publicationUrl": str, "publicationTitle": str, "tissues": [ { "id": str, "label": str } ], "diseases": [ { "id": str, "label": str } ], "organisms": [ { "id": str, "label": str } ] } ] }` — empty `sources` when no source collections exist. `{ "error": str }` when the cell type is not found.',
    example: 'result = host.mcp("cellguide", "get_source_data", {"cell_type": "CL:0000622"})',
    run: async (ctx, a) => {
      const input = String(a.cell_type)
      const loaded = await loadCellType(ctx, input)
      if ('error' in loaded) return loaded

      const raw = await tryFetchJson(
        ctx,
        `${BASE_URL}/${loaded.snapshot}/source_collections/${encodeURIComponent(loaded.urlId)}.json`
      )
      const collections = Array.isArray(raw) ? (raw as SourceCollection[]) : []

      const sources = collections.map((c) => ({
        collectionName: c.collection_name,
        collectionUrl: c.collection_url,
        publicationUrl: c.publication_url || undefined,
        publicationTitle: c.publication_title || undefined,
        tissues: refList(c.tissue),
        diseases: refList(c.disease),
        organisms: refList(c.organism)
      }))
      return { id: loaded.jsonId, name: loaded.entry.name, count: sources.length, sources }
    }
  },
  {
    id: 'get_cell_tissues',
    connector: 'cellguide',
    description:
      'Anatomical tissues where a cell type (id or name) is observed, aggregated (deduplicated) across CellGuide source collections.',
    input: {
      type: 'object',
      properties: {
        cell_type: { type: 'string' }
      },
      required: ['cell_type']
    },
    required: ['cell_type'],
    returns:
      '`{ "id": str, "name": str, "count": int, "tissues": [ { "id": str, "label": str } ] }` — unique UBERON tissues (by ontology term id) the cell type appears in, sorted by label. `{ "error": str }` when the cell type is not found.',
    example: 'result = host.mcp("cellguide", "get_cell_tissues", {"cell_type": "T cell"})',
    run: async (ctx, a) => {
      const input = String(a.cell_type)
      const loaded = await loadCellType(ctx, input)
      if ('error' in loaded) return loaded

      const raw = await tryFetchJson(
        ctx,
        `${BASE_URL}/${loaded.snapshot}/source_collections/${encodeURIComponent(loaded.urlId)}.json`
      )
      const collections = Array.isArray(raw) ? (raw as SourceCollection[]) : []

      // No per-cell tissue blob exists; dedupe the tissue refs across every source collection.
      const byId = new Map<string, { id?: string; label?: string }>()
      for (const c of collections) {
        for (const t of c.tissue ?? []) {
          const key = t.ontology_term_id ?? t.label ?? ''
          if (key && !byId.has(key)) byId.set(key, { id: t.ontology_term_id, label: t.label })
        }
      }
      const tissues = [...byId.values()].sort((x, y) =>
        (x.label ?? '').localeCompare(y.label ?? '')
      )
      return { id: loaded.jsonId, name: loaded.entry.name, count: tissues.length, tissues }
    }
  }
]
