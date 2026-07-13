import type { ToolContext, ToolDescriptor } from '../types'

// CellGuide (CELLxGENE) serves static, snapshot-versioned JSON blobs from this CDN — no live
// query API (endpoints/snapshot-id indirection mirror upstream mcp_cellguide/client.py; the
// canonical_marker_genes record shape below was corrected against a live fetch — client.py
// applies the *computational* marker shape {marker_score, specificity, me, pc, groupby_dims} to
// canonical markers too, but the live canonical_marker_genes/<CL_id>.json blobs are actually
// literature-curated {tissue, symbol, name, publication, publication_titles} records with no
// score field, so client.py's marker_score-descending sort on canonical is a no-op there).
const BASE_URL = 'https://cellguide.cellxgene.cziscience.com'

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

// client.py swallows fetch failures for the optional blobs (description/markers may not exist
// for every cell type) and falls back to empty results; mirror that instead of failing the call.
async function tryFetchJson(ctx: ToolContext, url: string): Promise<unknown | undefined> {
  try {
    return await ctx.fetchJson(url)
  } catch {
    return undefined
  }
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

function formatMarkerGene(g: CanonicalMarkerGene): Record<string, unknown> {
  return {
    symbol: g.symbol,
    name: g.name,
    tissue: g.tissue,
    publication: g.publication || undefined,
    publicationTitle: g.publication_titles || undefined
  }
}

// CellGuide CDN: cell-type metadata + validated/GPT description + canonical marker genes,
// keyed by Cell Ontology (CL) id. No search endpoint on the CDN — pass a CL id directly.
export const CELLGUIDE_TOOLS: ToolDescriptor[] = [
  {
    id: 'cellguide_cell_type',
    connector: 'cellguide',
    description:
      'Get CellGuide (CELLxGENE) info for a Cell Ontology id: name, synonyms, description, and canonical marker genes.',
    input: {
      type: 'object',
      properties: {
        cellType: {
          type: 'string',
          description: 'Cell Ontology id, e.g. CL:0000622 (CL:x, CL_x, or bare digits all accepted)'
        }
      },
      required: ['cellType']
    },
    required: ['cellType'],
    run: async (ctx, a) => {
      const cellType = String(a.cellType)
      const jsonId = toJsonFormat(cellType)
      const urlId = toUrlFormat(cellType)

      const snapshot = await fetchSnapshotId(ctx)
      const metadata = (await ctx.fetchJson(
        `${BASE_URL}/${snapshot}/celltype_metadata.json`
      )) as CellTypeMetadata
      const info = metadata[jsonId]
      if (!info) return { error: `Cell type '${cellType}' not found` }

      const description = await fetchDescription(ctx, urlId)
      const markersRaw = await tryFetchJson(
        ctx,
        `${BASE_URL}/${snapshot}/canonical_marker_genes/${encodeURIComponent(urlId)}.json`
      )
      // Empty body (no curated canonical markers for this cell type) fails .json() parsing;
      // tryFetchJson already folds that into undefined, same as a 404.
      const markers = Array.isArray(markersRaw) ? (markersRaw as CanonicalMarkerGene[]) : []

      return {
        id: jsonId,
        name: info.name,
        synonyms: info.synonyms ?? [],
        ontologyDescription: info.clDescription,
        description: description.description,
        descriptionSource: description.source,
        references: description.references,
        canonicalMarkerGenes: markers.slice(0, 30).map(formatMarkerGene)
      }
    }
  }
]
