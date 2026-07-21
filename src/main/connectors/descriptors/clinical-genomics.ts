import type { ToolContext, ToolDescriptor } from '../types'

// Three clinical-genomics knowledge bases behind one connector (faithful port of the upstream
// mcp-clinical-genomics server): ClinGen curations (REST), CIViC clinical evidence (GraphQL, fully
// paginated + count-verified), and the Open Targets Platform GraphQL API. All tools are read-only.
const CLINGEN_SEARCH = 'https://search.clinicalgenome.org'
const CLINGEN_ACTIONABILITY = 'https://actionability.clinicalgenome.org'
const CLINGEN_EREPO = 'https://erepo.genome.network/evrepo/api'
const CIVIC_API = 'https://civicdb.org/api/graphql'
const OT_API = 'https://api.platform.opentargets.org/api/v4/graphql'

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

// Coerce an unknown into a plain object / array so record extractors can index it without casts.
const asObj = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {}
const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])

// Null-safe string comparator; drives the tuple sorts that mirror the upstream's `sorted(key=...)`.
function strCmp(a: unknown, b: unknown): number {
  const x = a == null ? '' : String(a)
  const y = b == null ? '' : String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

// Build a lexicographic comparator over one or more string-valued getters (upstream sort keys).
function byKeys(
  ...getters: ((r: Record<string, unknown>) => unknown)[]
): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  return (a, b) => {
    for (const g of getters) {
      const c = strCmp(g(a), g(b))
      if (c) return c
    }
    return 0
  }
}

// ---------------------------------------------------------------------------
// ClinGen record extractors (port of clingen_curations/records.py)
// ---------------------------------------------------------------------------

// Numeric dosage assertion codes -> human labels (verified against the ClinGen dosage CSVs).
const DOSAGE_ASSERTION_LABELS: Record<string, string> = {
  '0': 'No Evidence',
  '1': 'Little Evidence',
  '2': 'Emerging Evidence',
  '3': 'Sufficient Evidence',
  '30': 'Gene Associated with Autosomal Recessive Phenotype',
  '40': 'Dosage Sensitivity Unlikely',
  '-5': 'Not yet evaluated'
}

// Normalize a raw haplo/triplo assertion (int, digit string, "40: ...", "Not yet evaluated", null)
// to {code, label}; keep the raw text as the label for any code we don't recognise.
function normalizeDosageAssertion(value: unknown): { code: string; label: string } | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  const code = s === 'Not yet evaluated' ? '-5' : s.split(':')[0].trim()
  const label = DOSAGE_ASSERTION_LABELS[code]
  return label === undefined ? { code, label: s } : { code, label }
}

// Stable record from one /api/validity row (volatile date/order/report bookkeeping dropped).
function validityRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    gene_symbol: row.symbol,
    hgnc_id: row.hgnc_id,
    disease_label: String(row.disease_name ?? '').trim(),
    mondo_id: row.mondo ?? null,
    moi: row.moi ?? null,
    sop: row.sop ?? null,
    classification: String(row.classification ?? '').trim(),
    expert_panel: String(row.ep ?? '').trim(),
    affiliate_id: row.affiliate_id ?? null,
    animal_model_only: Boolean(row.animal_model_only),
    assertion_id: row.perm_id ?? null
  }
}

// Stable record from one /api/dosage row (external computed scores + history/date fields dropped).
function dosageRecord(row: Record<string, unknown>): Record<string, unknown> {
  const isRegion = row.type === 1
  return {
    record_type: isRegion ? 'region' : 'gene',
    symbol: String(row.symbol ?? '').trim(),
    id: row.hgnc_id ?? null, // HGNC:n for genes, ISCA-n for regions
    cytoband: row.location ?? null,
    grch37: row.grch37 ?? null,
    grch38: row.grch38 ?? null,
    haploinsufficiency: normalizeDosageAssertion(row.haplo_assertion),
    triplosensitivity: normalizeDosageAssertion(row.triplo_assertion),
    haplo_disease: row.haplo_disease ?? null,
    haplo_mondo: row.haplo_mondo ?? null,
    triplo_disease: row.triplo_disease ?? null,
    triplo_mondo: row.triplo_mondo ?? null,
    omim: row.omim ?? null,
    morbid: row.morbid ?? null
  }
}

// Stable record from one actionability flat-table row (dict(zip(columns, row)) minus bookkeeping).
function actionabilityRecord(columns: string[], row: unknown[]): Record<string, unknown> {
  const d: Record<string, unknown> = {}
  columns.forEach((c, i) => (d[c] = row[i]))
  const genes = String(d.geneOrVariant ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
  return {
    doc_id: d.docId ?? null,
    curation_type: d.curationType ?? null,
    context: d.context ?? null,
    release: d.release ?? null,
    release_date: d.releaseDate ?? null,
    genes,
    gene_omim: d.geneOmim ?? null,
    disease: d.disease ?? null,
    disease_omim: d.omim ?? null,
    status_overall: d['status-overall'] ?? null,
    outcome: d.outcome ?? null,
    outcome_scoring_group: d.outcomeScoringGroup ?? null,
    intervention: d.intervention ?? null,
    intervention_scoring_group: d.interventionScoringGroup ?? null,
    severity: d.severity ?? null,
    likelihood: d.likelihood ?? null,
    nature_of_intervention: d.natureOfIntervention ?? null,
    effectiveness: d.effectiveness ?? null,
    overall_score: d.overall ?? null
  }
}

// Stable record from one ERepo variantInterpretation (guidelines/agents nested, collections sorted).
function erepoRecord(interp: Record<string, unknown>): Record<string, unknown> {
  const guidelines = asArr(interp.guidelines)
    .map((gRaw) => {
      const g = asObj(gRaw)
      const agents = asArr(g.agents)
        .map((aRaw) => {
          const ag = asObj(aRaw)
          const met: unknown[] = []
          const notMet: unknown[] = []
          for (const ecRaw of asArr(ag.evidenceCodes)) {
            const ec = asObj(ecRaw)
            ;(ec.status === 'Met' ? met : notMet).push(ec.label)
          }
          return {
            agent_id: ag['@id'] ?? null,
            affiliation: ag.affiliation ?? null,
            outcome: asObj(ag.outcome).label ?? null,
            evidence_codes_met: [...met].sort(strCmp),
            evidence_codes_not_met: [...notMet].sort(strCmp)
          }
        })
        .sort(byKeys((x) => x.agent_id))
      return {
        guideline: g.label ?? null,
        guideline_id: g['@id'] ?? null,
        outcome: asObj(g.outcome).label ?? null,
        agents
      }
    })
    .sort(byKeys((x) => x.guideline_id))
  const cond = asObj(interp.condition)
  const gene = asObj(interp.gene)
  return {
    interpretation_id: interp['@id'] ?? null,
    uuid: interp.uuid ?? null,
    caid: interp.caid ?? null,
    clinvar_variation_id: interp.variationId ?? null,
    gene_symbol: gene.label ?? null,
    gene_ncbi_id: gene.NCBI_id ?? null,
    condition_id: cond['@id'] ?? null,
    condition_label: cond.label ?? null,
    hgvs: [...asArr(interp.hgvs)].sort(strCmp),
    evidence_links: asArr(interp.evidenceLinks)
      .map((e) => asObj(e)['@id'] ?? '')
      .sort(strCmp),
    published_date: interp.publishedDate ?? null,
    guidelines
  }
}

// Resolve the single ClinGen ERepo lookup key (exactly one of gene/caid/hgvs must be present).
function erepoKey(a: Record<string, unknown>): [string, string] {
  const given = (['gene', 'caid', 'hgvs'] as const)
    .map((k) => [k, a[k]] as const)
    .filter(([, v]) => v != null && v !== '')
  if (given.length !== 1) throw new Error('provide exactly one of gene=, caid=, hgvs=')
  return [given[0][0], String(given[0][1])]
}

// ---------------------------------------------------------------------------
// CIViC GraphQL (port of civic_evidence: field selections, normalize, paged walk)
// ---------------------------------------------------------------------------

// Scientifically meaningful, volatile-free field selections (no events/revisions/comments/flags).
const GENE_FIELDS = 'id name entrezId fullName featureAliases description link'
const VARIANT_FIELDS = `
  id name link variantAliases
  variantTypes { id name soid }
  feature { id name }
  singleVariantMolecularProfileId
  ... on GeneVariant {
    alleleRegistryId clinvarIds hgvsDescriptions
    coordinates {
      chromosome start stop referenceBases variantBases
      referenceBuild ensemblVersion representativeTranscript
    }
  }`
const EVIDENCE_FIELDS = `
  id name status evidenceLevel evidenceType evidenceDirection significance
  evidenceRating variantOrigin therapyInteractionType description link
  disease { id name doid displayName }
  therapies { id name ncitId }
  molecularProfile { id name }
  source { id sourceType citationId citation }
  phenotypes { id hpoId name }`
const ASSERTION_FIELDS = `
  id name status assertionType assertionDirection significance ampLevel
  summary description link variantOrigin therapyInteractionType
  regulatoryApproval fdaCompanionTest
  nccnGuideline { id name }
  nccnGuidelineVersion
  acmgCodes { id code }
  clingenCodes { id code }
  disease { id name doid displayName }
  therapies { id name ncitId }
  molecularProfile { id name }
  phenotypes { id hpoId name }
  evidenceItemsCount`
const MOLECULAR_PROFILE_FIELDS = `
  id name rawName link description molecularProfileScore
  isComplex isMultiVariant molecularProfileAliases
  variants { id name feature { id name } }
  evidenceCountsByStatus { acceptedCount submittedCount rejectedCount }`
const DISEASE_FIELDS = 'id name displayName doid diseaseUrl diseaseAliases link'
const THERAPY_FIELDS = 'id name ncitId therapyUrl therapyAliases link'

// Unordered collections are sorted for order-stable output (mirrors records.py::normalize).
const CIVIC_STRING_LIST_FIELDS = new Set([
  'featureAliases',
  'variantAliases',
  'hgvsDescriptions',
  'clinvarIds',
  'molecularProfileAliases',
  'diseaseAliases',
  'therapyAliases'
])
const CIVIC_DICT_LIST_SORT: Record<string, (d: Record<string, unknown>) => unknown[]> = {
  variantTypes: (d) => [d.soid ?? '', d.id ?? 0],
  therapies: (d) => [d.id ?? 0],
  phenotypes: (d) => [d.id ?? 0],
  acmgCodes: (d) => [d.code ?? ''],
  clingenCodes: (d) => [d.code ?? ''],
  variants: (d) => [d.id ?? 0]
}

// Element-wise comparison of two sort-key tuples (numbers compared numerically, else lexically).
function cmpTuple(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

// Recursively sort unordered collections so a record's byte shape is stable across fetches.
function civicNormalize(obj: unknown, parentKey?: string): unknown {
  if (Array.isArray(obj)) {
    const items = obj.map((v) => civicNormalize(v, parentKey))
    if (parentKey && CIVIC_STRING_LIST_FIELDS.has(parentKey)) {
      return [...items].sort((a, b) => {
        if (a == null && b == null) return 0
        if (a == null) return 1
        if (b == null) return -1
        return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
      })
    }
    const keyFn = parentKey ? CIVIC_DICT_LIST_SORT[parentKey] : undefined
    if (keyFn && items.every((i) => i !== null && typeof i === 'object' && !Array.isArray(i))) {
      return [...items].sort((a, b) =>
        cmpTuple(keyFn(a as Record<string, unknown>), keyFn(b as Record<string, unknown>))
      )
    }
    return items
  }
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>))
      out[k] = civicNormalize(v, k)
    return out
  }
  return obj
}

// The server caps `first` at 100 regardless of the requested value, so 100 is the page size.
const CIVIC_PAGE_SIZE = 100
// Hard ceiling so a mis-reported hasNextPage can never loop unbounded (the largest CIViC corpus,
// evidence items, is ~100 pages — 500 leaves generous headroom without being open-ended).
const CIVIC_MAX_PAGES = 500

type CivicBody = { data?: Record<string, unknown> | null; errors?: unknown }

// POST one CIViC operation; surface GraphQL errors (deterministic, so not retried) and return `data`.
async function civicExecute(
  ctx: ToolContext,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const body = (await ctx.postJson(CIVIC_API, { query, variables })) as CivicBody
  if (body.errors && (!Array.isArray(body.errors) || body.errors.length)) {
    throw new Error(`CIViC GraphQL error: ${JSON.stringify(body.errors).slice(0, 500)}`)
  }
  return body.data ?? {}
}

// Walk one Relay connection to completion and verify the retrieved count against totalCount.
async function civicPaged(
  ctx: ToolContext,
  field: string,
  argDecls: string,
  argRefs: string,
  variables: Record<string, unknown>,
  nodeFields: string
): Promise<{ total_count: number; pages_fetched: number; records: Record<string, unknown>[] }> {
  const query = `
    query Paged($first: Int, $after: String${argDecls}) {
      conn: ${field}(first: $first, after: $after${argRefs}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${nodeFields} }
      }
    }`
  const nodes: unknown[] = []
  let after: string | null = null
  let total = 0
  let pages = 0
  for (;;) {
    const data = await civicExecute(ctx, query, { ...variables, first: CIVIC_PAGE_SIZE, after })
    const conn = asObj(data.conn)
    const page = asObj(conn.pageInfo)
    total = Number(conn.totalCount ?? 0)
    nodes.push(...asArr(conn.nodes))
    pages += 1
    if (!page.hasNextPage) break
    if (pages >= CIVIC_MAX_PAGES) {
      throw new Error(`${field}: exceeded ${CIVIC_MAX_PAGES} pages (${nodes.length}/${total})`)
    }
    after = (page.endCursor as string | null) ?? null
  }
  if (nodes.length !== total) {
    throw new Error(`${field}: retrieved ${nodes.length} nodes but totalCount=${total}`)
  }
  return {
    total_count: total,
    pages_fetched: pages,
    records: nodes.map((n) => civicNormalize(n) as Record<string, unknown>)
  }
}

// Fetch one entity by CIViC id; found=false (record=null) when the id does not exist.
async function civicSingle(
  ctx: ToolContext,
  field: string,
  id: number,
  nodeFields: string
): Promise<{ query: Record<string, unknown>; found: boolean; record: unknown }> {
  const query = `query Single($id: Int!) { node: ${field}(id: $id) { ${nodeFields} } }`
  const data = await civicExecute(ctx, query, { id })
  const rec = data.node ?? null
  return {
    query: { mode: field, id },
    found: rec !== null,
    record: rec !== null ? civicNormalize(rec) : null
  }
}

// python kwarg -> [GraphQL arg, GraphQL type]; a type of "Int" also drives the JSON-schema type.
const EVIDENCE_FILTERS: Record<string, [string, string]> = {
  disease_name: ['diseaseName', 'String'],
  therapy_name: ['therapyName', 'String'],
  evidence_level: ['evidenceLevel', 'EvidenceLevel'],
  evidence_type: ['evidenceType', 'EvidenceType'],
  evidence_direction: ['evidenceDirection', 'EvidenceDirection'],
  significance: ['significance', 'EvidenceSignificance'],
  variant_origin: ['variantOrigin', 'VariantOrigin'],
  evidence_rating: ['evidenceRating', 'Int'],
  status: ['status', 'EvidenceStatusFilter'],
  molecular_profile_name: ['molecularProfileName', 'String'],
  molecular_profile_id: ['molecularProfileId', 'Int'],
  variant_id: ['variantId', 'Int'],
  disease_id: ['diseaseId', 'Int'],
  therapy_id: ['therapyId', 'Int'],
  phenotype_id: ['phenotypeId', 'Int'],
  source_id: ['sourceId', 'Int'],
  assertion_id: ['assertionId', 'Int']
}
const ASSERTION_FILTERS: Record<string, [string, string]> = {
  disease_name: ['diseaseName', 'String'],
  therapy_name: ['therapyName', 'String'],
  assertion_type: ['assertionType', 'EvidenceType'],
  assertion_direction: ['assertionDirection', 'EvidenceDirection'],
  significance: ['significance', 'AssertionSignificance'],
  amp_level: ['ampLevel', 'AmpLevel'],
  status: ['status', 'EvidenceStatusFilter'],
  molecular_profile_name: ['molecularProfileName', 'String'],
  molecular_profile_id: ['molecularProfileId', 'Int'],
  variant_id: ['variantId', 'Int'],
  variant_name: ['variantName', 'String'],
  disease_id: ['diseaseId', 'Int'],
  therapy_id: ['therapyId', 'Int'],
  phenotype_id: ['phenotypeId', 'Int'],
  evidence_id: ['evidenceId', 'Int'],
  summary: ['summary', 'String']
}

// Turn a filter table into a JSON-Schema `input` (Int -> integer, everything else -> string).
function filterInput(table: Record<string, [string, string]>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [key, [, gqlType]] of Object.entries(table)) {
    properties[key] = { type: gqlType === 'Int' ? 'integer' : 'string' }
  }
  return { type: 'object', properties }
}

// Paginated filtered search (evidence/assertions): build GraphQL args from the provided filters,
// always sort by ascending id for deterministic output.
async function civicFilteredSearch(
  ctx: ToolContext,
  field: string,
  args: Record<string, unknown>,
  table: Record<string, [string, string]>,
  nodeFields: string,
  sortType: string,
  mode: string
): Promise<Record<string, unknown>> {
  const decls: string[] = []
  const refs: string[] = []
  const variables: Record<string, unknown> = {}
  const used: Record<string, unknown> = {}
  for (const [key, [gqlArg, gqlType]] of Object.entries(table)) {
    const value = args[key]
    if (value == null) continue
    const vname = `f_${gqlArg}`
    decls.push(`, $${vname}: ${gqlType}`)
    refs.push(`, ${gqlArg}: $${vname}`)
    variables[vname] = value
    used[key] = value
  }
  decls.push(`, $sb: ${sortType}`)
  refs.push(', sortBy: $sb')
  variables.sb = { column: 'ID', direction: 'ASC' }
  const out = await civicPaged(ctx, field, decls.join(''), refs.join(''), variables, nodeFields)
  return { ...out, query: { mode, filters: used } }
}

// Sort CIViC records in place by ascending numeric id (the id-keyed order the gate expects).
function sortById(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.sort((a, b) => Number(a.id) - Number(b.id))
}

// ---------------------------------------------------------------------------
// Open Targets Platform GraphQL (port of mcp_clinical_genomics/open_targets.py + server queries)
// ---------------------------------------------------------------------------

const OT_MAX_ATTEMPTS = 3

const OT_DISEASE_DRUGS_Q = `query($id: String!) {
  disease(efoId: $id) {
    id name
    drugAndClinicalCandidates {
      count
      rows { id maxClinicalStage drug { id name drugType } }
    }
  }
}`
const OT_DISEASE_TARGETS_Q = `query($id: String!, $size: Int!) {
  disease(efoId: $id) {
    id name
    associatedTargets(page: {size: $size, index: 0}) {
      count
      rows { score target { id approvedSymbol } }
    }
  }
}`
const OT_DRUG_Q = `query($id: String!) {
  drug(chemblId: $id) {
    id name drugType maximumClinicalStage
    mechanismsOfAction {
      rows { mechanismOfAction actionType targets { id approvedSymbol } }
    }
  }
}`

// True when every GraphQL error looks like the platform's transient HTTP-200 "Internal server error".
function otTransient(errors: unknown): boolean {
  if (!Array.isArray(errors) || !errors.length) return false
  const msgs = errors
    .filter((e) => e !== null && typeof e === 'object')
    .map((e) => String((e as Record<string, unknown>).message ?? '').toLowerCase())
  return msgs.length > 0 && msgs.every((m) => m.includes('internal server error'))
}

type OtResult = { data: unknown; attempts: number; errors?: unknown }

// POST one Open Targets operation; retry only the transient internal-server quirk (deterministic
// GraphQL errors are returned honestly). HTTP 429/5xx retries are handled by the engine.
async function otExecute(
  ctx: ToolContext,
  query: string,
  variables?: Record<string, unknown>
): Promise<OtResult> {
  let last: { data: unknown; errors?: unknown } = { data: null }
  for (let attempt = 1; attempt <= OT_MAX_ATTEMPTS; attempt++) {
    const body = (await ctx.postJson(OT_API, variables ? { query, variables } : { query })) as {
      data?: unknown
      errors?: unknown
    }
    const errors = body.errors
    if (errors && otTransient(errors) && attempt < OT_MAX_ATTEMPTS) {
      last = { data: body.data ?? null, errors }
      continue
    }
    const out: OtResult = { data: body.data ?? null, attempts: attempt }
    if (errors) out.errors = errors
    return out
  }
  return { ...last, attempts: OT_MAX_ATTEMPTS }
}

// Run a curated Open Targets query and return data[root], or {errors} when it is null / errored.
async function otQuery(
  ctx: ToolContext,
  query: string,
  variables: Record<string, unknown>,
  root: string
): Promise<Record<string, unknown>> {
  const result = await otExecute(ctx, query, variables)
  const node = asObj(result.data)[root]
  if (node == null) {
    return {
      errors: result.errors ?? [{ message: `${root} not found for ${JSON.stringify(variables)}` }]
    }
  }
  return node as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

export const CLINICAL_GENOMICS_TOOLS: ToolDescriptor[] = [
  // ------------------------------------------------------------- ClinGen --
  {
    id: 'clingen_gene_validity',
    connector: 'clinical_genomics',
    description:
      'ClinGen gene-disease validity curations (how strong the evidence is that variation in a gene causes a disease: Definitive/Strong/Moderate/Limited/Disputed/Refuted/No Known Disease Relationship). Omit gene to list all 3,600+ curations.',
    input: {
      type: 'object',
      properties: { gene: { type: 'string' } }
    },
    returns:
      '`{ "total": int, "records": [ { "gene_symbol": str, "hgnc_id": str, "disease_label": str, "mondo_id": str, "moi": str, "sop": str, "classification": str, "expert_panel": str, "affiliate_id": str, "animal_model_only": bool, "assertion_id": str } ], "source": str }` — records filtered to the gene (exact, case-insensitive) or the full table when gene is omitted.',
    example:
      'const result = await host.mcp("clinical_genomics", "clingen_gene_validity", {"gene": "BRCA2"})',
    url: () => `${CLINGEN_SEARCH}/api/validity`,
    parse: (raw, a) => {
      const d = raw as { total: number; rows: Record<string, unknown>[] }
      if (d.total !== d.rows.length) {
        throw new Error(`validity count mismatch: total=${d.total} rows=${d.rows.length}`)
      }
      let records = d.rows.map(validityRecord)
      const gene = a.gene ? String(a.gene).trim().toUpperCase() : null
      if (gene) records = records.filter((r) => String(r.gene_symbol).toUpperCase() === gene)
      records.sort(
        byKeys(
          (r) => r.gene_symbol,
          (r) => r.assertion_id ?? ''
        )
      )
      return {
        total: records.length,
        records,
        source: 'ClinGen Gene-Disease Validity (search.clinicalgenome.org/api/validity)'
      }
    }
  },
  {
    id: 'clingen_dosage_sensitivity',
    connector: 'clinical_genomics',
    description:
      'ClinGen dosage sensitivity curations: haploinsufficiency and triplosensitivity assertions for genes (and optionally ISCA genomic/CNV regions). A gene symbol or an ISCA region id filters exactly; omit for the full table.',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string' },
        include_regions: { type: 'boolean', default: false }
      }
    },
    returns:
      '`{ "total": int, "records": [ { "record_type": "gene"|"region", "symbol": str, "id": str, "cytoband": str, "grch37": str, "grch38": str, "haploinsufficiency": { "code": str, "label": str }|null, "triplosensitivity": {...}|null, "haplo_disease": str, "haplo_mondo": str, "triplo_disease": str, "triplo_mondo": str, "omim": str, "morbid": str } ], "source": str }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "clingen_dosage_sensitivity", {"gene": "TP53"})',
    url: () => `${CLINGEN_SEARCH}/api/dosage`,
    parse: (raw, a) => {
      const d = raw as { total: number; rows: Record<string, unknown>[] }
      if (d.total !== d.rows.length) {
        throw new Error(`dosage count mismatch: total=${d.total} rows=${d.rows.length}`)
      }
      let records = d.rows.map(dosageRecord)
      const includeRegions = Boolean(a.include_regions)
      if (!includeRegions && a.gene == null) {
        records = records.filter((r) => r.record_type === 'gene')
      }
      const gene = a.gene ? String(a.gene).trim().toUpperCase() : null
      if (gene) {
        records = records.filter(
          (r) =>
            String(r.symbol).toUpperCase() === gene || String(r.id ?? '').toUpperCase() === gene
        )
      }
      records.sort(
        byKeys(
          (r) => r.record_type,
          (r) => r.symbol,
          (r) => r.id ?? ''
        )
      )
      return {
        total: records.length,
        records,
        source: 'ClinGen Dosage Sensitivity (search.clinicalgenome.org/api/dosage)'
      }
    }
  },
  {
    id: 'clingen_actionability',
    connector: 'clinical_genomics',
    description:
      'ClinGen clinical actionability curations: for disorders associated with a gene, whether early intervention in pre-symptomatic carriers is actionable (intervention/outcome pairs with severity, likelihood, effectiveness, nature-of-intervention component scores and the total score). Gene filter matches any member of multi-gene topics.',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string' },
        context: { type: 'string', enum: ['adult', 'pediatric', 'both'], default: 'both' }
      }
    },
    returns:
      '`{ "adult"?: { "total": int, "records": [...] }, "pediatric"?: { "total": int, "records": [...] }, "source": str }` — one block per requested context; each record has doc_id, genes, disease, outcome, intervention, severity, likelihood, nature_of_intervention, effectiveness, overall_score, release/release_date.',
    example:
      'const result = await host.mcp("clinical_genomics", "clingen_actionability", {"gene": "BRCA1", "context": "adult"})',
    run: async (ctx, a) => {
      const ctxMap: Record<string, string[]> = {
        adult: ['Adult'],
        pediatric: ['Pediatric'],
        both: ['Adult', 'Pediatric']
      }
      const context = String(a.context ?? 'both')
      const contexts = ctxMap[context]
      if (!contexts) throw new Error("context must be 'adult', 'pediatric' or 'both'")
      const gene = a.gene ? String(a.gene).trim().toUpperCase() : null
      const out: Record<string, unknown> = {}
      for (const c of contexts) {
        const d = (await ctx.fetchJson(
          `${CLINGEN_ACTIONABILITY}/ac/${c}/api/summ?flavor=flat`
        )) as { columns?: string[]; rows?: unknown[][] }
        if (!Array.isArray(d.columns) || !Array.isArray(d.rows)) {
          throw new Error(`unexpected actionability payload shape for ${c}`)
        }
        const columns = d.columns
        let records = d.rows.map((row) => actionabilityRecord(columns, row))
        if (gene) {
          records = records.filter((r) =>
            (r.genes as string[]).map((x) => x.toUpperCase()).includes(gene)
          )
        }
        records.sort(
          byKeys(
            (r) => r.doc_id ?? '',
            (r) => r.outcome ?? '',
            (r) => r.intervention ?? ''
          )
        )
        out[c.toLowerCase()] = { total: records.length, records }
      }
      out.source =
        'ClinGen Clinical Actionability (actionability.clinicalgenome.org flat summaries)'
      return out
    }
  },
  {
    id: 'clingen_variant_classifications',
    connector: 'clinical_genomics',
    description:
      'ClinGen Evidence Repository (ERepo) expert-panel variant pathogenicity classifications (VCEP interpretations under ACMG criteria). Provide EXACTLY ONE of gene (HGNC symbol), caid (ClinGen canonical allele id, e.g. CA114360), or hgvs (e.g. NM_000277.2:c.1222C>T). Complete retrieval (matchLimit=none).',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string' },
        caid: { type: 'string' },
        hgvs: { type: 'string' }
      }
    },
    returns:
      '`{ "total": int, "records": [ { "interpretation_id": str, "uuid": str, "caid": str, "clinvar_variation_id": str, "gene_symbol": str, "gene_ncbi_id": str, "condition_id": str, "condition_label": str, "hgvs": [str], "evidence_links": [str], "published_date": str, "guidelines": [ { "guideline": str, "guideline_id": str, "outcome": str, "agents": [ { "agent_id": str, "affiliation": str, "outcome": str, "evidence_codes_met": [str], "evidence_codes_not_met": [str] } ] } ] } ], "query": { <gene|caid|hgvs>: str }, "source": str }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "clingen_variant_classifications", {"gene": "BRCA1"})',
    url: (a) => {
      const [param, value] = erepoKey(a)
      const qs = new URLSearchParams({ [param]: value, matchMode: 'exact', matchLimit: 'none' })
      return `${CLINGEN_EREPO}/classifications?${qs.toString()}`
    },
    parse: (raw, a) => {
      const [param, value] = erepoKey(a)
      const d = raw as { variantInterpretations?: Record<string, unknown>[] }
      const records = (d.variantInterpretations ?? []).map(erepoRecord)
      records.sort(byKeys((r) => r.interpretation_id ?? ''))
      return {
        total: records.length,
        records,
        query: { [param]: value },
        source: 'ClinGen Evidence Repository (erepo.genome.network/evrepo/api)'
      }
    }
  },
  // --------------------------------------------------------------- CIViC --
  {
    id: 'civic_search_genes',
    connector: 'clinical_genomics',
    description:
      'Find CIViC gene records by exact Entrez symbol (e.g. "BRAF"). Fully paginated, count-verified. Use the returned CIViC gene id with civic_gene_variants.',
    input: {
      type: 'object',
      properties: { entrez_symbol: { type: 'string' } },
      required: ['entrez_symbol']
    },
    required: ['entrez_symbol'],
    returns:
      '`{ "total_count": int, "pages_fetched": int, "records": [ { "id": int, "name": str, "entrezId": int, "fullName": str, "featureAliases": [str], "description": str, "link": str } ], "query": { "mode": "search_genes", "entrez_symbol": str } }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_search_genes", {"entrez_symbol": "BRAF"})',
    run: async (ctx, a) => {
      const out = await civicPaged(
        ctx,
        'genes',
        ', $sym: [String!]',
        ', entrezSymbols: $sym',
        { sym: [String(a.entrez_symbol)] },
        GENE_FIELDS
      )
      return { ...out, query: { mode: 'search_genes', entrez_symbol: a.entrez_symbol } }
    }
  },
  {
    id: 'civic_gene_variants',
    connector: 'clinical_genomics',
    description:
      'All variants of one CIViC gene (by CIViC gene id), fully paginated — complete even for genes with hundreds of variants. Sorted by variant id.',
    input: {
      type: 'object',
      properties: { gene_id: { type: 'integer' } },
      required: ['gene_id']
    },
    required: ['gene_id'],
    returns:
      '`{ "total_count": int, "pages_fetched": int, "records": [ { "id": int, "name": str, "link": str, "variantAliases": [str], "variantTypes": [{ "id": int, "name": str, "soid": str }], "feature": { "id": int, "name": str }, "singleVariantMolecularProfileId": int, "alleleRegistryId"?: str, "clinvarIds"?: [str], "hgvsDescriptions"?: [str], "coordinates"?: {...} } ], "query": {...} }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_gene_variants", {"gene_id": 5})',
    run: async (ctx, a) => {
      const out = await civicPaged(
        ctx,
        'variants',
        ', $gid: Int',
        ', geneId: $gid',
        { gid: Number(a.gene_id) },
        VARIANT_FIELDS
      )
      return {
        ...out,
        records: sortById(out.records),
        query: { mode: 'gene_variants', gene_id: Number(a.gene_id) }
      }
    }
  },
  {
    id: 'civic_get_variant',
    connector: 'clinical_genomics',
    description:
      'One CIViC variant by its CIViC variant id (aliases, variant types, feature/gene linkage, coordinates for gene variants). Returns found=false if absent.',
    input: {
      type: 'object',
      properties: { variant_id: { type: 'integer' } },
      required: ['variant_id']
    },
    required: ['variant_id'],
    returns:
      '`{ "query": { "mode": "variant", "id": int }, "found": bool, "record": { "id": int, "name": str, "variantTypes": [...], "feature": {...}, "coordinates"?: {...}, ... }|null }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_get_variant", {"variant_id": 12})',
    run: async (ctx, a) => civicSingle(ctx, 'variant', Number(a.variant_id), VARIANT_FIELDS)
  },
  {
    id: 'civic_search_variants',
    connector: 'clinical_genomics',
    description:
      'Search CIViC variants by name substring (e.g. "V600"), optionally scoped to a CIViC gene id. Fully paginated; sorted by variant id.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        gene_id: { type: 'integer' }
      },
      required: ['name']
    },
    required: ['name'],
    returns:
      '`{ "total_count": int, "pages_fetched": int, "records": [ <variant record> ], "query": { "mode": "search_variants", "name": str, "gene_id": int|null } }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_search_variants", {"name": "V600", "gene_id": 5})',
    run: async (ctx, a) => {
      let decls = ', $name: String'
      let refs = ', name: $name'
      const variables: Record<string, unknown> = { name: String(a.name) }
      const geneId = a.gene_id == null ? null : Number(a.gene_id)
      if (geneId != null) {
        decls += ', $gid: Int'
        refs += ', geneId: $gid'
        variables.gid = geneId
      }
      const out = await civicPaged(ctx, 'variants', decls, refs, variables, VARIANT_FIELDS)
      return {
        ...out,
        records: sortById(out.records),
        query: { mode: 'search_variants', name: a.name, gene_id: geneId }
      }
    }
  },
  {
    id: 'civic_get_evidence_item',
    connector: 'clinical_genomics',
    description:
      'One CIViC evidence item by id: clinical significance of a molecular profile in a disease/therapy context (evidence level A-E, type, direction, significance, rating, disease, therapies, source). Returns found=false if absent.',
    input: {
      type: 'object',
      properties: { evidence_id: { type: 'integer' } },
      required: ['evidence_id']
    },
    required: ['evidence_id'],
    returns:
      '`{ "query": { "mode": "evidenceItem", "id": int }, "found": bool, "record": { "id": int, "evidenceLevel": str, "evidenceType": str, "evidenceDirection": str, "significance": str, "evidenceRating": int, "disease": {...}, "therapies": [...], "molecularProfile": {...}, "source": {...}, ... }|null }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_get_evidence_item", {"evidence_id": 1409})',
    run: async (ctx, a) => civicSingle(ctx, 'evidenceItem', Number(a.evidence_id), EVIDENCE_FIELDS)
  },
  {
    id: 'civic_search_evidence',
    connector: 'clinical_genomics',
    description:
      'Search CIViC evidence items by any combination of filters; fully paginated, count-verified, sorted by ascending evidence id. Enum filters take CIViC GraphQL enum values verbatim (evidence_level "A".."E"; evidence_type PREDICTIVE|PROGNOSTIC|DIAGNOSTIC|PREDISPOSING|ONCOGENIC|FUNCTIONAL; evidence_direction SUPPORTS|DOES_NOT_SUPPORT; status ACCEPTED|SUBMITTED|REJECTED|ALL). Provide at least one filter — no filters walks the entire 10k+ corpus.',
    input: filterInput(EVIDENCE_FILTERS),
    returns:
      '`{ "total_count": int, "pages_fetched": int, "records": [ <evidence record> ], "query": { "mode": "search_evidence", "filters": {...} } }` — records sorted by ascending evidence id.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_search_evidence", {"disease_name": "melanoma", "evidence_level": "A"})',
    run: async (ctx, a) =>
      civicFilteredSearch(
        ctx,
        'evidenceItems',
        a,
        EVIDENCE_FILTERS,
        EVIDENCE_FIELDS,
        'EvidenceSort',
        'search_evidence'
      )
  },
  {
    id: 'civic_get_assertion',
    connector: 'clinical_genomics',
    description:
      'One CIViC assertion by id: an expert-curated summary claim (AMP/ASCO/CAP tier, ACMG/ClinGen codes, FDA companion-test flags) aggregating evidence for a molecular profile in a disease/therapy context. Returns found=false if absent.',
    input: {
      type: 'object',
      properties: { assertion_id: { type: 'integer' } },
      required: ['assertion_id']
    },
    required: ['assertion_id'],
    returns:
      '`{ "query": { "mode": "assertion", "id": int }, "found": bool, "record": { "id": int, "assertionType": str, "assertionDirection": str, "significance": str, "ampLevel": str, "summary": str, "acmgCodes": [...], "clingenCodes": [...], "disease": {...}, "therapies": [...], "evidenceItemsCount": int, ... }|null }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_get_assertion", {"assertion_id": 7})',
    run: async (ctx, a) => civicSingle(ctx, 'assertion', Number(a.assertion_id), ASSERTION_FIELDS)
  },
  {
    id: 'civic_search_assertions',
    connector: 'clinical_genomics',
    description:
      'Search CIViC assertions by any combination of filters; fully paginated, count-verified, sorted by ascending assertion id. assertion_type PREDICTIVE|PROGNOSTIC|DIAGNOSTIC|PREDISPOSING|ONCOGENIC; assertion_direction SUPPORTS|DOES_NOT_SUPPORT; amp_level e.g. TIER_I_LEVEL_A; status ACCEPTED|SUBMITTED|REJECTED|ALL. No filters walks the full corpus.',
    input: filterInput(ASSERTION_FILTERS),
    returns:
      '`{ "total_count": int, "pages_fetched": int, "records": [ <assertion record> ], "query": { "mode": "search_assertions", "filters": {...} } }` — records sorted by ascending assertion id.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_search_assertions", {"disease_name": "melanoma"})',
    run: async (ctx, a) =>
      civicFilteredSearch(
        ctx,
        'assertions',
        a,
        ASSERTION_FILTERS,
        ASSERTION_FIELDS,
        'AssertionSort',
        'search_assertions'
      )
  },
  {
    id: 'civic_get_molecular_profile',
    connector: 'clinical_genomics',
    description:
      'One CIViC molecular profile by id (variant combination that evidence/assertions attach to), incl. parsed name, score, and component variants. Returns found=false if absent.',
    input: {
      type: 'object',
      properties: { mp_id: { type: 'integer' } },
      required: ['mp_id']
    },
    required: ['mp_id'],
    returns:
      '`{ "query": { "mode": "molecularProfile", "id": int }, "found": bool, "record": { "id": int, "name": str, "rawName": str, "molecularProfileScore": float, "isComplex": bool, "isMultiVariant": bool, "molecularProfileAliases": [str], "variants": [{ "id": int, "name": str, "feature": {...} }], "evidenceCountsByStatus": {...} }|null }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_get_molecular_profile", {"mp_id": 12})',
    run: async (ctx, a) =>
      civicSingle(ctx, 'molecularProfile', Number(a.mp_id), MOLECULAR_PROFILE_FIELDS)
  },
  {
    id: 'civic_search_molecular_profiles',
    connector: 'clinical_genomics',
    description:
      'Search CIViC molecular profiles by name substring (e.g. "BRAF V600E"). Fully paginated; sorted by id.',
    input: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    },
    required: ['name'],
    returns:
      '`{ "total_count": int, "pages_fetched": int, "records": [ <molecular profile record> ], "query": { "mode": "search_molecular_profiles", "name": str } }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_search_molecular_profiles", {"name": "BRAF V600E"})',
    run: async (ctx, a) => {
      const out = await civicPaged(
        ctx,
        'molecularProfiles',
        ', $name: String',
        ', name: $name',
        { name: String(a.name) },
        MOLECULAR_PROFILE_FIELDS
      )
      return {
        ...out,
        records: sortById(out.records),
        query: { mode: 'search_molecular_profiles', name: a.name }
      }
    }
  },
  {
    id: 'civic_search_diseases',
    connector: 'clinical_genomics',
    description:
      'Search CIViC disease records by name substring (e.g. "melanoma"). Returns DOIDs + display names; fully paginated; sorted by id.',
    input: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    },
    required: ['name'],
    returns:
      '`{ "total_count": int, "pages_fetched": int, "records": [ { "id": int, "name": str, "displayName": str, "doid": str, "diseaseUrl": str, "diseaseAliases": [str], "link": str } ], "query": { "mode": "search_diseases", "name": str } }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_search_diseases", {"name": "melanoma"})',
    run: async (ctx, a) => {
      const out = await civicPaged(
        ctx,
        'diseases',
        ', $name: String',
        ', name: $name',
        { name: String(a.name) },
        DISEASE_FIELDS
      )
      return {
        ...out,
        records: sortById(out.records),
        query: { mode: 'search_diseases', name: a.name }
      }
    }
  },
  {
    id: 'civic_search_therapies',
    connector: 'clinical_genomics',
    description:
      'Search CIViC therapy records by name substring (e.g. "vemurafenib"). Returns NCIt ids + names; fully paginated; sorted by id.',
    input: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    },
    required: ['name'],
    returns:
      '`{ "total_count": int, "pages_fetched": int, "records": [ { "id": int, "name": str, "ncitId": str, "therapyUrl": str, "therapyAliases": [str], "link": str } ], "query": { "mode": "search_therapies", "name": str } }`.',
    example:
      'const result = await host.mcp("clinical_genomics", "civic_search_therapies", {"name": "vemurafenib"})',
    run: async (ctx, a) => {
      const out = await civicPaged(
        ctx,
        'therapies',
        ', $name: String',
        ', name: $name',
        { name: String(a.name) },
        THERAPY_FIELDS
      )
      return {
        ...out,
        records: sortById(out.records),
        query: { mode: 'search_therapies', name: a.name }
      }
    }
  },
  // --------------------------------------------------------- Open Targets --
  {
    id: 'open_targets_graphql',
    connector: 'clinical_genomics',
    description:
      'Run an arbitrary GraphQL query against the Open Targets Platform API (targets, diseases, drugs, target-disease association scores, evidence, tractability, safety, known drugs). Introspection queries work for schema discovery. Note knownDrugs was renamed to drugAndClinicalCandidates upstream.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        variables: { type: 'object' }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ "data": {...}|null, "attempts": int, "errors"?: [ { "message": str } ] }` — the raw GraphQL data payload; transient HTTP-200 "Internal server error" responses are retried up to 3 attempts before being surfaced in errors.',
    example:
      'const result = await host.mcp("clinical_genomics", "open_targets_graphql", {"query": "query($id: String!){ target(ensemblId: $id){ approvedSymbol associatedDiseases{ count } } }", "variables": {"id": "ENSG00000157764"}})',
    run: async (ctx, a) => {
      const variables = asObj(a.variables)
      return otExecute(ctx, String(a.query), Object.keys(variables).length ? variables : undefined)
    }
  },
  {
    id: 'open_targets_disease_drugs',
    connector: 'clinical_genomics',
    description:
      'Known/investigational drugs for a disease (Open Targets Platform) — wraps Disease.drugAndClinicalCandidates. efo_id is a disease ontology id (EFO/MONDO/etc., e.g. "MONDO_0004992").',
    input: {
      type: 'object',
      properties: {
        efo_id: { type: 'string' },
        size: { type: 'integer', default: 25 }
      },
      required: ['efo_id']
    },
    required: ['efo_id'],
    returns:
      '`{ "id": str, "name": str, "drugAndClinicalCandidates": { "count": int, "rows": [ { "id": str, "maxClinicalStage": str, "drug": { "id": str, "name": str, "drugType": str } } ] } }` (rows capped at `size`, default 25), or `{ "errors": [...] }` on GraphQL error / unknown id.',
    example:
      'const result = await host.mcp("clinical_genomics", "open_targets_disease_drugs", {"efo_id": "MONDO_0004992", "size": 25})',
    run: async (ctx, a) => {
      const size = Number(a.size ?? 25)
      const node = await otQuery(ctx, OT_DISEASE_DRUGS_Q, { id: String(a.efo_id) }, 'disease')
      const cand = node.drugAndClinicalCandidates as { rows?: unknown[] } | undefined
      if (cand && Array.isArray(cand.rows)) cand.rows = cand.rows.slice(0, size)
      return node
    }
  },
  {
    id: 'open_targets_disease_targets',
    connector: 'clinical_genomics',
    description:
      'Top associated targets for a disease, ranked by Open Targets overall association score — wraps Disease.associatedTargets. efo_id is a disease ontology id (EFO/MONDO/etc.).',
    input: {
      type: 'object',
      properties: {
        efo_id: { type: 'string' },
        size: { type: 'integer', default: 25 }
      },
      required: ['efo_id']
    },
    required: ['efo_id'],
    returns:
      '`{ "id": str, "name": str, "associatedTargets": { "count": int, "rows": [ { "score": float, "target": { "id": str, "approvedSymbol": str } } ] } }` (up to `size` rows, default 25), or `{ "errors": [...] }` on GraphQL error / unknown id.',
    example:
      'const result = await host.mcp("clinical_genomics", "open_targets_disease_targets", {"efo_id": "MONDO_0004992", "size": 25})',
    run: async (ctx, a) =>
      otQuery(
        ctx,
        OT_DISEASE_TARGETS_Q,
        { id: String(a.efo_id), size: Number(a.size ?? 25) },
        'disease'
      )
  },
  {
    id: 'open_targets_drug',
    connector: 'clinical_genomics',
    description:
      'Drug details by ChEMBL id (Open Targets Platform) — name, type, maximum clinical stage, and mechanisms of action (target + action type). chembl_id e.g. "CHEMBL1201583".',
    input: {
      type: 'object',
      properties: { chembl_id: { type: 'string' } },
      required: ['chembl_id']
    },
    required: ['chembl_id'],
    returns:
      '`{ "id": str, "name": str, "drugType": str, "maximumClinicalStage": str, "mechanismsOfAction": { "rows": [ { "mechanismOfAction": str, "actionType": str, "targets": [ { "id": str, "approvedSymbol": str } ] } ] } }`, or `{ "errors": [...] }` on GraphQL error / unknown id.',
    example:
      'const result = await host.mcp("clinical_genomics", "open_targets_drug", {"chembl_id": "CHEMBL1201583"})',
    run: async (ctx, a) => otQuery(ctx, OT_DRUG_Q, { id: String(a.chembl_id) }, 'drug')
  }
]
