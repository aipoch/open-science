import type { ToolDescriptor } from '../types'

// Reactome AnalysisService (over-representation / pathway projection).
//
// IMPORTANT (verified live): the /identifiers endpoints ONLY accept a plain-text, newline-joined
// identifier list (Content-Type: text/plain). Posting a JSON array is rejected with HTTP 415
// Unsupported Media Type. ToolContext.postJson always sends application/json, so — following the
// zinc connector's precedent for a content-type ctx can't express — this tool talks to the API
// directly via the global fetch. The remaining calls (release version, not-found list) are GETs.
//
// The projection response reports identifiersNotFound only as a COUNT; the actual not-found ids come
// from GET /token/{token}/notFound. There is no per-identifier pathway endpoint (found/* group by
// pathway, only notFound groups by identifier), so per-identifier pathway membership is obtained by
// submitting each found identifier on its own — which also yields that identifier's own statistics.
const BASE = 'https://reactome.org/AnalysisService'
const USER_AGENT = 'OpenScience/1.0 (+https://github.com/aipoch/open-science)'
const HTTP_TIMEOUT_MS = 30_000

const ID_TYPES = new Set(['symbol', 'uniprot'])

// ---- minimal shapes of the AnalysisService JSON we read --------------------------------------

type RxSpecies = { name?: string }
type RxEntities = { total?: number; found?: number; ratio?: number; pValue?: number; fdr?: number }
type RxReactions = { total?: number; found?: number; ratio?: number }
type RxPathway = {
  stId?: string
  name?: string
  species?: RxSpecies
  llp?: boolean // low-level (leaf) pathway flag
  inDisease?: boolean
  entities?: RxEntities
  reactions?: RxReactions
}
type RxAnalysis = {
  summary?: { token?: string }
  identifiersNotFound?: number
  pathwaysFound?: number
  pathways?: RxPathway[]
}
type RxNotFoundRow = { id?: string }

// ---- request helpers -------------------------------------------------------------------------

// Global-fetch wrapper with the shared User-Agent and an abort timeout (ctx methods can't set the
// text/plain content-type Reactome requires — see the file header).
async function reactomeFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...init?.headers },
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

// Space in "Homo sapiens" must survive as %20 (encodeURIComponent, not the + of URLSearchParams).
function projectionUrl(species: string, resource: string, includeDisease: boolean): string {
  return (
    `${BASE}/identifiers/projection` +
    `?species=${encodeURIComponent(species)}` +
    `&resource=${encodeURIComponent(resource)}` +
    `&includeDisease=${includeDisease}`
  )
}

// POST a newline-joined identifier body as text/plain and parse the analysis result.
async function submitProjection(url: string, body: string): Promise<RxAnalysis> {
  const res = await reactomeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body
  })
  if (!res.ok) throw new Error(`Reactome AnalysisService projection failed (HTTP ${res.status})`)
  return (await res.json()) as RxAnalysis
}

// The token from summary.token is already percent-encoded; use it verbatim in the path.
async function fetchNotFound(token: string): Promise<string[]> {
  const res = await reactomeFetch(`${BASE}/token/${token}/notFound`)
  if (!res.ok) return []
  const rows = (await res.json()) as RxNotFoundRow[]
  return (Array.isArray(rows) ? rows : [])
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string')
}

// Reactome database release (e.g. "97") as plain text; null when unavailable (never fails the tool).
async function fetchVersion(): Promise<string | null> {
  try {
    const res = await reactomeFetch(`${BASE}/database/version`, {
      headers: { accept: 'text/plain' }
    })
    if (!res.ok) return null
    const text = (await res.text()).trim()
    return text || null
  } catch {
    return null
  }
}

// ---- response mappers ------------------------------------------------------------------------

function compactPathway(p: RxPathway): Record<string, unknown> {
  return { stId: p.stId, name: p.name, species: p.species?.name }
}

function fullPathway(p: RxPathway): Record<string, unknown> {
  const e = p.entities ?? {}
  const r = p.reactions ?? {}
  return {
    stId: p.stId,
    name: p.name,
    species: p.species?.name,
    low_level: p.llp === true,
    in_disease: p.inDisease === true,
    entities: { total: e.total, found: e.found, ratio: e.ratio, p_value: e.pValue, fdr: e.fdr },
    reactions: { total: r.total, found: r.found, ratio: r.ratio }
  }
}

// Deterministic pathway order: most significant first (entities p-value asc), then stId.
function byPValue(a: RxPathway, b: RxPathway): number {
  const pa = a.entities?.pValue ?? Number.POSITIVE_INFINITY
  const pb = b.entities?.pValue ?? Number.POSITIVE_INFINITY
  if (pa !== pb) return pa - pb
  return String(a.stId ?? '').localeCompare(String(b.stId ?? ''))
}

function notFoundEntry(compact: boolean): Record<string, unknown> {
  return compact
    ? { found: false, n_lowlevel_pathways: 0, pathways: [] }
    : { found: false, n_lowlevel_pathways: 0, n_pathways: 0, pathways: [] }
}

// ---- the tool --------------------------------------------------------------------------------

export const GENES_REACTOME_TOOLS: ToolDescriptor[] = [
  {
    id: 'map_reactome_pathways',
    connector: 'genes',
    description:
      'Map gene symbols or UniProt accessions to Reactome pathways (AnalysisService token workflow). Args: identifiers (gene symbols if id_type="symbol", UniProt accessions if "uniprot"; no duplicates); id_type ("symbol"/"uniprot"); species (default "Homo sapiens"); resource (AnalysisService molecule-resource view "TOTAL" default; "UNIPROT" restricts to protein-level mappings); include_disease (service default True); compact (True → per-identifier low-level pathways only {stId,name,species} + reactome release version; False → full deterministic result: per-identifier complete pathway sets with entity/reaction statistics (p-values, FDR, found/total) and batch summary incl. identifiers_not_found). Returns: compact {tool, reactome_version, id_type, species, n_input, genes:{identifier:{found, n_lowlevel_pathways, pathways}}}; full adds per-pathway statistics and batch_summary.',
    input: {
      type: 'object',
      properties: {
        identifiers: { type: 'array', items: { type: 'string' } },
        id_type: { type: 'string', enum: ['symbol', 'uniprot'] },
        species: { type: 'string', default: 'Homo sapiens' },
        resource: { type: 'string', default: 'TOTAL' },
        include_disease: { type: 'boolean', default: true },
        compact: { type: 'boolean', default: true }
      },
      required: ['identifiers', 'id_type']
    },
    required: ['identifiers', 'id_type'],
    returns:
      'compact {tool, reactome_version, id_type, species, resource, include_disease, n_input, genes:{identifier:{found, n_lowlevel_pathways, pathways:[{stId,name,species}]}}}; full replaces each pathways[] with full stats {stId,name,species,low_level,in_disease,entities:{total,found,ratio,p_value,fdr},reactions:{total,found,ratio}} and adds batch_summary {n_input, n_found, n_not_found, identifiers_not_found, distinct_lowlevel_pathways, batch_pathways_found}.',
    example:
      'result = host.mcp("genes", "map_reactome_pathways", {"identifiers": ["TP53", "EGFR", "BRCA1"], "id_type": "symbol"})',
    run: async (_ctx, a) => {
      const rawIds = a.identifiers
      if (!Array.isArray(rawIds)) throw new Error('identifiers must be an array of strings')
      const identifiers = rawIds.map((v) => String(v).trim()).filter((v) => v.length > 0)
      if (identifiers.length === 0) throw new Error('provide at least one identifier')
      if (new Set(identifiers).size !== identifiers.length) {
        throw new Error('identifiers must not contain duplicates')
      }
      const idType = String(a.id_type)
      if (!ID_TYPES.has(idType)) {
        throw new Error(`id_type must be "symbol" or "uniprot" (got "${idType}")`)
      }
      const species =
        a.species != null && String(a.species).trim() !== '' ? String(a.species) : 'Homo sapiens'
      const resource =
        a.resource != null && String(a.resource).trim() !== '' ? String(a.resource) : 'TOTAL'
      const includeDisease = a.include_disease !== false
      const compact = a.compact !== false

      const url = projectionUrl(species, resource, includeDisease)

      // Batch submission: one text/plain POST of all identifiers newline-joined. Its token yields the
      // authoritative not-found split; batch.pathwaysFound is the pooled pathway count.
      const version = await fetchVersion()
      const batch = await submitProjection(url, identifiers.join('\n'))
      const token = batch.summary?.token
      const batchNotFound = new Set(token ? await fetchNotFound(token) : [])

      const genes: Record<string, unknown> = {}
      const notFoundIds: string[] = []
      const distinctLowLevel = new Set<string>()

      for (const id of identifiers) {
        // Skip individually submitting an identifier the batch already reported as not found.
        if (batchNotFound.has(id)) {
          genes[id] = notFoundEntry(compact)
          notFoundIds.push(id)
          continue
        }
        const single = await submitProjection(url, id)
        // Robust fallback: an identifier is found only if its own submission mapped it.
        if ((single.identifiersNotFound ?? 0) !== 0) {
          genes[id] = notFoundEntry(compact)
          notFoundIds.push(id)
          continue
        }
        const pathways = (single.pathways ?? []).slice().sort(byPValue)
        const lowLevel = pathways.filter((p) => p.llp === true)
        for (const p of lowLevel) if (p.stId) distinctLowLevel.add(p.stId)
        genes[id] = compact
          ? {
              found: true,
              n_lowlevel_pathways: lowLevel.length,
              pathways: lowLevel.map(compactPathway)
            }
          : {
              found: true,
              n_lowlevel_pathways: lowLevel.length,
              n_pathways: pathways.length,
              pathways: pathways.map(fullPathway)
            }
      }

      const base = {
        tool: 'map_reactome_pathways',
        reactome_version: version,
        id_type: idType,
        species,
        resource,
        include_disease: includeDisease,
        n_input: identifiers.length,
        genes
      }
      if (compact) return base
      return {
        ...base,
        batch_summary: {
          n_input: identifiers.length,
          n_found: identifiers.length - notFoundIds.length,
          n_not_found: notFoundIds.length,
          identifiers_not_found: notFoundIds,
          distinct_lowlevel_pathways: distinctLowLevel.size,
          batch_pathways_found: batch.pathwaysFound ?? 0
        }
      }
    }
  }
]
