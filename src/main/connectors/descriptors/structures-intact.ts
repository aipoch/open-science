import type { ToolContext, ToolDescriptor } from '../types'

// EBI IntAct molecular-interaction web service (www.ebi.ac.uk/intact/ws). Ports the upstream
// `intact_interactions` reference (client.py / core.py / details.py): a count-verified paginated
// interaction sweep, interactor resolution, per-interaction detail, and a depth-1 network build.
// The search route (findInteractionWithFacet) takes its params on the URL even though the HTTP
// method is POST (verified live; matches the upstream httpx `params=` on a POST). The graph detail
// route answers unknown accessions with HTTP 200 and an EMPTY body — mapped to an explicit
// not_found record (verified live).
const INTACT_WS = 'https://www.ebi.ac.uk/intact/ws'
const SEARCH_PATH = 'interaction/findInteractionWithFacet'
const INTERACTOR_PATH = 'interactor/findInteractor'
const GRAPH_DETAILS_PATH = 'graph/interaction/details'
const GRAPH_PARTICIPANTS_PATH = 'graph/participants/details'

// Page size for the full interaction sweep. The service accepted large pages in probing; 500 keeps
// each response comfortably small while needing few requests per query (mirrors upstream core.py).
const SEARCH_PAGE_SIZE = 500
const INTERACTOR_PAGE_SIZE = 100
const PARTICIPANTS_PAGE_SIZE = 100
// Default cap on records returned to the notebook; the full verified sweep is always performed and
// its true size is reported via n_records, records_truncated flags the cap.
const DEFAULT_MAX_RECORDS = 500
// Defensive page ceiling so a misbehaving pagination cursor can never loop forever; the count-verify
// is the real completeness guarantee.
const MAX_PAGES = 100_000

// ---- Raw JSON shapes we read (transcribed from the live IntAct responses) -------------------

type IntActRawRecord = {
  ac?: string
  binaryInteractionId?: number
  acA?: string
  acB?: string
  idA?: string
  idB?: string
  moleculeA?: string
  moleculeB?: string
  speciesA?: string
  speciesB?: string
  taxIdA?: number
  taxIdB?: number
  type?: string
  typeMIIdentifier?: string
  detectionMethod?: string
  detectionMethodMIIdentifier?: string
  experimentalRoleA?: string
  experimentalRoleB?: string
  hostOrganism?: string
  expansionMethod?: string
  intactMiscore?: number
  negative?: boolean
  publicationPubmedIdentifier?: string
  firstAuthor?: string
  sourceDatabase?: string
}

type IntActSearchPage = {
  data?: {
    totalElements?: number
    content?: IntActRawRecord[]
    last?: boolean
  }
}

type IntActInteractorRaw = {
  interactorAc?: string
  interactorPreferredIdentifier?: string
  interactorName?: string
  interactorSpecies?: string
  interactorTaxId?: number
  interactorType?: string
  interactionCount?: number
}

type IntActInteractorPage = {
  content?: IntActInteractorRaw[]
  last?: boolean
  totalElements?: number
}

type CvTerm = { shortName?: string; identifier?: string }

type IntActDetailRaw = {
  interactionAc?: string
  shortLabel?: string
  type?: CvTerm
  detectionMethod?: CvTerm
  hostOrganism?: unknown
  negative?: boolean
  publication?: {
    pubmedId?: string
    title?: string
    journal?: string
    publicationDate?: string
    authors?: string[]
  }
  xrefs?: Array<Record<string, unknown>>
  annotations?: Array<Record<string, unknown>>
  parameters?: unknown[]
  confidences?: unknown[]
}

type IntActParticipantRaw = {
  participantAc?: string
  shortLabel?: string
  participantId?: { identifier?: string; database?: CvTerm }
  description?: string
  type?: CvTerm
  species?: { scientificName?: string; taxId?: number }
  biologicalRole?: CvTerm
  experimentalRole?: CvTerm
  detectionMethod?: CvTerm[]
}

type IntActParticipantPage = {
  content?: IntActParticipantRaw[]
  last?: boolean
  totalElements?: number
}

type SlimRecord = {
  interaction_ac?: string
  binary_interaction_id?: number
  ac_a?: string
  ac_b?: string
  id_a?: string
  id_b?: string
  id_a_database?: string
  id_b_database?: string
  molecule_a?: string
  molecule_b?: string
  species_a?: string
  species_b?: string
  taxid_a?: number
  taxid_b?: number
  interaction_type?: string
  interaction_type_mi?: string
  detection_method?: string
  detection_method_mi?: string
  experimental_role_a?: string
  experimental_role_b?: string
  host_organism?: string
  expansion_method?: string
  mi_score?: number
  negative?: boolean
  pubmed_id?: string
  first_author?: string
  source_database?: string
  origin?: string
}

type SweepResult = {
  query: string
  min_mi_score: number
  max_mi_score: number
  total_elements: number
  n_records: number
  records: SlimRecord[]
}

// ---- record shaping (mirrors core.py slim_record / sort_records) ----------------------------

// 'P04637 (uniprotkb)' -> 'P04637'; passthrough for undefined.
function stripDbSuffix(identifier: string | undefined): string | undefined {
  if (identifier == null) return identifier
  const idx = identifier.indexOf(' (')
  return idx === -1 ? identifier.trim() : identifier.slice(0, idx).trim()
}

// 'P04637 (uniprotkb)' -> 'uniprotkb'; the database of origin IntAct appends to the identifier.
function dbFromSuffix(identifier: string | undefined): string | undefined {
  if (!identifier) return undefined
  const idx = identifier.indexOf(' (')
  if (idx === -1) return undefined
  return identifier.slice(idx + 2).replace(/\)$/, '')
}

// Reduce a raw IntAct SearchInteraction document (~100 fields) to the structured fields exposed.
function slimRecord(raw: IntActRawRecord): SlimRecord {
  return {
    interaction_ac: raw.ac,
    binary_interaction_id: raw.binaryInteractionId,
    ac_a: raw.acA,
    ac_b: raw.acB,
    id_a: stripDbSuffix(raw.idA),
    id_b: stripDbSuffix(raw.idB),
    id_a_database: dbFromSuffix(raw.idA),
    id_b_database: dbFromSuffix(raw.idB),
    molecule_a: raw.moleculeA,
    molecule_b: raw.moleculeB,
    species_a: raw.speciesA,
    species_b: raw.speciesB,
    taxid_a: raw.taxIdA,
    taxid_b: raw.taxIdB,
    interaction_type: raw.type,
    interaction_type_mi: raw.typeMIIdentifier,
    detection_method: raw.detectionMethod,
    detection_method_mi: raw.detectionMethodMIIdentifier,
    experimental_role_a: raw.experimentalRoleA,
    experimental_role_b: raw.experimentalRoleB,
    host_organism: raw.hostOrganism,
    expansion_method: raw.expansionMethod,
    mi_score: raw.intactMiscore,
    negative: raw.negative,
    pubmed_id: raw.publicationPubmedIdentifier,
    first_author: raw.firstAuthor,
    source_database: raw.sourceDatabase
  }
}

// Deterministic order: descending MI score (null last), then interaction AC, then binary id.
function sortRecords<T extends SlimRecord>(records: T[]): T[] {
  return [...records].sort((a, b) => {
    const ka = a.mi_score == null ? 1 : -a.mi_score
    const kb = b.mi_score == null ? 1 : -b.mi_score
    if (ka !== kb) return ka - kb
    const aca = a.interaction_ac ?? ''
    const acb = b.interaction_ac ?? ''
    if (aca !== acb) return aca < acb ? -1 : 1
    return (a.binary_interaction_id ?? 0) - (b.binary_interaction_id ?? 0)
  })
}

// {shortName, identifier} -> {name, mi}; null for non-objects.
function cv(node: unknown): { name?: string; mi?: string } | null {
  if (node == null || typeof node !== 'object') return null
  const n = node as CvTerm
  return { name: n.shortName, mi: n.identifier }
}

function xref(node: Record<string, unknown>): Record<string, unknown> {
  const database = (node.database as CvTerm | undefined) ?? {}
  const qualifier = node.qualifier
  return {
    database: database.shortName,
    database_mi: database.identifier,
    identifier: node.identifier,
    qualifier:
      qualifier && typeof qualifier === 'object'
        ? (qualifier as CvTerm).shortName
        : (qualifier ?? null)
  }
}

// ---- pagination helpers ---------------------------------------------------------------------

// Reads an optional list-of-strings arg (interactor_species), trimming and dropping empties.
function speciesList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v).trim()).filter(Boolean)
}

// Reads a numeric arg with a default.
function num(value: unknown, def: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && value != null && value !== '' ? n : def
}

// Builds the search POST URL for one page. Params ride on the URL (POST with no body).
function searchUrl(
  query: string,
  minMi: number,
  maxMi: number,
  species: string[],
  page: number
): string {
  const params = new URLSearchParams()
  params.set('query', query)
  params.set('minMIScore', String(minMi))
  params.set('maxMIScore', String(maxMi))
  params.set('pageSize', String(SEARCH_PAGE_SIZE))
  params.set('page', String(page))
  for (const s of species) params.append('interactorSpeciesFilter', s)
  return `${INTACT_WS}/${SEARCH_PATH}?${params.toString()}`
}

// Complete, count-verified interaction sweep for one query. Pages until the collected record count
// equals the server-reported totalElements. THROWS (fails loudly, per the upstream contract) if
// totalElements is missing, drifts mid-sweep, a duplicate record appears, or the final tally
// disagrees with totalElements — silent truncation is impossible.
async function fetchInteractionsSweep(
  ctx: ToolContext,
  query: string,
  minMi: number,
  maxMi: number,
  species: string[]
): Promise<SweepResult> {
  const records: SlimRecord[] = []
  const seen = new Set<string>()
  let totalElements: number | null = null
  let page = 0
  for (; page < MAX_PAGES; page++) {
    const payload = (await ctx.postJson(
      searchUrl(query, minMi, maxMi, species, page),
      undefined
    )) as IntActSearchPage
    const data = payload.data ?? {}
    const pageTotal = data.totalElements
    if (pageTotal == null) {
      throw new Error(`query '${query}': response page ${page} lacked totalElements`)
    }
    if (totalElements === null) totalElements = pageTotal
    else if (pageTotal !== totalElements) {
      throw new Error(
        `query '${query}': totalElements changed mid-sweep (${totalElements} -> ${pageTotal} on page ${page})`
      )
    }
    const content = data.content ?? []
    for (const raw of content) {
      const key = `${raw.ac} ${raw.binaryInteractionId}`
      if (seen.has(key)) {
        throw new Error(
          `query '${query}': duplicate record (${raw.ac}, ${raw.binaryInteractionId}) on page ${page}`
        )
      }
      seen.add(key)
      records.push(slimRecord(raw))
    }
    if ((data.last ?? true) || content.length === 0) break
  }
  if (totalElements === null) totalElements = records.length
  if (records.length !== totalElements) {
    throw new Error(
      `query '${query}': collected ${records.length} records but server reported totalElements=${totalElements}`
    )
  }
  return {
    query,
    min_mi_score: minMi,
    max_mi_score: maxMi,
    total_elements: totalElements,
    n_records: records.length,
    records: sortRecords(records)
  }
}

// Resolves a query to ALL matching IntAct interactor records (GET interactor/findInteractor).
async function resolveInteractors(
  ctx: ToolContext,
  query: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  let page = 0
  for (; page < MAX_PAGES; page++) {
    const payload = (await ctx.fetchJson(
      `${INTACT_WS}/${INTERACTOR_PATH}/${encodeURIComponent(query)}?page=${page}&pageSize=${INTERACTOR_PAGE_SIZE}`
    )) as IntActInteractorPage
    const content = payload.content ?? []
    for (const raw of content) {
      out.push({
        interactor_ac: raw.interactorAc,
        preferred_identifier: stripDbSuffix(raw.interactorPreferredIdentifier),
        name: raw.interactorName,
        species: raw.interactorSpecies,
        taxid: raw.interactorTaxId,
        interactor_type: raw.interactorType,
        interaction_count: raw.interactionCount
      })
    }
    if ((payload.last ?? true) || content.length === 0) break
  }
  return out
}

// ---- the 4 tools ----------------------------------------------------------------------------

export const STRUCTURES_INTACT_TOOLS: ToolDescriptor[] = [
  {
    id: 'intact_fetch_interactions',
    connector: 'structures',
    description:
      'Retrieve ALL IntAct binary interactions matching a query, MI-score filtered. `query` is a UniProt accession (e.g. \'P04637\'), gene symbol, free text, or any IntAct Solr query. Retrieval is a complete paginated sweep verified against the server-reported total (n_records == total_elements, or the call FAILS LOUDLY — silent truncation is impossible). min_mi_score/max_mi_score filter server-side on the IntAct MI confidence score (0.45 is a common medium-confidence floor); interactor_species filters by species name or taxid (e.g. ["Homo sapiens"] or ["9606"]). Records are slim and structured: interactor pair (IntAct ACs, database identifiers, molecule names, species/taxids), interaction type, detection method (+MI id), experimental roles, host organism, MI score, PubMed id, first author, source database — sorted by DESCENDING MI score. Output lists at most max_records_returned records (records_truncated=true when the full verified sweep was larger; n_records always reports the true total). Large queries (e.g. CFTR ~10k interactions) take a while — narrow with min_mi_score or species when possible.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        min_mi_score: { type: 'number', default: 0 },
        max_mi_score: { type: 'number', default: 1 },
        interactor_species: { type: 'array', items: { type: 'string' } },
        max_records_returned: { type: 'integer', default: DEFAULT_MAX_RECORDS }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ query, min_mi_score, total_elements, n_records, records_truncated, n_records_returned, records: [{ interaction_ac, binary_interaction_id, ac_a, ac_b, id_a, id_b, id_a_database, id_b_database, molecule_a, molecule_b, species_a, species_b, taxid_a, taxid_b, interaction_type, interaction_type_mi, detection_method, detection_method_mi, experimental_role_a, experimental_role_b, host_organism, expansion_method, mi_score, negative, pubmed_id, first_author, source_database }] }`. `n_records` is the true count-verified total; `records` is capped at max_records_returned (records_truncated=true when the sweep was larger), sorted by descending mi_score. `records` is `[]` when nothing matches. Throws when the sweep count fails to verify.',
    example:
      'result = host.mcp("structures", "intact_fetch_interactions", {"query": "P04637", "min_mi_score": 0.45, "interactor_species": ["Homo sapiens"], "max_records_returned": 200})',
    run: async (ctx, a): Promise<Record<string, unknown>> => {
      const query = String(a.query)
      const minMi = num(a.min_mi_score, 0)
      const maxMi = num(a.max_mi_score, 1)
      const species = speciesList(a.interactor_species)
      const maxRecords = Math.max(0, Math.trunc(num(a.max_records_returned, DEFAULT_MAX_RECORDS)))

      const sweep = await fetchInteractionsSweep(ctx, query, minMi, maxMi, species)
      const capped = sweep.records.slice(0, maxRecords)
      return {
        query: sweep.query,
        min_mi_score: sweep.min_mi_score,
        max_mi_score: sweep.max_mi_score,
        total_elements: sweep.total_elements,
        n_records: sweep.n_records,
        records_truncated: capped.length < sweep.records.length,
        n_records_returned: capped.length,
        records: capped
      }
    }
  },
  {
    id: 'intact_get_interactor',
    connector: 'structures',
    description:
      "Resolve a molecule to its IntAct interactor record(s). `query` is a UniProt accession, gene symbol, or IntAct interactor AC (e.g. 'EBI-7090529'). Returns ALL matching interactor records with an explicit n_matches — a UniProt accession can resolve to the canonical protein plus chain/isoform interactors, and this tool never silently picks one. Each record: interactor_ac, preferred_identifier, name, species, taxid, interactor_type, and the interaction_count seen by IntAct (useful for sizing an intact_fetch_interactions sweep).",
    input: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ query, n_matches, interactors: [{ interactor_ac, preferred_identifier, name, species, taxid, interactor_type, interaction_count }] }` — all matches, sorted by interactor_ac. `interactors` is `[]` and `n_matches` is 0 when nothing resolves.',
    example: 'result = host.mcp("structures", "intact_get_interactor", {"query": "P04637"})',
    run: async (ctx, a): Promise<Record<string, unknown>> => {
      const query = String(a.query)
      const matches = (await resolveInteractors(ctx, query)).sort((x, y) =>
        String(x.interactor_ac ?? '') < String(y.interactor_ac ?? '') ? -1 : 1
      )
      return { query, n_matches: matches.length, interactors: matches }
    }
  },
  {
    id: 'intact_get_interaction_details',
    connector: 'structures',
    description:
      "Full curated detail for ONE IntAct interaction AC (e.g. 'EBI-15635490'). Returns interaction type, host organism, detection method, publication, cross-references, annotations, kinetic/affinity parameters and confidences, plus per-participant records (identifier, species, biological and experimental role, participant detection methods) unless include_participants=false. Get interaction ACs from intact_fetch_interactions records (the interaction_ac field). Unknown ACs return { interaction_ac, error: 'not_found' }.",
    input: {
      type: 'object',
      properties: {
        interaction_ac: { type: 'string' },
        include_participants: { type: 'boolean', default: true }
      },
      required: ['interaction_ac']
    },
    required: ['interaction_ac'],
    returns:
      "`{ interaction_ac, short_label, type: {name, mi}, detection_method: {name, mi}, host_organism, negative, publication: {pubmed_id, title, journal, publication_date, authors}, xrefs: [{database, database_mi, identifier, qualifier}], annotations: [{topic, topic_mi, description}], parameters, confidences, participants?: [{participant_ac, short_label, identifier, identifier_database, description, type, species, taxid, biological_role, experimental_role, detection_methods}], n_participants? }`. Unknown AC -> `{ interaction_ac, error: 'not_found' }`.",
    example:
      'result = host.mcp("structures", "intact_get_interaction_details", {"interaction_ac": "EBI-15635490", "include_participants": True})',
    run: async (ctx, a): Promise<Record<string, unknown>> => {
      const interactionAc = String(a.interaction_ac)
      const includeParticipants = a.include_participants !== false

      // The graph detail route answers unknown ACs with an empty HTTP-200 body; fetch as text so an
      // empty body maps to not_found instead of a JSON-parse throw.
      const body = await ctx.fetchText(
        `${INTACT_WS}/${GRAPH_DETAILS_PATH}/${encodeURIComponent(interactionAc)}`
      )
      if (!body || !body.trim()) return { interaction_ac: interactionAc, error: 'not_found' }
      const raw = JSON.parse(body) as IntActDetailRaw

      const pub = raw.publication
      const record: Record<string, unknown> = {
        interaction_ac: raw.interactionAc,
        short_label: raw.shortLabel,
        type: cv(raw.type),
        detection_method: cv(raw.detectionMethod),
        host_organism: raw.hostOrganism,
        negative: raw.negative,
        publication: pub
          ? {
              pubmed_id: pub.pubmedId,
              title: pub.title,
              journal: pub.journal,
              publication_date: pub.publicationDate,
              authors: pub.authors
            }
          : null,
        xrefs: (raw.xrefs ?? [])
          .filter((x): x is Record<string, unknown> => x != null && typeof x === 'object')
          .map(xref)
          .sort((x, y) => {
            const dx = String(x.database ?? '')
            const dy = String(y.database ?? '')
            if (dx !== dy) return dx < dy ? -1 : 1
            const ix = String(x.identifier ?? '')
            const iy = String(y.identifier ?? '')
            return ix < iy ? -1 : ix > iy ? 1 : 0
          }),
        annotations: (raw.annotations ?? [])
          .filter((an): an is Record<string, unknown> => an != null && typeof an === 'object')
          .map((an) => {
            const topic = cv(an.topic)
            return {
              topic: topic?.name,
              topic_mi: topic?.mi,
              description: an.description
            }
          }),
        parameters: raw.parameters ?? [],
        confidences: raw.confidences ?? []
      }

      if (includeParticipants) {
        const participants: Array<Record<string, unknown>> = []
        let page = 0
        for (; page < MAX_PAGES; page++) {
          const payload = (await ctx.fetchJson(
            `${INTACT_WS}/${GRAPH_PARTICIPANTS_PATH}/${encodeURIComponent(interactionAc)}?page=${page}&pageSize=${PARTICIPANTS_PAGE_SIZE}`
          )) as IntActParticipantPage
          const content = payload.content ?? []
          for (const p of content) {
            const pid = p.participantId ?? {}
            participants.push({
              participant_ac: p.participantAc,
              short_label: p.shortLabel,
              identifier: pid.identifier,
              identifier_database: pid.database?.shortName,
              description: p.description,
              type: cv(p.type),
              species: p.species?.scientificName,
              taxid: p.species?.taxId,
              biological_role: cv(p.biologicalRole),
              experimental_role: cv(p.experimentalRole),
              detection_methods: (p.detectionMethod ?? []).map((m) => cv(m))
            })
          }
          if ((payload.last ?? true) || content.length === 0) break
        }
        participants.sort((x, y) =>
          String(x.participant_ac ?? '') < String(y.participant_ac ?? '') ? -1 : 1
        )
        record.participants = participants
        record.n_participants = participants.length
      }

      return record
    }
  },
  {
    id: 'intact_build_network',
    connector: 'structures',
    description:
      'Build a depth-1 IntAct interaction network around seed proteins. `seed_accessions` are UniProt accessions. Step 1: a complete, count-verified MI-score-filtered interaction sweep per seed. Step 2: the partners of every seed edge plus the seeds form the node set. Step 3: partner-partner edges are only discoverable by querying the partners themselves, so up to max_interactors_expanded partners are queried (most-connected first, ties by identifier) and edges with BOTH endpoints inside the node set are kept. The expansion block reports exactly which partners were / were not expanded (expansion.complete=false means more partner-partner edges may exist). Output: nodes, edges (with MI score, detection method, PubMed id), per-seed sweep stats. Keep seeds few and min_mi_score >= 0.45 — every expansion is a full paginated sweep.',
    input: {
      type: 'object',
      properties: {
        seed_accessions: { type: 'array', items: { type: 'string' } },
        min_mi_score: { type: 'number', default: 0.45 },
        max_interactors_expanded: { type: 'integer', default: 25 },
        interactor_species: { type: 'array', items: { type: 'string' } }
      },
      required: ['seed_accessions']
    },
    required: ['seed_accessions'],
    returns:
      '`{ seeds, min_mi_score, n_nodes, nodes: [id...], n_edges, edges: [slim_record + {origin}], seed_sweeps: {seed: {total_elements, n_records}}, expansion: {max_interactors_expanded, n_partners, expanded: [id...], not_expanded: [id...], complete} }`. `nodes` are sorted identifiers; `edges` are sorted by descending mi_score; `expansion.complete=false` means partner-partner edges beyond the cap may exist.',
    example:
      'result = host.mcp("structures", "intact_build_network", {"seed_accessions": ["P04637", "Q00987"], "min_mi_score": 0.45, "max_interactors_expanded": 25})',
    run: async (ctx, a): Promise<Record<string, unknown>> => {
      const seeds = Array.from(new Set(speciesList(a.seed_accessions))) /* dedupe, keep order */
      const minMi = num(a.min_mi_score, 0.45)
      const maxExpanded = Math.max(0, Math.trunc(num(a.max_interactors_expanded, 25)))
      const species = speciesList(a.interactor_species)

      const seedSet = new Set(seeds)
      const nodeIds = new Set<string>(seeds)
      const partnerDegree = new Map<string, number>()
      const edges = new Map<string, SlimRecord>()
      const seedSweeps: Record<string, { total_elements: number; n_records: number }> = {}

      const edgeKey = (r: SlimRecord): string => `${r.interaction_ac} ${r.binary_interaction_id}`

      for (const seed of seeds) {
        const sweep = await fetchInteractionsSweep(ctx, seed, minMi, 1, species)
        seedSweeps[seed] = { total_elements: sweep.total_elements, n_records: sweep.n_records }
        for (const rec of sweep.records) {
          const key = edgeKey(rec)
          if (!edges.has(key)) edges.set(key, { ...rec, origin: 'seed_sweep' })
          for (const pid of [rec.id_a, rec.id_b]) {
            if (pid && !seedSet.has(pid)) {
              nodeIds.add(pid)
              partnerDegree.set(pid, (partnerDegree.get(pid) ?? 0) + 1)
            }
          }
        }
      }

      // Deterministic expansion order: highest seed-degree first, then identifier.
      const expansionOrder = [...partnerDegree.keys()].sort((x, y) => {
        const dx = partnerDegree.get(x) ?? 0
        const dy = partnerDegree.get(y) ?? 0
        if (dx !== dy) return dy - dx
        return x < y ? -1 : x > y ? 1 : 0
      })
      const expanded = expansionOrder.slice(0, maxExpanded)
      const notExpanded = expansionOrder.slice(maxExpanded)

      for (const partner of expanded) {
        const sweep = await fetchInteractionsSweep(ctx, partner, minMi, 1, species)
        for (const rec of sweep.records) {
          if (rec.id_a && rec.id_b && nodeIds.has(rec.id_a) && nodeIds.has(rec.id_b)) {
            const key = edgeKey(rec)
            if (!edges.has(key)) edges.set(key, { ...rec, origin: 'partner_expansion' })
          }
        }
      }

      const edgeList = sortRecords([...edges.values()])
      return {
        seeds,
        min_mi_score: minMi,
        n_nodes: nodeIds.size,
        nodes: [...nodeIds].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
        n_edges: edgeList.length,
        edges: edgeList,
        seed_sweeps: seedSweeps,
        expansion: {
          max_interactors_expanded: maxExpanded,
          n_partners: expansionOrder.length,
          expanded,
          not_expanded: notExpanded,
          complete: notExpanded.length === 0
        }
      }
    }
  }
]
