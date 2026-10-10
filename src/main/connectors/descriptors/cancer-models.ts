import type { ToolContext, ToolDescriptor } from '../../connector-core/types'

const CBIOPORTAL = 'https://www.cbioportal.org/api'
// cBioPortal exposes no total-count in the JSON body (only in a header we can't read), so collection
// totals are verified by walking bounded pages. FULL_PAGE remains for the older mutation/CNA paths.
const FULL_PAGE = 10_000_000
const COLLECTION_PAGE_SIZE = 1_000
const DIRECT_FETCH_BATCH_SIZE = 20
const DESC_MAX = 240
const TOP_PROTEIN_CHANGES = 25

type CBioCancerType = { id?: string; name?: string }
type CBioStudy = {
  studyId?: string
  name?: string
  description?: string
  cancerTypeId?: string
  cancerType?: CBioCancerType
  referenceGenome?: string
  pmid?: string
  citation?: string
  publicStudy?: boolean
  groups?: string
  importDate?: string
  sequencedSampleCount?: number
  cnaSampleCount?: number
  mrnaRnaSeqSampleCount?: number
  mrnaRnaSeqV2SampleCount?: number
  mrnaMicroarraySampleCount?: number
  miRnaSampleCount?: number
  methylationHm27SampleCount?: number
  rppaSampleCount?: number
  massSpectrometrySampleCount?: number
  completeSampleCount?: number
  treatmentCount?: number
  structuralVariantCount?: number
}
type CBioGene = { entrezGeneId?: number; hugoGeneSymbol?: string; type?: string }
type CBioMolecularProfile = {
  molecularProfileId?: string
  molecularAlterationType?: string
  datatype?: string
  name?: string
  description?: string
}
type CBioSampleList = {
  sampleListId?: string
  category?: string
  name?: string
  sampleCount?: number
}
type CBioIdRecord = { sampleId?: string; patientId?: string }
type CBioGenePanelData = {
  sampleId?: string
  molecularProfileId?: string
  genePanelId?: string
  profiled?: boolean
}
type CBioGenePanel = { genes?: { entrezGeneId?: number }[] }
type CBioMutation = {
  sampleId?: string
  patientId?: string
  proteinChange?: string
  mutationType?: string
  mutationStatus?: string
  chr?: string
  startPosition?: number
  endPosition?: number
  referenceAllele?: string
  variantAllele?: string
  variantType?: string
  ncbiBuild?: string
  proteinPosStart?: number
  proteinPosEnd?: number
  tumorAltCount?: number
  tumorRefCount?: number
  refseqMrnaId?: string
}
type CBioCna = { sampleId?: string; patientId?: string; alteration?: number }
type CBioClinicalAttr = {
  clinicalAttributeId?: string
  displayName?: string
  description?: string
  datatype?: string
  patientAttribute?: boolean
  priority?: string
}
type CBioSample = {
  sampleId?: string
  patientId?: string
  studyId?: string
  sampleType?: string
  sampleTypeId?: string
  cancerTypeId?: string
  uniqueSampleKey?: string
  uniquePatientKey?: string
  [key: string]: unknown
}
type CBioPatient = {
  patientId?: string
  studyId?: string
  uniquePatientKey?: string
  [key: string]: unknown
}
type CBioClinicalData = {
  clinicalAttributeId?: string
  patientId?: string
  sampleId?: string
  studyId?: string
  value?: string
  [key: string]: unknown
}
type CBioMolecularData = {
  entrezGeneId?: number
  molecularProfileId?: string
  sampleId?: string
  patientId?: string
  studyId?: string
  value?: number
  [key: string]: unknown
}

// The engine surfaces a non-2xx response as `HTTP <status> for <url>`. Keep the upstream HTTP
// failure for the newer collection/data tools; legacy tools retain their established errors.
const isNotFound = (err: unknown): boolean => err instanceof Error && /HTTP 404/.test(err.message)

async function fetchStudyRecord(ctx: ToolContext, studyId: string): Promise<CBioStudy> {
  try {
    return (await ctx.fetchJson(
      `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}?projection=DETAILED`
    )) as CBioStudy
  } catch (err) {
    if (isNotFound(err)) throw new Error(`Study not found: ${studyId}`)
    throw err
  }
}

async function resolveGene(ctx: ToolContext, symbol: string): Promise<CBioGene> {
  try {
    return (await ctx.fetchJson(`${CBIOPORTAL}/genes/${encodeURIComponent(symbol)}`)) as CBioGene
  } catch (err) {
    if (isNotFound(err)) throw new Error(`Gene not found: ${symbol}`)
    throw err
  }
}

const fetchProfiles = async (ctx: ToolContext, studyId: string): Promise<CBioMolecularProfile[]> =>
  ((await ctx.fetchJson(
    `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}/molecular-profiles`
  )) as CBioMolecularProfile[]) ?? []

const fetchSampleLists = async (ctx: ToolContext, studyId: string): Promise<CBioSampleList[]> =>
  ((await ctx.fetchJson(
    `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}/sample-lists`
  )) as CBioSampleList[]) ?? []

// Distinct alteration types a study actually carries — used to explain a "no <X> data" error.
const alterationTypes = (profiles: CBioMolecularProfile[]): string[] =>
  [...new Set(profiles.map((p) => p.molecularAlterationType).filter(Boolean))] as string[]

const pickProfile = (
  profiles: CBioMolecularProfile[],
  alterationType: string,
  datatype?: string
): CBioMolecularProfile | undefined =>
  profiles.find(
    (p) => p.molecularAlterationType === alterationType && (!datatype || p.datatype === datatype)
  )

// First sample list matching one of the preferred categories, in priority order.
const pickSampleList = (
  lists: CBioSampleList[],
  categories: string[]
): CBioSampleList | undefined => {
  for (const category of categories) {
    const match = lists.find((l) => l.category === category)
    if (match) return match
  }
  return undefined
}

// Coverage is specific to both the molecular profile and the queried gene. A profiled sample
// without a panel covers all genes; a targeted panel covers only its listed genes (cBioPortal's
// GenePanelUtils.computeGenePanelInformation uses the same distinction).
async function fetchGeneCoverage(
  ctx: ToolContext,
  profileId: string,
  sampleListId: string,
  entrezGeneId: number,
  panelCoverage: Map<string, boolean | null>
): Promise<Map<string, boolean | null>> {
  const [sampleIds, panelData] = (await Promise.all([
    ctx.fetchJson(`${CBIOPORTAL}/sample-lists/${encodeURIComponent(sampleListId)}/sample-ids`),
    ctx.postJson(
      `${CBIOPORTAL}/molecular-profiles/${encodeURIComponent(profileId)}/gene-panel-data/fetch`,
      { sampleListId }
    )
  ])) as [string[], CBioGenePanelData[]]
  if (!Array.isArray(sampleIds) || sampleIds.some((id) => typeof id !== 'string' || !id)) {
    throw new Error(`Invalid sample list: ${sampleListId}`)
  }
  const coverage = new Map<string, boolean | null>(sampleIds.map((id) => [id, null]))
  const seen = new Set<string>()
  for (const record of panelData ?? []) {
    const sampleId = record.sampleId
    if (!sampleId || !coverage.has(sampleId) || record.molecularProfileId !== profileId) continue
    let profiled: boolean | null = null
    if (record.profiled === false) {
      profiled = false
    } else if (record.profiled === true) {
      if (!record.genePanelId) {
        profiled = true
      } else {
        const panelId = record.genePanelId
        if (!panelCoverage.has(panelId)) {
          let panel: CBioGenePanel | undefined
          try {
            panel = (await ctx.fetchJson(
              `${CBIOPORTAL}/gene-panels/${encodeURIComponent(panelId)}?projection=DETAILED`
            )) as CBioGenePanel
          } catch (err) {
            if (!isNotFound(err)) throw err
          }
          panelCoverage.set(
            panelId,
            Array.isArray(panel?.genes)
              ? panel.genes.some((gene) => gene.entrezGeneId === entrezGeneId)
              : null
          )
        }
        profiled = panelCoverage.get(panelId) ?? null
      }
    }
    // Conflicting records must not make the denominator depend on response order.
    if (seen.has(sampleId) && coverage.get(sampleId) !== profiled) profiled = null
    coverage.set(sampleId, profiled)
    seen.add(sampleId)
  }
  return coverage
}

const trimDescription = (d?: string): string | undefined =>
  d && d.length > DESC_MAX ? `${d.slice(0, DESC_MAX).trimEnd()}…` : d

// Order genomic positions as chr 1..22, X, Y, MT, then anything else.
const chrOrder = (chr?: string): number => {
  if (!chr) return 100
  const n = Number.parseInt(chr, 10)
  if (Number.isFinite(n) && String(n) === chr.replace(/^chr/i, '')) return n
  const u = chr.replace(/^chr/i, '').toUpperCase()
  if (u === 'X') return 23
  if (u === 'Y') return 24
  if (u === 'M' || u === 'MT') return 25
  return 99
}

// Tally string values, returned as an object ordered by descending count (ties: alphabetical).
const countBy = (values: (string | undefined)[]): Record<string, number> => {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  )
}

// Discrete copy-number values and the labels/event-type buckets cBioPortal uses for them.
const CNA_LABEL: Record<number, string> = {
  [-2]: 'deep_deletion',
  [-1]: 'shallow_deletion',
  0: 'diploid',
  1: 'gain',
  2: 'amplification'
}
const EVENT_ALTERATIONS: Record<string, number[]> = {
  HOMDEL_AND_AMP: [-2, 2],
  HOMDEL: [-2],
  AMP: [2],
  GAIN: [1],
  HETLOSS: [-1],
  DIPLOID: [0],
  ALL: [-2, -1, 0, 1, 2]
}

const mapMutation = (m: CBioMutation): Record<string, unknown> => ({
  sample_id: m.sampleId,
  patient_id: m.patientId,
  protein_change: m.proteinChange,
  mutation_type: m.mutationType,
  mutation_status: m.mutationStatus,
  chromosome: m.chr,
  start_position: m.startPosition,
  end_position: m.endPosition,
  reference_allele: m.referenceAllele,
  variant_allele: m.variantAllele,
  variant_type: m.variantType,
  ncbi_build: m.ncbiBuild,
  protein_pos_start: m.proteinPosStart,
  protein_pos_end: m.proteinPosEnd,
  tumor_alt_count: m.tumorAltCount,
  tumor_ref_count: m.tumorRefCount,
  refseq_mrna_id: m.refseqMrnaId
})

const boundedMax = (value: unknown, fallback: number, maximum = 10_000): number => {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) ? Math.min(Math.max(0, Math.trunc(n)), maximum) : fallback
}

const normalizeIds = (value: unknown): string[] => [
  ...new Set(Array.isArray(value) ? value.map(String).filter(Boolean) : [])
]

type CBioCollectionRow = CBioSample | CBioPatient

async function walkStudyCollection<T extends CBioCollectionRow>(
  ctx: ToolContext,
  studyId: string,
  collection: 'samples' | 'patients',
  projection: 'ID' | 'DETAILED',
  onPage: (rows: T[]) => void
): Promise<number> {
  let pageNumber = 0
  let total = 0
  for (;;) {
    const rows =
      ((await ctx.fetchJson(
        `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}/${collection}?projection=${projection}&pageSize=${COLLECTION_PAGE_SIZE}&pageNumber=${pageNumber}`
      )) as T[]) ?? []
    total += rows.length
    onPage(rows)
    if (rows.length < COLLECTION_PAGE_SIZE) return total
    pageNumber += 1
  }
}

async function fetchStudyEntity<T extends CBioCollectionRow>(
  ctx: ToolContext,
  studyId: string,
  collection: 'samples' | 'patients',
  id: string
): Promise<T | undefined> {
  try {
    return (await ctx.fetchJson(
      `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}/${collection}/${encodeURIComponent(id)}?projection=DETAILED`
    )) as T
  } catch (err) {
    // A missing requested entity is equivalent to the existing client-side filter behavior; the
    // study itself was already validated by walkStudyCollection.
    if (isNotFound(err)) return undefined
    throw err
  }
}

function keepSmallestById<T extends CBioCollectionRow>(
  target: T[],
  rows: T[],
  key: 'sampleId' | 'patientId',
  maxRecords: number
): void {
  if (maxRecords <= 0) return
  for (const row of rows) {
    const id = String(row[key] ?? '')
    if (!id) continue
    let low = 0
    let high = target.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (String(target[middle][key] ?? '').localeCompare(id) <= 0) low = middle + 1
      else high = middle
    }
    if (low >= maxRecords && target.length >= maxRecords) continue
    target.splice(low, 0, row)
    if (target.length > maxRecords) target.pop()
  }
}

// cBioPortal public REST API (keyless): read-only cancer-genomics studies, mutations, CNA, and
// clinical-attribute lookups. Profile/sample-list ids are never assumed — always resolved from the
// study's own /molecular-profiles and /sample-lists collections.
export const CANCER_MODELS_TOOLS: ToolDescriptor[] = [
  {
    id: 'cbioportal_list_studies',
    connector: 'cancer-models',
    description:
      'List cBioPortal cancer studies, optionally filtered by a free-text keyword (name/description/cancer type) and/or an exact cancer-type id; returns study id, name, cancer type, reference genome, citation, and per-data-type sample counts.',
    input: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Free-text match on name/description/cancer type' },
        cancer_type_id: {
          type: 'string',
          description: 'Exact cancer-type id filter (client-side), e.g. brca, difg'
        },
        max_records: { type: 'integer', default: 500 }
      }
    },
    returns:
      '`{ "keyword": str|null, "cancer_type_id": str|null, "api_total_for_keyword": int, "count": int, "truncated": bool, "studies": [ { "study_id": str, "name": str, "description": str, "cancer_type_id": str, "cancer_type": str, "reference_genome": str, "pmid": str, "citation": str, "sequenced_sample_count": int, "cna_sample_count": int, "structural_variant_count": int } ] }` — `api_total_for_keyword` is every study the keyword matched (before the `cancer_type_id` filter); `count` is after it; `studies` are sorted by `study_id`, capped at `max_records` (default 500), and `truncated` is true when `count` exceeds the cap.',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_list_studies", {"keyword": "glioma"})',
    run: async (ctx, a) => {
      const keyword = a.keyword != null ? String(a.keyword) : undefined
      const cancerTypeId = a.cancer_type_id != null ? String(a.cancer_type_id) : undefined
      const maxRecords = Number(a.max_records ?? 500)

      let url = `${CBIOPORTAL}/studies?projection=DETAILED&pageSize=${FULL_PAGE}&pageNumber=0`
      if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`
      const matched = ((await ctx.fetchJson(url)) as CBioStudy[]) ?? []

      const filtered = cancerTypeId
        ? matched.filter((s) => s.cancerTypeId === cancerTypeId)
        : matched
      const sorted = filtered
        .slice()
        .sort((x, y) => (x.studyId ?? '').localeCompare(y.studyId ?? ''))

      return {
        keyword: keyword ?? null,
        cancer_type_id: cancerTypeId ?? null,
        api_total_for_keyword: matched.length,
        count: filtered.length,
        truncated: filtered.length > maxRecords,
        studies: sorted.slice(0, maxRecords).map((s) => ({
          study_id: s.studyId,
          name: s.name,
          description: trimDescription(s.description),
          cancer_type_id: s.cancerTypeId,
          cancer_type: s.cancerType?.name,
          reference_genome: s.referenceGenome,
          pmid: s.pmid,
          citation: s.citation,
          sequenced_sample_count: s.sequencedSampleCount,
          cna_sample_count: s.cnaSampleCount,
          structural_variant_count: s.structuralVariantCount
        }))
      }
    }
  },
  {
    id: 'cbioportal_get_study',
    connector: 'cancer-models',
    description:
      'Get a cBioPortal cancer study by id: metadata, per-data-type sample counts, true sample/patient counts (from the study collections, not the display field), and its molecular profiles.',
    input: {
      type: 'object',
      properties: { study_id: { type: 'string' } },
      required: ['study_id']
    },
    required: ['study_id'],
    returns:
      '`{ "study_id": str, "name": str, "description": str, "cancer_type": str, "cancer_type_id": str, "reference_genome": str, "pmid": str, "citation": str, "public": bool, "groups": str, "import_date": str, "sample_count": int, "patient_count": int, "sequenced_sample_count": int, "cna_sample_count": int, "mrna_rnaseq_v2_sample_count": int, "rppa_sample_count": int, "structural_variant_count": int, "treatment_count": int, ..., "molecular_profiles": [ { "molecular_profile_id": str, "alteration_type": str, "datatype": str, "name": str, "description": str } ] }` — `sample_count`/`patient_count` are the real collection sizes; `molecular_profiles` are sorted by id. Unknown study id throws "Study not found".',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_get_study", {"study_id": "msk_impact_2017"})',
    run: async (ctx, a) => {
      const studyId = String(a.study_id)
      const study = await fetchStudyRecord(ctx, studyId)
      const [profiles, samples, patients] = await Promise.all([
        fetchProfiles(ctx, studyId),
        ctx.fetchJson(
          `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}/samples?projection=ID`
        ) as Promise<CBioIdRecord[]>,
        ctx.fetchJson(
          `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}/patients?projection=ID`
        ) as Promise<CBioIdRecord[]>
      ])

      return {
        study_id: study.studyId,
        name: study.name,
        description: study.description,
        cancer_type: study.cancerType?.name,
        cancer_type_id: study.cancerTypeId,
        reference_genome: study.referenceGenome,
        pmid: study.pmid,
        citation: study.citation,
        public: study.publicStudy,
        groups: study.groups,
        import_date: study.importDate,
        sample_count: (samples ?? []).length,
        patient_count: (patients ?? []).length,
        sequenced_sample_count: study.sequencedSampleCount,
        cna_sample_count: study.cnaSampleCount,
        mrna_rnaseq_sample_count: study.mrnaRnaSeqSampleCount,
        mrna_rnaseq_v2_sample_count: study.mrnaRnaSeqV2SampleCount,
        mrna_microarray_sample_count: study.mrnaMicroarraySampleCount,
        mirna_sample_count: study.miRnaSampleCount,
        methylation_hm27_sample_count: study.methylationHm27SampleCount,
        rppa_sample_count: study.rppaSampleCount,
        mass_spectrometry_sample_count: study.massSpectrometrySampleCount,
        complete_sample_count: study.completeSampleCount,
        treatment_count: study.treatmentCount,
        structural_variant_count: study.structuralVariantCount,
        molecular_profiles: (profiles ?? [])
          .slice()
          .sort((x, y) => (x.molecularProfileId ?? '').localeCompare(y.molecularProfileId ?? ''))
          .map((p) => ({
            molecular_profile_id: p.molecularProfileId,
            alteration_type: p.molecularAlterationType,
            datatype: p.datatype,
            name: p.name,
            description: p.description
          }))
      }
    }
  },
  {
    id: 'cbioportal_mutations_in_gene',
    connector: 'cancer-models',
    description:
      'All mutations of one gene (HUGO symbol) in a cBioPortal study, with recurrence aggregates: total mutations, mutated-sample count, mutation-type and protein-change distributions, and the most recurrent protein changes.',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string', description: 'HUGO gene symbol, e.g. KRAS, IDH1' },
        study_id: { type: 'string' },
        max_records: { type: 'integer', default: 100 }
      },
      required: ['gene_symbol', 'study_id']
    },
    required: ['gene_symbol', 'study_id'],
    returns:
      '`{ "gene": { "symbol": str, "entrez_gene_id": int }, "study_id": str, "molecular_profile_id": str, "total_mutations": int, "mutated_sample_count": int, "mutation_type_counts": { str: int }, "distinct_protein_changes": int, "top_protein_changes": { str: int }, "truncated": bool, "mutations": [ { "sample_id": str, "patient_id": str, "protein_change": str, "mutation_type": str, "mutation_status": str, "chromosome": str, "start_position": int, "end_position": int, "reference_allele": str, "variant_allele": str, "variant_type": str, "ncbi_build": str, "protein_pos_start": int, "protein_pos_end": int, "tumor_alt_count": int, "tumor_ref_count": int, "refseq_mrna_id": str } ] }` — aggregates cover every mutation; `mutations` are sorted by genomic position and capped at `max_records` (default 100), with `truncated` set when they exceed it. `top_protein_changes` holds the 25 most recurrent. Unknown gene throws "Gene not found"; a study without mutation data throws, listing the alteration types it does have.',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_mutations_in_gene", {"gene_symbol": "IDH1", "study_id": "difg_msk_2023"})',
    run: async (ctx, a) => {
      const symbol = String(a.gene_symbol)
      const studyId = String(a.study_id)
      const maxRecords = Number(a.max_records ?? 100)

      const gene = await resolveGene(ctx, symbol)
      const profiles = await fetchProfiles(ctx, studyId)
      const profile = pickProfile(profiles, 'MUTATION_EXTENDED')
      if (!profile?.molecularProfileId) {
        throw new Error(
          `Study ${studyId} has no mutation data. Available alteration types: ${
            alterationTypes(profiles).join(', ') || 'none'
          }`
        )
      }
      const lists = await fetchSampleLists(ctx, studyId)
      const sampleList = pickSampleList(lists, [
        'all_cases_with_mutation_data',
        'all_cases_in_study'
      ])
      if (!sampleList?.sampleListId) throw new Error(`Study ${studyId} has no usable sample list`)

      const rows =
        ((await ctx.fetchJson(
          `${CBIOPORTAL}/molecular-profiles/${encodeURIComponent(profile.molecularProfileId)}/mutations` +
            `?sampleListId=${encodeURIComponent(sampleList.sampleListId)}` +
            `&entrezGeneId=${gene.entrezGeneId}&projection=DETAILED&pageSize=${FULL_PAGE}&pageNumber=0`
        )) as CBioMutation[]) ?? []

      const sorted = rows
        .slice()
        .sort(
          (x, y) =>
            chrOrder(x.chr) - chrOrder(y.chr) || (x.startPosition ?? 0) - (y.startPosition ?? 0)
        )
      const proteinCounts = countBy(rows.map((m) => m.proteinChange))

      return {
        gene: { symbol: gene.hugoGeneSymbol, entrez_gene_id: gene.entrezGeneId },
        study_id: studyId,
        molecular_profile_id: profile.molecularProfileId,
        total_mutations: rows.length,
        mutated_sample_count: new Set(rows.map((m) => m.sampleId)).size,
        mutation_type_counts: countBy(rows.map((m) => m.mutationType)),
        distinct_protein_changes: Object.keys(proteinCounts).length,
        top_protein_changes: Object.fromEntries(
          Object.entries(proteinCounts).slice(0, TOP_PROTEIN_CHANGES)
        ),
        truncated: rows.length > maxRecords,
        mutations: sorted.slice(0, maxRecords).map(mapMutation)
      }
    }
  },
  {
    id: 'cbioportal_mutation_frequency',
    connector: 'cancer-models',
    description:
      'Mutation frequency of one gene across several cBioPortal studies (1–12): unique mutated samples divided by samples profiled for that gene in the selected mutation profile and sample list, accounting for targeted gene panels; ranked most-frequent first.',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string', description: 'HUGO gene symbol, e.g. KRAS, IDH1' },
        study_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 }
      },
      required: ['gene_symbol', 'study_ids']
    },
    required: ['gene_symbol', 'study_ids'],
    returns:
      '`{ "gene": { "symbol": str, "entrez_gene_id": int }, "count": int, "frequencies": [ { "study_id": str, "study_name": str, "molecular_profile_id": str, "sample_list_id": str, "mutation_count": int, "mutated_samples": int, "sequenced_samples": int, "cohort_samples": int, "profiled_samples": int, "not_profiled_samples": int, "unknown_profile_samples": int, "frequency": float | null, "frequency_status": str } ], "unknown_studies": [ str ], "no_mutation_data": [ str ] }` — `frequency` is an unrounded fraction (0–1), sorted descending with null last. `profiled_samples` is the gene-specific denominator; `cohort_samples` equals profiled + not_profiled + unknown_profile samples in the selected list. `sequenced_samples` is study metadata, not the denominator. `mutation_count` counts returned mutation records and `mutated_samples` counts their unique sample ids, without additional mutation-type filtering. `frequency_status` is `available`, `no_profiled_samples`, `incomplete_coverage`, or `inconsistent_mutation_data` (a mutation lacks a sample id or falls outside the known gene-profiled samples); only `available` has a numeric frequency. Zero means profiled samples with no reported mutation, not an untested gene. Unknown study ids go to `unknown_studies`, studies without a mutation profile / sample list to `no_mutation_data`. At most 12 ids are considered. Unknown gene throws "Gene not found".',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_mutation_frequency", {"gene_symbol": "KRAS", "study_ids": ["msk_impact_2017", "difg_msk_2023"]})',
    run: async (ctx, a) => {
      const symbol = String(a.gene_symbol)
      const studyIds = (Array.isArray(a.study_ids) ? a.study_ids : []).map(String).slice(0, 12)
      const gene = await resolveGene(ctx, symbol)
      if (!Number.isInteger(gene.entrezGeneId)) throw new Error(`Missing gene id: ${symbol}`)
      const panelCoverage = new Map<string, boolean | null>()

      const frequencies: Record<string, unknown>[] = []
      const unknownStudies: string[] = []
      const noMutationData: string[] = []

      for (const studyId of studyIds) {
        let study: CBioStudy
        try {
          study = await fetchStudyRecord(ctx, studyId)
        } catch (err) {
          // fetchStudyRecord maps a 404 to a "Study not found" message — treat either as unknown.
          if (err instanceof Error && /HTTP 404|Study not found/.test(err.message)) {
            unknownStudies.push(studyId)
            continue
          }
          throw err
        }
        const profiles = await fetchProfiles(ctx, studyId)
        const profile = pickProfile(profiles, 'MUTATION_EXTENDED')
        if (!profile?.molecularProfileId) {
          noMutationData.push(studyId)
          continue
        }
        const lists = await fetchSampleLists(ctx, studyId)
        const sampleList = pickSampleList(lists, [
          'all_cases_with_mutation_data',
          'all_cases_in_study'
        ])
        if (!sampleList?.sampleListId) {
          noMutationData.push(studyId)
          continue
        }

        const rows =
          ((await ctx.fetchJson(
            `${CBIOPORTAL}/molecular-profiles/${encodeURIComponent(profile.molecularProfileId)}/mutations` +
              `?sampleListId=${encodeURIComponent(sampleList.sampleListId)}` +
              `&entrezGeneId=${gene.entrezGeneId}&projection=DETAILED&pageSize=${FULL_PAGE}&pageNumber=0`
          )) as CBioMutation[]) ?? []
        const sequenced = study.sequencedSampleCount ?? 0
        const coverage = await fetchGeneCoverage(
          ctx,
          profile.molecularProfileId,
          sampleList.sampleListId,
          gene.entrezGeneId!,
          panelCoverage
        )
        const profiledSamples = [...coverage.values()].filter(
          (profiled) => profiled === true
        ).length
        const notProfiledSamples = [...coverage.values()].filter(
          (profiled) => profiled === false
        ).length
        const unknownProfileSamples = coverage.size - profiledSamples - notProfiledSamples
        const mutatedSamples = new Set(rows.map((m) => m.sampleId).filter(Boolean)).size
        const inconsistentMutations = rows.some(
          (m) => !m.sampleId || coverage.get(m.sampleId) !== true
        )
        const frequencyStatus =
          unknownProfileSamples > 0
            ? 'incomplete_coverage'
            : inconsistentMutations
              ? 'inconsistent_mutation_data'
              : profiledSamples === 0
                ? 'no_profiled_samples'
                : 'available'
        frequencies.push({
          study_id: studyId,
          study_name: study.name,
          molecular_profile_id: profile.molecularProfileId,
          sample_list_id: sampleList.sampleListId,
          mutation_count: rows.length,
          mutated_samples: mutatedSamples,
          sequenced_samples: sequenced,
          cohort_samples: coverage.size,
          profiled_samples: profiledSamples,
          not_profiled_samples: notProfiledSamples,
          unknown_profile_samples: unknownProfileSamples,
          frequency: frequencyStatus === 'available' ? mutatedSamples / profiledSamples : null,
          frequency_status: frequencyStatus
        })
      }

      frequencies.sort((x, y) => {
        const fx = x.frequency as number | null
        const fy = y.frequency as number | null
        if (fx === fy) return (x.study_id as string).localeCompare(y.study_id as string)
        if (fx == null) return 1
        if (fy == null) return -1
        return fy - fx
      })

      return {
        gene: { symbol: gene.hugoGeneSymbol, entrez_gene_id: gene.entrezGeneId },
        count: frequencies.length,
        frequencies,
        unknown_studies: unknownStudies,
        no_mutation_data: noMutationData
      }
    }
  },
  {
    id: 'cbioportal_cna_in_gene',
    connector: 'cancer-models',
    description:
      'Discrete copy-number alterations of one gene in a cBioPortal study, filtered by event type (deep deletion / amplification by default), with the full per-sample alteration distribution.',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string', description: 'HUGO gene symbol, e.g. KRAS, IDH1' },
        study_id: { type: 'string' },
        event_type: {
          type: 'string',
          enum: ['HOMDEL_AND_AMP', 'HOMDEL', 'AMP', 'GAIN', 'HETLOSS', 'DIPLOID', 'ALL'],
          default: 'HOMDEL_AND_AMP'
        },
        max_records: { type: 'integer', default: 100 }
      },
      required: ['gene_symbol', 'study_id']
    },
    required: ['gene_symbol', 'study_id'],
    returns:
      '`{ "gene": { "symbol": str, "entrez_gene_id": int }, "study_id": str, "molecular_profile_id": str, "event_type": str, "total_events": int, "altered_sample_count": int, "alteration_counts": { str: int }, "truncated": bool, "events": [ { "sample_id": str, "patient_id": str, "alteration": int, "alteration_label": str } ] }` — `alteration_counts` is the complete per-label distribution over the gene (deep_deletion/shallow_deletion/diploid/gain/amplification); `total_events`/`events` cover only rows matching `event_type` (default HOMDEL_AND_AMP), sorted by sample id and capped at `max_records`. Unknown gene throws "Gene not found"; a study without discrete CNA throws, listing its alteration types.',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_cna_in_gene", {"gene_symbol": "CDKN2A", "study_id": "msk_impact_2017"})',
    run: async (ctx, a) => {
      const symbol = String(a.gene_symbol)
      const studyId = String(a.study_id)
      const eventType = String(a.event_type ?? 'HOMDEL_AND_AMP')
      const maxRecords = Number(a.max_records ?? 100)
      const wanted = new Set(EVENT_ALTERATIONS[eventType] ?? EVENT_ALTERATIONS.HOMDEL_AND_AMP)

      const gene = await resolveGene(ctx, symbol)
      const profiles = await fetchProfiles(ctx, studyId)
      const profile = pickProfile(profiles, 'COPY_NUMBER_ALTERATION', 'DISCRETE')
      if (!profile?.molecularProfileId) {
        throw new Error(
          `Study ${studyId} has no discrete copy-number data. Available alteration types: ${
            alterationTypes(profiles).join(', ') || 'none'
          }`
        )
      }
      const lists = await fetchSampleLists(ctx, studyId)
      const sampleList = pickSampleList(lists, ['all_cases_with_cna_data', 'all_cases_in_study'])
      if (!sampleList?.sampleListId) throw new Error(`Study ${studyId} has no usable sample list`)

      // GET discrete-copy-number ignores the gene filter, so fetch the gene's full per-sample vector
      // via the POST /fetch endpoint (read-only) and bucket it client-side by event type.
      const rows =
        ((await ctx.postJson(
          `${CBIOPORTAL}/molecular-profiles/${encodeURIComponent(profile.molecularProfileId)}/discrete-copy-number/fetch` +
            `?discreteCopyNumberEventType=ALL&projection=DETAILED`,
          { sampleListId: sampleList.sampleListId, entrezGeneIds: [gene.entrezGeneId] }
        )) as CBioCna[]) ?? []

      const alterationCounts = countBy(
        rows.map((r) => (r.alteration != null ? CNA_LABEL[r.alteration] : undefined))
      )
      const matching = rows
        .filter((r) => r.alteration != null && wanted.has(r.alteration))
        .sort((x, y) => (x.sampleId ?? '').localeCompare(y.sampleId ?? ''))

      return {
        gene: { symbol: gene.hugoGeneSymbol, entrez_gene_id: gene.entrezGeneId },
        study_id: studyId,
        molecular_profile_id: profile.molecularProfileId,
        event_type: eventType,
        total_events: matching.length,
        altered_sample_count: new Set(matching.map((r) => r.sampleId)).size,
        alteration_counts: alterationCounts,
        truncated: matching.length > maxRecords,
        events: matching.slice(0, maxRecords).map((r) => ({
          sample_id: r.sampleId,
          patient_id: r.patientId,
          alteration: r.alteration,
          alteration_label: r.alteration != null ? CNA_LABEL[r.alteration] : undefined
        }))
      }
    }
  },
  {
    id: 'cbioportal_clinical_attributes',
    connector: 'cancer-models',
    description:
      'Clinical attributes defined in a cBioPortal study (patient- and sample-level fields), highlighting survival endpoints and whether overall-survival data is present.',
    input: {
      type: 'object',
      properties: {
        study_id: { type: 'string' },
        max_records: { type: 'integer', default: 200 }
      },
      required: ['study_id']
    },
    required: ['study_id'],
    returns:
      '`{ "study_id": str, "total_attributes": int, "patient_level_count": int, "sample_level_count": int, "survival_attributes": [ str ], "has_overall_survival": bool, "truncated": bool, "attributes": [ { "attribute_id": str, "display_name": str, "description": str, "datatype": "STRING"|"NUMBER", "level": "patient"|"sample", "priority": int } ] }` — `survival_attributes` are every OS_/DFS_/PFS_/DSS_ attribute id; `has_overall_survival` is true when both OS_STATUS and OS_MONTHS exist; `attributes` are sorted by id and capped at `max_records` (default 200).',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_clinical_attributes", {"study_id": "brca_tcga_pan_can_atlas_2018"})',
    run: async (ctx, a) => {
      const studyId = String(a.study_id)
      const maxRecords = Number(a.max_records ?? 200)

      let raw: CBioClinicalAttr[]
      try {
        raw =
          ((await ctx.fetchJson(
            `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}/clinical-attributes`
          )) as CBioClinicalAttr[]) ?? []
      } catch (err) {
        if (isNotFound(err)) throw new Error(`Study not found: ${studyId}`)
        throw err
      }

      const ids = new Set(raw.map((r) => r.clinicalAttributeId))
      const survivalAttributes = [...ids]
        .filter((id): id is string => !!id && /^(OS|DFS|PFS|DSS)_/.test(id))
        .sort((x, y) => x.localeCompare(y))
      const attributes = raw
        .slice()
        .sort((x, y) => (x.clinicalAttributeId ?? '').localeCompare(y.clinicalAttributeId ?? ''))
        .map((r) => ({
          attribute_id: r.clinicalAttributeId,
          display_name: r.displayName,
          description: r.description,
          datatype: r.datatype,
          level: r.patientAttribute ? 'patient' : 'sample',
          priority: r.priority != null ? Number(r.priority) : undefined
        }))

      return {
        study_id: studyId,
        total_attributes: raw.length,
        patient_level_count: raw.filter((r) => r.patientAttribute).length,
        sample_level_count: raw.filter((r) => !r.patientAttribute).length,
        survival_attributes: survivalAttributes,
        has_overall_survival: ids.has('OS_STATUS') && ids.has('OS_MONTHS'),
        truncated: raw.length > maxRecords,
        attributes: attributes.slice(0, maxRecords)
      }
    }
  },
  {
    id: 'cbioportal_get_samples',
    connector: 'cancer-models',
    description:
      'List cBioPortal samples in a study with detailed sample and patient identifiers. Optional sample_ids restrict the returned rows; max_records caps the response while preserving the true study count.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        study_id: { type: 'string', minLength: 1, pattern: '\\S' },
        sample_ids: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          minItems: 1,
          maxItems: 1000
        },
        max_records: { type: 'integer', minimum: 1, maximum: 10000, default: 500 }
      },
      required: ['study_id']
    },
    required: ['study_id'],
    returns:
      '`{ study_id, total, n_returned, truncated, samples: [{ sample_id, patient_id, study_id, ... }] }` — `total` is the complete study sample count before optional filtering and the output cap.',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_get_samples", {"study_id": "brca_tcga_pan_can_atlas_2018", "max_records": 100})',
    run: async (ctx, a) => {
      const studyId = String(a.study_id)
      const requested = normalizeIds(a.sample_ids)
      const maxRecords = boundedMax(a.max_records, 500)
      const samples: CBioSample[] = []
      let filteredTotal = 0
      const total = await walkStudyCollection<CBioSample>(
        ctx,
        studyId,
        'samples',
        requested.length ? 'ID' : 'DETAILED',
        (rows) => {
          if (!requested.length) keepSmallestById(samples, rows, 'sampleId', maxRecords)
        }
      )
      if (requested.length) {
        for (let start = 0; start < requested.length; start += DIRECT_FETCH_BATCH_SIZE) {
          const batch = await Promise.all(
            requested
              .slice(start, start + DIRECT_FETCH_BATCH_SIZE)
              .map((id) => fetchStudyEntity<CBioSample>(ctx, studyId, 'samples', id))
          )
          const found = batch.filter((sample): sample is CBioSample => sample !== undefined)
          filteredTotal += found.length
          keepSmallestById(samples, found, 'sampleId', maxRecords)
        }
      }
      return {
        study_id: studyId,
        total,
        filtered_total: requested.length ? filteredTotal : total,
        n_returned: Math.min(samples.length, maxRecords),
        truncated: (requested.length ? filteredTotal : total) > maxRecords,
        samples: samples.map((sample) => ({
          ...sample,
          sample_id: sample.sampleId,
          patient_id: sample.patientId,
          study_id: sample.studyId ?? studyId
        }))
      }
    }
  },
  {
    id: 'cbioportal_get_patients',
    connector: 'cancer-models',
    description:
      'List cBioPortal patients in a study with detailed identifiers. Optional patient_ids restrict the returned rows; max_records caps the response while preserving the true study count.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        study_id: { type: 'string', minLength: 1, pattern: '\\S' },
        patient_ids: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          minItems: 1,
          maxItems: 1000
        },
        max_records: { type: 'integer', minimum: 1, maximum: 10000, default: 500 }
      },
      required: ['study_id']
    },
    required: ['study_id'],
    returns:
      '`{ study_id, total, n_returned, truncated, patients: [{ patient_id, study_id, ... }] }` — `total` is the complete study patient count before optional filtering and the output cap.',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_get_patients", {"study_id": "brca_tcga_pan_can_atlas_2018", "max_records": 100})',
    run: async (ctx, a) => {
      const studyId = String(a.study_id)
      const requested = normalizeIds(a.patient_ids)
      const maxRecords = boundedMax(a.max_records, 500)
      const patients: CBioPatient[] = []
      let filteredTotal = 0
      const total = await walkStudyCollection<CBioPatient>(
        ctx,
        studyId,
        'patients',
        requested.length ? 'ID' : 'DETAILED',
        (rows) => {
          if (!requested.length) keepSmallestById(patients, rows, 'patientId', maxRecords)
        }
      )
      if (requested.length) {
        for (let start = 0; start < requested.length; start += DIRECT_FETCH_BATCH_SIZE) {
          const batch = await Promise.all(
            requested
              .slice(start, start + DIRECT_FETCH_BATCH_SIZE)
              .map((id) => fetchStudyEntity<CBioPatient>(ctx, studyId, 'patients', id))
          )
          const found = batch.filter((patient): patient is CBioPatient => patient !== undefined)
          filteredTotal += found.length
          keepSmallestById(patients, found, 'patientId', maxRecords)
        }
      }
      return {
        study_id: studyId,
        total,
        filtered_total: requested.length ? filteredTotal : total,
        n_returned: Math.min(patients.length, maxRecords),
        truncated: (requested.length ? filteredTotal : total) > maxRecords,
        patients: patients.map((patient) => ({
          ...patient,
          patient_id: patient.patientId,
          study_id: patient.studyId ?? studyId
        }))
      }
    }
  },
  {
    id: 'cbioportal_get_clinical_data',
    connector: 'cancer-models',
    description:
      'Fetch cBioPortal clinical data values for explicit patient_ids or sample_ids matching level, optionally restricted to attribute_ids. Clinical values remain strings, including missing-value markers.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        study_id: { type: 'string', minLength: 1, pattern: '\\S' },
        level: { type: 'string', enum: ['SAMPLE', 'PATIENT'], default: 'SAMPLE' },
        attribute_ids: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          maxItems: 1000
        },
        sample_ids: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          minItems: 1,
          maxItems: 1000
        },
        patient_ids: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          minItems: 1,
          maxItems: 1000
        },
        max_records: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 }
      },
      required: ['study_id']
    },
    required: ['study_id'],
    returns:
      '`{ study_id, level, total, n_returned, truncated, clinical_data: [{ clinical_attribute_id, patient_id, sample_id, value, ... }] }`.',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_get_clinical_data", {"study_id": "brca_tcga_pan_can_atlas_2018", "level": "PATIENT", "attribute_ids": ["AGE"], "patient_ids": ["TCGA-A1-A0SB"]})',
    run: async (ctx, a) => {
      const studyId = String(a.study_id)
      const level = String(a.level ?? 'SAMPLE') === 'PATIENT' ? 'PATIENT' : 'SAMPLE'
      const sampleIds = normalizeIds(a.sample_ids)
      const patientIds = normalizeIds(a.patient_ids)
      if ((level === 'PATIENT' && sampleIds.length) || (level === 'SAMPLE' && patientIds.length))
        throw new Error('Entity IDs must match the clinical data level')
      const attributeIds = normalizeIds(a.attribute_ids)
      const ids = level === 'PATIENT' ? patientIds : sampleIds
      if (!ids.length) throw new Error('Provide patient_ids or sample_ids matching level')
      const body: Record<string, unknown> = {}
      if (attributeIds.length) body.attributeIds = attributeIds
      if (ids.length) body.ids = ids
      const raw =
        ((await ctx.postJson(
          `${CBIOPORTAL}/studies/${encodeURIComponent(studyId)}/clinical-data/fetch?clinicalDataType=${level}&projection=DETAILED`,
          body
        )) as CBioClinicalData[]) ?? []
      const maxRecords = boundedMax(a.max_records, 1000)
      const rows = raw
        .slice()
        .sort(
          (x, y) =>
            (x.clinicalAttributeId ?? '').localeCompare(y.clinicalAttributeId ?? '') ||
            (x.patientId ?? '').localeCompare(y.patientId ?? '') ||
            (x.sampleId ?? '').localeCompare(y.sampleId ?? '')
        )
      return {
        study_id: studyId,
        level,
        total: rows.length,
        n_returned: Math.min(rows.length, maxRecords),
        truncated: rows.length > maxRecords,
        clinical_data: rows.slice(0, maxRecords).map((row) => ({
          ...row,
          clinical_attribute_id: row.clinicalAttributeId,
          patient_id: row.patientId,
          sample_id: row.sampleId,
          study_id: row.studyId ?? studyId
        }))
      }
    }
  },
  {
    id: 'cbioportal_get_molecular_data',
    connector: 'cancer-models',
    description:
      'Fetch numeric mRNA or protein expression values from an explicit study molecular profile. Discover profiles with cbioportal_get_study; choose the measurement/normalization deliberately. Supply gene_symbol or entrez_gene_ids and exactly one of sample_ids or sample_list_id. Missing rows are not zero expression.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        study_id: { type: 'string', minLength: 1, pattern: '\\S' },
        molecular_profile_id: { type: 'string', minLength: 1, pattern: '\\S' },
        gene_symbol: { type: 'string', description: 'HUGO symbol, e.g. TP53' },
        entrez_gene_ids: { type: 'array', items: { type: 'integer' }, maxItems: 1000 },
        sample_ids: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          minItems: 1,
          maxItems: 1000
        },
        sample_list_id: { type: 'string', minLength: 1, pattern: '\\S' },
        max_records: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 }
      },
      required: ['study_id', 'molecular_profile_id']
    },
    required: ['study_id', 'molecular_profile_id'],
    returns:
      '`{ study_id, molecular_profile_id, gene_ids, total, n_returned, truncated, molecular_data: [{ entrez_gene_id, sample_id, patient_id, value, ... }] }` — profile metadata describes the measurement and normalization; values are preserved without conversion.',
    example:
      'const result = await host.mcp("cancer-models", "cbioportal_get_molecular_data", {"study_id": "brca_tcga_pan_can_atlas_2018", "molecular_profile_id": "brca_tcga_pan_can_atlas_2018_rna_seq_v2_mrna", "gene_symbol": "ESR1", "sample_list_id": "brca_tcga_pan_can_atlas_2018_all"})',
    run: async (ctx, a) => {
      const studyId = String(a.study_id)
      const sampleIds = normalizeIds(a.sample_ids)
      if (sampleIds.length > 0 === Boolean(a.sample_list_id))
        throw new Error("provide exactly one of 'sample_ids' or 'sample_list_id'")
      const geneIds = normalizeIds(a.entrez_gene_ids)
        .map(Number)
        .filter((id) => Number.isInteger(id))
      if (a.gene_symbol != null && String(a.gene_symbol).trim()) {
        const gene = await resolveGene(ctx, String(a.gene_symbol).trim())
        if (!Number.isInteger(gene.entrezGeneId))
          throw new Error(`Missing gene id: ${a.gene_symbol}`)
        geneIds.push(gene.entrezGeneId!)
      }
      const uniqueGeneIds = [...new Set(geneIds)]
      if (!uniqueGeneIds.length) throw new Error("provide 'gene_symbol' or 'entrez_gene_ids'")
      const profileId = String(a.molecular_profile_id)
      const profiles = await fetchProfiles(ctx, studyId)
      const profile = profiles.find((p) => p.molecularProfileId === profileId)
      if (
        !profile ||
        !['MRNA_EXPRESSION', 'PROTEIN_LEVEL'].includes(profile.molecularAlterationType ?? '')
      )
        throw new Error(`Expression profile ${profileId} not found in study ${studyId}`)
      if (a.sample_list_id != null) {
        const lists = await fetchSampleLists(ctx, studyId)
        if (!lists.some((list) => list.sampleListId === a.sample_list_id))
          throw new Error(`Sample list not found in study ${studyId}: ${a.sample_list_id}`)
      }
      const body: Record<string, unknown> = { entrezGeneIds: uniqueGeneIds }
      if (sampleIds.length) body.sampleIds = sampleIds
      else if (a.sample_list_id != null && String(a.sample_list_id))
        body.sampleListId = String(a.sample_list_id)
      const raw =
        ((await ctx.postJson(
          `${CBIOPORTAL}/molecular-profiles/${encodeURIComponent(profileId)}/molecular-data/fetch?projection=DETAILED`,
          body
        )) as CBioMolecularData[]) ?? []
      const maxRecords = boundedMax(a.max_records, 1000)
      const rows = raw
        .slice()
        .sort(
          (x, y) =>
            (x.entrezGeneId ?? 0) - (y.entrezGeneId ?? 0) ||
            (x.sampleId ?? '').localeCompare(y.sampleId ?? '')
        )
      return {
        study_id: studyId,
        molecular_profile_id: profileId,
        gene_ids: uniqueGeneIds,
        profile,
        total: rows.length,
        n_returned: Math.min(rows.length, maxRecords),
        truncated: rows.length > maxRecords,
        molecular_data: rows.slice(0, maxRecords).map((row) => ({
          ...row,
          entrez_gene_id: row.entrezGeneId,
          molecular_profile_id: row.molecularProfileId ?? profileId,
          sample_id: row.sampleId,
          patient_id: row.patientId,
          study_id: row.studyId ?? studyId,
          value: row.value
        }))
      }
    }
  }
]
