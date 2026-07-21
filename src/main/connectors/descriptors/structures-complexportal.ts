import type { ToolContext, ToolDescriptor } from '../types'

// EBI Complex Portal web service (IntAct). Curated stable macromolecular complexes: single-record
// lookup by CPX accession (/complex/{AC}) and Solr search by participant (/search/{query}). The
// search is paged fully and count-verified against the service-reported totalNumberOfResults, so
// partial results are never silently returned.
const CPX_BASE = 'https://www.ebi.ac.uk/intact/complex-ws'
const SEARCH_PAGE_SIZE = 50
const GO_DATABASE_NAME = 'gene ontology'

// ---- Minimal shapes of the Complex Portal JSON we read --------------------------------------

type RawParticipant = {
  identifier?: string
  name?: string
  description?: string
  interactorType?: string
  interactorTypeMI?: string
  bioRole?: string
  bioRoleMI?: string
  stochiometry?: string
}
type RawXref = {
  database?: string
  identifier?: string
  qualifier?: string
  description?: string
}
type RawEvidence = { identifier?: string; description?: string; confidenceScore?: number }
type RawComplex = {
  complexAc?: string
  ac?: string
  name?: string
  systematicName?: string
  synonyms?: string[]
  species?: string
  predictedComplex?: boolean
  evidenceType?: RawEvidence
  participants?: RawParticipant[]
  crossReferences?: RawXref[]
  functions?: string[]
  complexAssemblies?: string[]
  releaseDates?: string[]
}
type RawSearchInteractor = {
  identifier?: string
  name?: string
  interactorType?: string
  stochiometry?: string
}
type RawSearchElement = {
  complexAC?: string
  complexName?: string
  organismName?: string
  predictedComplex?: boolean
  interactors?: RawSearchInteractor[]
}
type RawSearchResponse = { totalNumberOfResults?: number; elements?: RawSearchElement[] }

// ---- small helpers --------------------------------------------------------------------------

// Element-wise comparison of mixed string/number sort keys (Python tuple-sort semantics).
function compareKeys(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

// 'minValue: 2, maxValue: 2' -> [2, 2]; missing/unparseable -> [null, null].
function parseStoichiometry(raw: string | undefined): [number | null, number | null] {
  if (!raw) return [null, null]
  const m = /minValue:\s*(\d+)\s*,\s*maxValue:\s*(\d+)/.exec(raw)
  if (!m) return [null, null]
  return [Number(m[1]), Number(m[2])]
}

// 'Homo sapiens; 9606' -> ['Homo sapiens', 9606]; no taxid -> [name, null].
function splitSpecies(raw: string | undefined): [string | null, number | null] {
  if (!raw) return [null, null]
  const idx = raw.lastIndexOf(';')
  if (idx >= 0) {
    const name = raw.slice(0, idx).trim()
    const tax = raw.slice(idx + 1).trim()
    if (/^\d+$/.test(tax)) return [name, Number(tax)]
    return [raw.trim(), null]
  }
  return [raw.trim(), null]
}

// Numeric sort key for CPX accessions ('CPX-915' < 'CPX-2158'); non-CPX sort after, lexically.
function complexAcSortKey(ac: string): (string | number)[] {
  const m = /CPX-(\d+)$/.exec(ac || '')
  if (m) return [0, Number(m[1])]
  return [1, ac || '']
}

// ---- record mappers -------------------------------------------------------------------------

function parseParticipant(raw: RawParticipant): Record<string, unknown> {
  const [smin, smax] = parseStoichiometry(raw.stochiometry)
  return {
    identifier: raw.identifier ?? null,
    name: raw.name ?? null,
    description: raw.description ?? null,
    interactor_type: raw.interactorType ?? null,
    interactor_type_mi: raw.interactorTypeMI ?? null,
    biological_role: raw.bioRole ?? null,
    biological_role_mi: raw.bioRoleMI ?? null,
    stoichiometry_min: smin,
    stoichiometry_max: smax,
    stoichiometry_raw: raw.stochiometry ?? null
  }
}

// Parse a /complex/{AC} response into the structured record.
function parseComplex(raw: RawComplex): Record<string, unknown> {
  const [speciesName, taxid] = splitSpecies(raw.species)

  const participants = (raw.participants ?? [])
    .map(parseParticipant)
    .sort((a, b) =>
      compareKeys(
        [String(a.interactor_type ?? ''), String(a.identifier ?? ''), String(a.name ?? '')],
        [String(b.interactor_type ?? ''), String(b.identifier ?? ''), String(b.name ?? '')]
      )
    )

  const goAnnotations: Record<string, unknown>[] = []
  const crossReferences: Record<string, unknown>[] = []
  for (const x of raw.crossReferences ?? []) {
    const db = (x.database ?? '').trim()
    if (db.toLowerCase() === GO_DATABASE_NAME) {
      // GO cross-references become GO annotations (aspect carried in the qualifier field).
      goAnnotations.push({
        go_id: x.identifier ?? null,
        aspect: x.qualifier ?? null,
        term: x.description ?? null
      })
    } else {
      crossReferences.push({
        database: db,
        identifier: x.identifier ?? null,
        qualifier: x.qualifier ?? null,
        description: x.description ?? null
      })
    }
  }
  goAnnotations.sort((a, b) =>
    compareKeys(
      [String(a.go_id ?? ''), String(a.aspect ?? '')],
      [String(b.go_id ?? ''), String(b.aspect ?? '')]
    )
  )
  crossReferences.sort((a, b) =>
    compareKeys(
      [String(a.database ?? ''), String(a.identifier ?? ''), String(a.qualifier ?? '')],
      [String(b.database ?? ''), String(b.identifier ?? ''), String(b.qualifier ?? '')]
    )
  )

  const ev = raw.evidenceType ?? {}
  return {
    complex_ac: raw.complexAc ?? null,
    intact_ac: raw.ac ?? null,
    name: raw.name ?? null,
    systematic_name: raw.systematicName ?? null,
    synonyms: [...(raw.synonyms ?? [])].sort(),
    species_name: speciesName,
    taxid,
    predicted_complex: raw.predictedComplex ?? null,
    evidence: {
      eco_code: ev.identifier ?? null,
      description: ev.description ?? null,
      confidence_score: ev.confidenceScore ?? null
    },
    participants,
    go_annotations: goAnnotations,
    cross_references: crossReferences,
    functions: [...(raw.functions ?? [])],
    complex_assemblies: [...(raw.complexAssemblies ?? [])],
    release_dates: [...(raw.releaseDates ?? [])].sort()
  }
}

// Parse one /search element into a compact record.
function parseSearchElement(raw: RawSearchElement): Record<string, unknown> {
  const [speciesName, taxid] = splitSpecies(raw.organismName)
  const interactors = (raw.interactors ?? [])
    .map((i) => ({
      identifier: i.identifier ?? null,
      name: i.name ?? null,
      interactor_type: i.interactorType ?? null,
      stoichiometry_raw: i.stochiometry ?? null
    }))
    .sort((a, b) =>
      compareKeys(
        [String(a.interactor_type ?? ''), String(a.identifier ?? '')],
        [String(b.interactor_type ?? ''), String(b.identifier ?? '')]
      )
    )
  return {
    complex_ac: raw.complexAC ?? null,
    name: raw.complexName ?? null,
    species_name: speciesName,
    taxid,
    predicted_complex: raw.predictedComplex ?? null,
    interactors
  }
}

// A thrown engine error is "HTTP <status> for <url>"; detect a 404 to distinguish an unknown
// accession (-> not_found) from a genuine transport/server failure (-> propagate).
function isNotFound(err: unknown): boolean {
  return err instanceof Error && /HTTP 404\b/.test(err.message)
}

// ---- the 2 tools ----------------------------------------------------------------------------

export const STRUCTURES_COMPLEXPORTAL_TOOLS: ToolDescriptor[] = [
  {
    id: 'complexportal_get_complexes',
    connector: 'structures',
    description:
      'Fetch curated Complex Portal records by CPX accession. Each record: complex AC, recommended/systematic names + synonyms, species and taxid, participant list with stoichiometry (min/max copies), biological role and interactor type, evidence ECO code, GO annotations, and cross-references — the manually curated description of a stable macromolecular complex. Records come back in input order; unknown accessions are listed in `not_found` rather than silently dropped. For binary interaction *evidence* (who binds whom in which experiment) use the intact_* tools instead.',
    input: {
      type: 'object',
      properties: {
        complex_acs: { type: 'array', items: { type: 'string' } }
      },
      required: ['complex_acs']
    },
    required: ['complex_acs'],
    returns:
      '{n_requested, records:[{complex_ac, intact_ac, name, systematic_name, synonyms:[...], species_name, taxid, predicted_complex, evidence:{eco_code, description, confidence_score}, participants:[{identifier, name, description, interactor_type, interactor_type_mi, biological_role, biological_role_mi, stoichiometry_min, stoichiometry_max, stoichiometry_raw}], go_annotations:[{go_id, aspect, term}], cross_references:[{database, identifier, qualifier, description}], functions:[...], complex_assemblies:[...], release_dates:[...]}], not_found:[...]}. Records preserve the de-duplicated input order.',
    example:
      'const result = await host.mcp("structures", "complexportal_get_complexes", {"complex_acs": ["CPX-2158", "CPX-2419"]})',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<unknown> => {
      const input = Array.isArray(a.complex_acs) ? (a.complex_acs as unknown[]) : []
      // De-duplicate while preserving first-seen order (matches the Python reference).
      const seen = new Set<string>()
      const ordered: string[] = []
      for (const raw of input) {
        const ac = String(raw).trim()
        if (ac && !seen.has(ac)) {
          seen.add(ac)
          ordered.push(ac)
        }
      }
      const records: Record<string, unknown>[] = []
      const notFound: string[] = []
      for (const ac of ordered) {
        try {
          const raw = (await ctx.fetchJson(
            `${CPX_BASE}/complex/${encodeURIComponent(ac)}`
          )) as RawComplex
          records.push(parseComplex(raw))
        } catch (err) {
          // Only a 404 means "unknown accession"; anything else is a real failure — never swallow it.
          if (isNotFound(err)) notFound.push(ac)
          else throw err
        }
      }
      return { n_requested: ordered.length, records, not_found: notFound }
    }
  },
  {
    id: 'complexportal_search_by_participant',
    connector: 'structures',
    description:
      "Search Complex Portal for complexes containing a molecule. `accession` is a participant accession — UniProt (e.g. 'P04637'), ChEBI, or RNAcentral. With participants_only=true (default) the search is field-qualified (pxref:<accession>) so only complexes that actually contain the molecule as a curated participant are returned; with false the bare accession is matched as free text too (descriptions, names), which over-reports but can catch mentions. All result pages are retrieved and the row count is verified against the service-reported total (total_reported == total_retrieved, or the call fails loudly). Hits are compact records (complex_ac, name, species, interactors) sorted by complex accession; fetch full detail with complexportal_get_complexes.",
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string' },
        participants_only: { type: 'boolean', default: true }
      },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '{query_accession, solr_query, total_reported, total_retrieved, complexes:[{complex_ac, name, species_name, taxid, predicted_complex, interactors:[{identifier, name, interactor_type, stoichiometry_raw}]}]}. complexes are sorted by CPX accession (numeric); total_reported == total_retrieved is enforced or the call throws.',
    example:
      'const result = await host.mcp("structures", "complexportal_search_by_participant", {"accession": "P69905", "participants_only": True})',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<unknown> => {
      const accession = String(a.accession).trim()
      const participantsOnly = a.participants_only !== false
      // Field-qualified query restricts to actual participant cross-references; free text over-reports.
      const query = participantsOnly ? `pxref:"${accession}"` : accession

      const elements: RawSearchElement[] = []
      let first = 0
      let total = 0
      // Page until every reported row is retrieved (or the service returns an empty batch).
      for (let guard = 0; guard < 100_000; guard++) {
        const page = (await ctx.fetchJson(
          `${CPX_BASE}/search/${encodeURIComponent(query)}?format=json&first=${first}&number=${SEARCH_PAGE_SIZE}`
        )) as RawSearchResponse
        total = page.totalNumberOfResults ?? 0
        const batch = page.elements ?? []
        elements.push(...batch)
        first += batch.length
        if (first >= total || batch.length === 0) break
      }
      // Fail loudly on a count mismatch rather than returning a silently truncated set.
      if (elements.length !== total) {
        throw new Error(
          `pagination mismatch for ${query}: retrieved ${elements.length} of ${total}`
        )
      }
      const complexes = elements
        .map(parseSearchElement)
        .sort((x, y) =>
          compareKeys(
            complexAcSortKey(String(x.complex_ac ?? '')),
            complexAcSortKey(String(y.complex_ac ?? ''))
          )
        )
      return {
        query_accession: accession,
        solr_query: query,
        total_reported: total,
        total_retrieved: complexes.length,
        complexes
      }
    }
  }
]
