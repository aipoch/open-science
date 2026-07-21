import type { ToolContext, ToolDescriptor } from '../types'

const CBIOPORTAL = 'https://www.cbioportal.org/api'
// cBioPortal exposes no total-count in the JSON body (only in a header we can't read), so every
// "verify against the API total" is done by pulling the full collection in a single large page.
const FULL_PAGE = 10_000_000
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

// The engine surfaces a non-2xx response as `HTTP <status> for <url>`; a 404 is cBioPortal's way of
// saying the study/gene id is unknown, which we translate into a friendly "not found" error.
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

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000
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

// cBioPortal public REST API (keyless): read-only cancer-genomics studies, mutations, CNA, and
// clinical-attribute lookups. Profile/sample-list ids are never assumed — always resolved from the
// study's own /molecular-profiles and /sample-lists collections.
export const CANCER_MODELS_TOOLS: ToolDescriptor[] = [
  {
    id: 'cbioportal_list_studies',
    connector: 'cancer_models',
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
      'const result = await host.mcp("cancer_models", "cbioportal_list_studies", {"keyword": "glioma"})',
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
    connector: 'cancer_models',
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
      'const result = await host.mcp("cancer_models", "cbioportal_get_study", {"study_id": "msk_impact_2017"})',
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
    connector: 'cancer_models',
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
      'const result = await host.mcp("cancer_models", "cbioportal_mutations_in_gene", {"gene_symbol": "IDH1", "study_id": "difg_msk_2023"})',
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
    connector: 'cancer_models',
    description:
      'Mutation frequency of one gene across several cBioPortal studies (1–12): mutated-sample fraction of the sequenced cohort per study, ranked most-frequent first.',
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
      '`{ "gene": { "symbol": str, "entrez_gene_id": int }, "count": int, "frequencies": [ { "study_id": str, "study_name": str, "molecular_profile_id": str, "mutation_count": int, "mutated_samples": int, "sequenced_samples": int, "frequency": float } ], "unknown_studies": [ str ], "no_mutation_data": [ str ] }` — `frequencies` are sorted by descending `frequency` (4-dp, null when the study reports 0 sequenced samples); ids the API does not know go to `unknown_studies`, studies without a mutation profile / sample list to `no_mutation_data`. At most 12 ids are considered. Unknown gene throws "Gene not found".',
    example:
      'const result = await host.mcp("cancer_models", "cbioportal_mutation_frequency", {"gene_symbol": "KRAS", "study_ids": ["msk_impact_2017", "difg_msk_2023"]})',
    run: async (ctx, a) => {
      const symbol = String(a.gene_symbol)
      const studyIds = (Array.isArray(a.study_ids) ? a.study_ids : []).map(String).slice(0, 12)
      const gene = await resolveGene(ctx, symbol)

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
        const mutatedSamples = new Set(rows.map((m) => m.sampleId)).size
        frequencies.push({
          study_id: studyId,
          study_name: study.name,
          molecular_profile_id: profile.molecularProfileId,
          mutation_count: rows.length,
          mutated_samples: mutatedSamples,
          sequenced_samples: sequenced,
          frequency: sequenced > 0 ? round4(mutatedSamples / sequenced) : null
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
    connector: 'cancer_models',
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
      'const result = await host.mcp("cancer_models", "cbioportal_cna_in_gene", {"gene_symbol": "CDKN2A", "study_id": "msk_impact_2017"})',
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
    connector: 'cancer_models',
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
      'const result = await host.mcp("cancer_models", "cbioportal_clinical_attributes", {"study_id": "brca_tcga_pan_can_atlas_2018"})',
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
  }
]
