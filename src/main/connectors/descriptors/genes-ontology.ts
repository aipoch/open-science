import type { ToolContext, ToolDescriptor } from '../types'

// EBI Ontology Lookup Service (OLS4) and QuickGO. OLS4 paginates HAL collections with a
// `page.totalElements` count and `_links.next.href`; QuickGO paginates with `numberOfHits` +
// `pageInfo.total`. Both are count-verified so partial results are never silently returned.
const OLS_BASE = 'https://www.ebi.ac.uk/ols4/api'
const QUICKGO_BASE = 'https://www.ebi.ac.uk/QuickGO/services'
const OLS_PAGE_SIZE = 500
const QUICKGO_PAGE_LIMIT = 200

// Ordered valid OLS relation sets for get_ontology_term.
const OLS_RELATIONS = [
  'parents',
  'children',
  'ancestors',
  'descendants',
  'hierarchicalParents',
  'hierarchicalChildren',
  'hierarchicalAncestors',
  'hierarchicalDescendants'
] as const

// ---- Minimal shapes of the OLS4 / QuickGO JSON we read -------------------------------------

type OlsLink = { href?: string }
type OlsLinks = { next?: OlsLink } & Record<string, OlsLink | undefined>
type OlsPageMeta = { size?: number; totalElements?: number; totalPages?: number; number?: number }
type OlsOntologyConfig = {
  id?: string
  title?: string
  version?: string
  description?: string
  preferredPrefix?: string
  namespace?: string
}
type OlsOntology = {
  ontologyId?: string
  status?: string
  version?: string
  numberOfTerms?: number
  numberOfProperties?: number
  numberOfIndividuals?: number
  config?: OlsOntologyConfig
}
type OlsTerm = {
  iri?: string
  label?: string
  short_form?: string
  obo_id?: string
  ontology_name?: string
  description?: string[] | string
  synonyms?: string[]
  is_obsolete?: boolean
  has_children?: boolean
  type?: string
  is_defining_ontology?: boolean
  _links?: OlsLinks
}
type OlsListResponse<T> = {
  _embedded?: Record<string, T[]>
  _links?: OlsLinks
  page?: OlsPageMeta
}
type OlsSearchDoc = {
  iri?: string
  label?: string
  short_form?: string
  obo_id?: string
  ontology_name?: string
  description?: string[] | string
  type?: string
  is_defining_ontology?: boolean
}
type OlsSearchResponse = { response?: { numFound?: number; docs?: OlsSearchDoc[] } }

type QuickGoAnnotation = {
  id?: string
  geneProductId?: string
  qualifier?: string
  goId?: string
  goName?: string
  goEvidence?: string
  goAspect?: string
  evidenceCode?: string
  reference?: string
  withFrom?: unknown
  taxonId?: number
  taxonName?: string
  assignedBy?: string
  date?: string
  symbol?: string
}
type QuickGoAnnotationResponse = {
  numberOfHits?: number
  results?: QuickGoAnnotation[]
  pageInfo?: { resultsPerPage?: number; current?: number; total?: number }
}
type QuickGoTerm = { id?: string; name?: string; aspect?: string; isObsolete?: boolean }
type QuickGoOntologyResponse = { numberOfHits?: number; results?: QuickGoTerm[] }

// ---- small helpers --------------------------------------------------------------------------

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// OLS term/search `description` is an array (or occasionally a bare string); flatten to one string.
function joinDescription(d: string[] | string | undefined): string | null {
  if (Array.isArray(d)) return d.length ? d.join(' ') : null
  return typeof d === 'string' && d !== '' ? d : null
}

// Double-URL-encode a term IRI for the OLS relation path route (verified live: the route only
// resolves when the IRI is encoded twice, e.g. GO_0006281 -> http%253A%252F%252F...).
const doubleEncodeIri = (iri: string): string => encodeURIComponent(encodeURIComponent(iri))

// ---- record mappers -------------------------------------------------------------------------

function leanOntology(o: OlsOntology): Record<string, unknown> {
  return {
    ontology_id: o.ontologyId,
    title: o.config?.title,
    version: o.config?.version ?? o.version ?? null,
    status: o.status,
    num_terms: o.numberOfTerms,
    num_properties: o.numberOfProperties,
    num_individuals: o.numberOfIndividuals,
    preferred_prefix: o.config?.preferredPrefix,
    description: o.config?.description ?? null,
    namespace: o.config?.namespace
  }
}

// Compact reference used for related terms and direct parents.
function compactTerm(t: OlsTerm): Record<string, unknown> {
  return {
    curie: t.obo_id ?? null,
    iri: t.iri,
    label: t.label,
    short_form: t.short_form,
    ontology: t.ontology_name,
    has_children: t.has_children
  }
}

function searchTermRow(d: OlsSearchDoc): Record<string, unknown> {
  return {
    curie: d.obo_id ?? null,
    iri: d.iri,
    label: d.label,
    short_form: d.short_form,
    ontology: d.ontology_name,
    description: joinDescription(d.description),
    type: d.type,
    is_defining_ontology: d.is_defining_ontology ?? null
  }
}

// ---- OLS pagination -------------------------------------------------------------------------

// Walks an OLS HAL collection from firstUrl, following `_links.next.href`, collecting the given
// embedded key. Returns the rows plus the API's own totalElements for count-verification.
async function olsPageAll<T>(
  ctx: ToolContext,
  firstUrl: string,
  embeddedKey: string
): Promise<{ rows: T[]; totalElements: number }> {
  const rows: T[] = []
  let url: string | null = firstUrl
  let totalElements = 0
  let first = true
  // Guard against a pathological next-link loop; OLS collections here are at most a few hundred pages.
  for (let guard = 0; url && guard < 10_000; guard++) {
    const resp = (await ctx.fetchJson(url)) as OlsListResponse<T>
    if (first) {
      totalElements = resp.page?.totalElements ?? 0
      first = false
    }
    const page = resp._embedded?.[embeddedKey] ?? []
    rows.push(...page)
    const next = resp._links?.next?.href
    url = next && next !== url ? next : null
  }
  return { rows, totalElements }
}

// ---- term resolution ------------------------------------------------------------------------

// Resolves a CURIE / short_form / IRI term_id to its OLS term record (carrying the canonical iri).
async function resolveOlsTerm(
  ctx: ToolContext,
  ontology: string,
  termId: string
): Promise<OlsTerm | null> {
  const id = termId.trim()
  let param: string
  if (/^https?:\/\//i.test(id)) param = 'iri'
  else if (id.includes(':')) param = 'obo_id'
  else param = 'short_form'
  const resp = (await ctx.fetchJson(
    `${OLS_BASE}/ontologies/${encodeURIComponent(ontology)}/terms?${param}=${encodeURIComponent(id)}&size=1`
  )) as OlsListResponse<OlsTerm>
  return resp._embedded?.terms?.[0] ?? null
}

// ---- QuickGO evidence mapping ---------------------------------------------------------------

// Maps the evidence arg to QuickGO evidenceCode params. Presets expand to an ECO root with
// descendant usage; an explicit ECO code filters exactly. Returns null for no filter.
function evidenceParams(evidence: string): { code: string; usage?: string } | null {
  const e = evidence.trim()
  if (e === '') return null
  const low = e.toLowerCase()
  if (low === 'all' || low === 'none') return null
  if (low === 'experimental_manual') return { code: 'ECO:0000269', usage: 'descendants' }
  if (low === 'automatic_iea') return { code: 'ECO:0000501', usage: 'descendants' }
  if (/^eco:\d+$/i.test(e)) return { code: e.toUpperCase() }
  return { code: e }
}

// Normalizes an aspect arg to QuickGO's aspect token, or null for no filter.
function aspectParam(aspect: string): string | null {
  const a = aspect.trim().toLowerCase()
  if (a === '' || a === 'all' || a === 'none') return null
  if (['biological_process', 'molecular_function', 'cellular_component'].includes(a)) return a
  return a
}

// ---- the 4 tools ----------------------------------------------------------------------------

export const GENES_ONTOLOGY_TOOLS: ToolDescriptor[] = [
  {
    id: 'list_ontologies',
    connector: 'genes',
    description:
      'List ontologies in the EBI Ontology Lookup Service (OLS4). With `ontology_ids` (e.g. ["efo","cl","chebi","go","mondo"]): fetch structured metadata records for just those ontologies; unknown IDs are reported in `not_found`. Without: the complete OLS4 catalogue (~250 ontologies, paginated fully and count-verified). Returns: {records:[{ontology_id, title, version, status, num_terms, ...}], not_found:[...]} for an ID list, or {records:[...], total_elements, complete} for the full catalogue.',
    input: {
      type: 'object',
      properties: {
        ontology_ids: { type: 'array', items: { type: 'string' } }
      }
    },
    returns:
      'ID list -> {records:[{ontology_id, title, version, status, num_terms, num_properties, num_individuals, preferred_prefix, description, namespace}], not_found:[...]}; full catalogue -> {records:[...], total_elements, complete}.',
    example:
      'result = host.mcp("genes", "list_ontologies", {"ontology_ids": ["efo", "go", "mondo"]})',
    run: async (ctx, a) => {
      const ids = Array.isArray(a.ontology_ids) ? (a.ontology_ids as unknown[]) : null
      if (ids && ids.length > 0) {
        const records: Record<string, unknown>[] = []
        const notFound: string[] = []
        for (const raw of ids) {
          const id = String(raw).trim().toLowerCase()
          try {
            const o = (await ctx.fetchJson(
              `${OLS_BASE}/ontologies/${encodeURIComponent(id)}`
            )) as OlsOntology
            records.push(leanOntology(o))
          } catch {
            // OLS returns 404 for an unknown ontology id — record it rather than failing the call.
            notFound.push(id)
          }
        }
        return { records, not_found: notFound }
      }
      const { rows, totalElements } = await olsPageAll<OlsOntology>(
        ctx,
        `${OLS_BASE}/ontologies?size=${OLS_PAGE_SIZE}`,
        'ontologies'
      )
      const records = rows.map(leanOntology)
      return { records, total_elements: totalElements, complete: records.length === totalElements }
    }
  },
  {
    id: 'search_ontology_terms',
    connector: 'genes',
    description:
      'Search ontology terms by label/synonym across one or more OLS4 ontologies. Typical uses: find an EFO ID for a disease name (ontologies=["efo"]), Cell Ontology terms for a cell type (["cl"]), ChEBI terms for a chemical (["chebi"]), GO terms by name (["go"]) — or search all ontologies at once. Args: query (term label, synonym, or identifier); ontologies (lowercase IDs to restrict to; None searches every ontology); exact (whole-string match); include_obsolete (default False); max_results (ranked by OLS relevance). Returns {query, total_found, n_returned, truncated, terms:[{curie, iri, label, short_form, ontology, description, type, is_defining_ontology}]}.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        ontologies: { type: 'array', items: { type: 'string' } },
        exact: { type: 'boolean', default: false },
        include_obsolete: { type: 'boolean', default: false },
        max_results: { type: 'integer', default: 20 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '{query, total_found (numFound), n_returned, truncated (total_found > n_returned), terms:[{curie, iri, label, short_form, ontology, description, type, is_defining_ontology}]}.',
    example:
      'result = host.mcp("genes", "search_ontology_terms", {"query": "asthma", "ontologies": ["efo"], "max_results": 20})',
    run: async (ctx, a) => {
      const query = String(a.query)
      const rows = clampInt(a.max_results, 20, 1, 500)
      const exact = a.exact === true
      const includeObsolete = a.include_obsolete === true
      const params = [
        `q=${encodeURIComponent(query)}`,
        `exact=${exact}`,
        `obsoletes=${includeObsolete}`,
        `rows=${rows}`
      ]
      const onts = Array.isArray(a.ontologies)
        ? (a.ontologies as unknown[]).map((x) => String(x).trim().toLowerCase()).filter(Boolean)
        : []
      if (onts.length > 0) params.push(`ontology=${onts.join(',')}`)
      const resp = (await ctx.fetchJson(
        `${OLS_BASE}/search?${params.join('&')}`
      )) as OlsSearchResponse
      const docs = resp.response?.docs ?? []
      const totalFound = resp.response?.numFound ?? 0
      const terms = docs.map(searchTermRow)
      return {
        query,
        total_found: totalFound,
        n_returned: terms.length,
        truncated: totalFound > terms.length,
        terms
      }
    }
  },
  {
    id: 'get_ontology_term',
    connector: 'genes',
    description:
      'Fetch one ontology term\'s details, or its complete related-term set. With `relation=None`: full term record (label, synonyms, description, obsolete flag, direct parents). With a relation: the COMPLETE, fully paginated set of related terms — e.g. relation="hierarchicalChildren" for direct children incl. part_of etc., "descendants"/"hierarchicalDescendants" for the whole subtree, "ancestors"/"hierarchicalAncestors", "parents", "children". Retrieval is count-verified against the API\'s own total. Args: ontology (lowercase, e.g. "efo","go","cl","chebi"); term_id (CURIE "EFO:0000305"/"GO:0006281" or full IRI); relation (None or one of the listed); include_parents (include direct parent refs when relation is None). Returns: relation=None {curie, iri, label, ontology, short_form, synonyms, description, is_obsolete, has_children, parents}; otherwise {root, relation, total_elements, term_count, terms:[...]}.',
    input: {
      type: 'object',
      properties: {
        ontology: { type: 'string' },
        term_id: { type: 'string' },
        relation: {
          type: 'string',
          enum: [...OLS_RELATIONS]
        },
        include_parents: { type: 'boolean', default: false }
      },
      required: ['ontology', 'term_id']
    },
    required: ['ontology', 'term_id'],
    returns:
      'relation=None -> {curie, iri, label, ontology, short_form, synonyms, description, is_obsolete, has_children, parents?}; with a relation -> {root, relation, total_elements, term_count, terms:[{curie, iri, label, short_form, ontology, has_children}]}.',
    example:
      'result = host.mcp("genes", "get_ontology_term", {"ontology": "go", "term_id": "GO:0006281", "relation": "children"})',
    run: async (ctx, a) => {
      const ontology = String(a.ontology).trim().toLowerCase()
      const termId = String(a.term_id)
      const relationArg = a.relation != null ? String(a.relation).trim() : ''
      const includeParents = a.include_parents === true

      const term = await resolveOlsTerm(ctx, ontology, termId)
      if (!term || !term.iri) {
        throw new Error(`Ontology term not found: '${termId}' in '${ontology}'`)
      }

      // With a relation: page the COMPLETE related-term set via the double-encoded IRI route.
      if (relationArg !== '') {
        if (!OLS_RELATIONS.includes(relationArg as (typeof OLS_RELATIONS)[number])) {
          throw new Error(`Unknown relation '${relationArg}'. Valid: ${OLS_RELATIONS.join(', ')}`)
        }
        const url = `${OLS_BASE}/ontologies/${encodeURIComponent(ontology)}/terms/${doubleEncodeIri(term.iri)}/${relationArg}?size=${OLS_PAGE_SIZE}`
        const { rows, totalElements } = await olsPageAll<OlsTerm>(ctx, url, 'terms')
        return {
          root: term.obo_id ?? termId,
          relation: relationArg,
          total_elements: totalElements,
          term_count: rows.length,
          terms: rows.map(compactTerm)
        }
      }

      // relation=None: the term record itself, optionally with the complete direct-parent set.
      const record: Record<string, unknown> = {
        curie: term.obo_id ?? null,
        iri: term.iri,
        label: term.label,
        ontology: term.ontology_name,
        short_form: term.short_form,
        synonyms: term.synonyms ?? [],
        description: joinDescription(term.description),
        is_obsolete: term.is_obsolete ?? false,
        has_children: term.has_children ?? false
      }
      if (includeParents) {
        const url = `${OLS_BASE}/ontologies/${encodeURIComponent(ontology)}/terms/${doubleEncodeIri(term.iri)}/parents?size=${OLS_PAGE_SIZE}`
        const { rows } = await olsPageAll<OlsTerm>(ctx, url, 'terms')
        record.parents = rows.map(compactTerm)
      }
      return record
    }
  },
  {
    id: 'get_go_annotations',
    connector: 'genes',
    description:
      'Retrieve GO annotations for a UniProt gene product from QuickGO (complete, count-verified). Args: uniprot_accession (e.g. "P04637", prefix optional); aspect (None/all or biological_process/molecular_function/cellular_component); evidence (None/all, a preset "experimental_manual"=manually-assigned experimental evidence, "automatic_iea"=electronic/IEA, or an explicit ECO code like "ECO:0000314"; three-letter GO evidence codes like IDA/IEA are NOT accepted — QuickGO silently ignores goEvidence, filter must use ECO codes); taxon_id (optional NCBI taxon, e.g. 9606); include_term_names (hydrate each record with GO term name/aspect/obsolete via one batched ontology lookup); max_records (cap on records; full set still retrieved and summarized; `truncated` flags the cap). Returns {gene_product, total_annotations, n_records, complete, truncated, distinct_go_ids (across ALL annotations), records:[{go_id, go_aspect, qualifier, go_evidence, eco_id, reference, assigned_by, date, ...}]}.',
    input: {
      type: 'object',
      properties: {
        uniprot_accession: { type: 'string' },
        aspect: {
          type: 'string',
          enum: ['biological_process', 'molecular_function', 'cellular_component']
        },
        evidence: { type: 'string' },
        taxon_id: { type: 'integer' },
        include_term_names: { type: 'boolean', default: false },
        max_records: { type: 'integer', default: 200 }
      },
      required: ['uniprot_accession']
    },
    required: ['uniprot_accession'],
    returns:
      '{gene_product, total_annotations (numberOfHits), n_records, complete (full set retrieved), truncated (records capped), distinct_go_ids:[...], records:[{go_id, go_aspect, qualifier, go_evidence, eco_id, reference, assigned_by, date, taxon_id, symbol, with_from, go_name?, go_obsolete?}]}.',
    example:
      'result = host.mcp("genes", "get_go_annotations", {"uniprot_accession": "P04637", "aspect": "molecular_function", "evidence": "experimental_manual"})',
    run: async (ctx, a) => {
      const acc = String(a.uniprot_accession)
        .trim()
        .replace(/^UniProtKB:/i, '')
      const maxRecords = clampInt(a.max_records, 200, 1, 100_000)
      const includeTermNames = a.include_term_names === true

      const filterParams: string[] = [`geneProductId=${encodeURIComponent(acc)}`]
      const asp = aspectParam(a.aspect != null ? String(a.aspect) : '')
      if (asp) filterParams.push(`aspect=${asp}`)
      const ev = evidenceParams(a.evidence != null ? String(a.evidence) : '')
      if (ev) {
        filterParams.push(`evidenceCode=${encodeURIComponent(ev.code)}`)
        if (ev.usage) filterParams.push(`evidenceCodeUsage=${ev.usage}`)
      }
      if (a.taxon_id != null && String(a.taxon_id) !== '') {
        filterParams.push(`taxonId=${clampInt(a.taxon_id, 0, 0, 99_999_999)}`)
      }

      // Page ALL annotations (limit=200), count-verified against numberOfHits.
      const all: QuickGoAnnotation[] = []
      let totalHits = 0
      let totalPages = 1
      for (let page = 1; page <= totalPages && page <= 100_000; page++) {
        const url = `${QUICKGO_BASE}/annotation/search?${filterParams.join('&')}&limit=${QUICKGO_PAGE_LIMIT}&page=${page}`
        const resp = (await ctx.fetchJson(url)) as QuickGoAnnotationResponse
        if (page === 1) {
          totalHits = resp.numberOfHits ?? 0
          totalPages = resp.pageInfo?.total ?? 1
        }
        const batch = resp.results ?? []
        all.push(...batch)
        if (batch.length === 0) break
        if (all.length >= totalHits) break
      }

      // distinct GO ids across the COMPLETE set (before the record cap).
      const distinctGoIds = Array.from(
        new Set(all.map((r) => r.goId).filter((g): g is string => Boolean(g)))
      ).sort()

      // Optional one batched ontology lookup to hydrate name/aspect/obsolete.
      const termInfo = new Map<string, QuickGoTerm>()
      if (includeTermNames && distinctGoIds.length > 0) {
        for (let i = 0; i < distinctGoIds.length; i += 500) {
          const chunk = distinctGoIds.slice(i, i + 500)
          const resp = (await ctx.fetchJson(
            `${QUICKGO_BASE}/ontology/go/terms/${chunk.join(',')}`
          )) as QuickGoOntologyResponse
          for (const t of resp.results ?? []) {
            if (t.id) termInfo.set(t.id, t)
          }
        }
      }

      const capped = all.slice(0, maxRecords)
      const records = capped.map((r) => {
        const hydrated = r.goId ? termInfo.get(r.goId) : undefined
        const row: Record<string, unknown> = {
          go_id: r.goId,
          go_aspect: hydrated?.aspect ?? r.goAspect,
          qualifier: r.qualifier,
          go_evidence: r.goEvidence,
          eco_id: r.evidenceCode,
          reference: r.reference,
          assigned_by: r.assignedBy,
          date: r.date,
          taxon_id: r.taxonId,
          symbol: r.symbol,
          with_from: r.withFrom ?? null
        }
        if (includeTermNames) {
          row.go_name = hydrated?.name ?? r.goName ?? null
          row.go_obsolete = hydrated?.isObsolete ?? null
        }
        return row
      })

      return {
        gene_product: acc,
        total_annotations: totalHits,
        n_records: records.length,
        complete: all.length === totalHits,
        truncated: all.length > records.length,
        distinct_go_ids: distinctGoIds,
        records
      }
    }
  }
]
