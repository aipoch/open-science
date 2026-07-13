import type { ToolDescriptor } from '../types'

const OPEN_TARGETS_API = 'https://api.platform.opentargets.org/api/v4/graphql'
// Top disease/indication rows can run into the hundreds — bound the response like gnomad's
// variant limit, rather than returning every row unbounded.
const DEFAULT_LIMIT = 10

// Resolves a free-text gene symbol to an Ensembl target id via the platform's cross-entity
// search (transcribed from the upstream open_targets_graphql docstring example query shape).
const SEARCH_TARGET_QUERY = `
query SearchTarget($q: String!) {
  search(queryString: $q, entityNames: ["target"]) {
    hits { id entity name }
  }
}
`

// Transcribed from the upstream mcp_clinical_genomics open_targets_graphql docstring example
// (target(ensemblId:$id){approvedSymbol associatedDiseases{count}}), extended with the disease
// rows/score fields symmetric to the upstream open_targets_disease_targets query.
const TARGET_DISEASES_QUERY = `
query TargetDiseases($ensemblId: String!, $size: Int!) {
  target(ensemblId: $ensemblId) {
    id
    approvedSymbol
    approvedName
    associatedDiseases(page: { size: $size, index: 0 }) {
      count
      rows { score disease { id name } }
    }
  }
}
`

// Transcribed from the upstream _OT_DRUG_Q document (mcp_clinical_genomics/server.py), extended
// with indications (live-introspected field name is maxClinicalStage, not maxPhaseForIndication).
const DRUG_QUERY = `
query DrugDetail($chemblId: String!) {
  drug(chemblId: $chemblId) {
    id
    name
    drugType
    maximumClinicalStage
    mechanismsOfAction {
      rows { mechanismOfAction actionType targets { id approvedSymbol } }
    }
    indications {
      count
      rows { disease { id name } maxClinicalStage }
    }
  }
}
`

type SearchHit = { id: string; entity: string; name?: string }
type SearchResponse = {
  data?: { search?: { hits?: SearchHit[] | null } | null }
  errors?: Array<{ message?: string }>
}

type DiseaseRow = { score?: number; disease?: { id?: string; name?: string } | null }
type TargetDiseasesResponse = {
  data?: {
    target?: {
      id: string
      approvedSymbol?: string
      approvedName?: string
      associatedDiseases?: { count?: number; rows?: DiseaseRow[] | null } | null
    } | null
  }
  errors?: Array<{ message?: string }>
}

type MoaRow = {
  mechanismOfAction?: string
  actionType?: string
  targets?: Array<{ id?: string; approvedSymbol?: string }> | null
}
type IndicationRow = {
  disease?: { id?: string; name?: string } | null
  maxClinicalStage?: string
}
type DrugResponse = {
  data?: {
    drug?: {
      id: string
      name?: string
      drugType?: string
      maximumClinicalStage?: string
      mechanismsOfAction?: { rows?: MoaRow[] | null } | null
      indications?: { count?: number; rows?: IndicationRow[] | null } | null
    } | null
  }
  errors?: Array<{ message?: string }>
}

function throwOnErrors(errors: Array<{ message?: string }> | undefined, label: string): void {
  if (errors?.length) {
    throw new Error(
      `Open Targets GraphQL error (${label}): ${errors.map((e) => e.message).join('; ')}`
    )
  }
}

// Ensembl human gene ids look like ENSG00000146648 — skip the search round-trip when already given one.
const ENSEMBL_GENE_ID = /^ensg\d+$/i

async function resolveEnsemblId(
  postJson: (url: string, body: unknown) => Promise<unknown>,
  gene: string
): Promise<string | null> {
  if (ENSEMBL_GENE_ID.test(gene)) return gene.toUpperCase()
  const result = (await postJson(OPEN_TARGETS_API, {
    query: SEARCH_TARGET_QUERY,
    variables: { q: gene }
  })) as SearchResponse
  throwOnErrors(result.errors, 'search')
  const hits = (result.data?.search?.hits ?? []).filter((h) => h.entity === 'target')
  if (!hits.length) return null
  const exact = hits.find((h) => (h.name ?? '').toLowerCase() === gene.toLowerCase())
  return (exact ?? hits[0]).id
}

// Open Targets Platform GraphQL API: every call is a POST of {query, variables} to a single
// endpoint. Unlike gnomAD, an absent entity comes back as `data: { target: null }` / `{ drug:
// null }` with no accompanying "not found" error — so there's no error-message allowlist to check.
export const CLINICAL_GENOMICS_TOOLS: ToolDescriptor[] = [
  {
    id: 'opentargets_target_diseases',
    connector: 'clinical_genomics',
    description:
      'Open Targets: top diseases associated with a gene/target (by symbol or Ensembl gene id), ranked by overall association score.',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIMIT }
      },
      required: ['gene']
    },
    required: ['gene'],
    returns:
      '`{ "gene_id": str, "symbol": str, "approved_name": str, "n_diseases_total": int, "returned": int, "diseases": [ { "disease_id": str, "disease_name": str, "score": float } ] }` — diseases ranked by association score, up to `limit` (default 10); `n_diseases_total` is the full count, usually larger than `returned`. Unresolved symbol or absent target yields `gene_id`/`symbol` null and `diseases: []`.',
    run: async (ctx, a) => {
      const gene = String(a.gene)
      const limit = Number(a.limit ?? DEFAULT_LIMIT)

      const ensemblId = await resolveEnsemblId(ctx.postJson, gene)
      if (!ensemblId) {
        // Free-text symbol had no matching target hit — compact empty result, no error thrown.
        return { gene, gene_id: null, symbol: null, n_diseases_total: 0, returned: 0, diseases: [] }
      }

      const result = (await ctx.postJson(OPEN_TARGETS_API, {
        query: TARGET_DISEASES_QUERY,
        variables: { ensemblId, size: limit }
      })) as TargetDiseasesResponse
      throwOnErrors(result.errors, 'target_diseases')

      const target = result.data?.target
      if (!target) {
        return {
          gene,
          gene_id: ensemblId,
          symbol: null,
          n_diseases_total: 0,
          returned: 0,
          diseases: []
        }
      }

      const rows = target.associatedDiseases?.rows ?? []
      return {
        gene_id: target.id,
        symbol: target.approvedSymbol ?? gene,
        approved_name: target.approvedName,
        n_diseases_total: target.associatedDiseases?.count ?? rows.length,
        returned: rows.length,
        diseases: rows.map((r) => ({
          disease_id: r.disease?.id,
          disease_name: r.disease?.name,
          score: r.score
        }))
      }
    }
  },
  {
    id: 'opentargets_drug',
    connector: 'clinical_genomics',
    description:
      "Open Targets: a drug's mechanism of action (target, action type) and clinical indications, by ChEMBL id.",
    input: {
      type: 'object',
      properties: {
        chembl_id: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIMIT }
      },
      required: ['chembl_id']
    },
    required: ['chembl_id'],
    returns:
      '`{ "chembl_id": str, "name": str, "drug_type": str, "max_clinical_stage": str, "mechanisms_of_action": [ { "mechanism_of_action": str, "action_type": str, "targets": [ { "id": str, "approved_symbol": str } ] } ], "n_indications_total": int, "returned_indications": int, "indications": [ { "disease_id": str, "disease_name": str, "max_clinical_stage": str } ] }` — indications capped at `limit` (default 10); `n_indications_total` is the full count. Unknown ChEMBL id returns `{ "chembl_id": str, "found": false }`.',
    run: async (ctx, a) => {
      const chemblId = String(a.chembl_id)
      const limit = Number(a.limit ?? DEFAULT_LIMIT)

      const result = (await ctx.postJson(OPEN_TARGETS_API, {
        query: DRUG_QUERY,
        variables: { chemblId }
      })) as DrugResponse
      throwOnErrors(result.errors, 'drug')

      const drug = result.data?.drug
      if (!drug) {
        return { chembl_id: chemblId, found: false }
      }

      const moaRows = drug.mechanismsOfAction?.rows ?? []
      const allIndications = drug.indications?.rows ?? []
      const indications = allIndications.slice(0, limit)

      return {
        chembl_id: drug.id,
        name: drug.name,
        drug_type: drug.drugType,
        max_clinical_stage: drug.maximumClinicalStage,
        mechanisms_of_action: moaRows.map((r) => ({
          mechanism_of_action: r.mechanismOfAction,
          action_type: r.actionType,
          targets: (r.targets ?? []).map((t) => ({ id: t.id, approved_symbol: t.approvedSymbol }))
        })),
        n_indications_total: drug.indications?.count ?? allIndications.length,
        returned_indications: indications.length,
        indications: indications.map((i) => ({
          disease_id: i.disease?.id,
          disease_name: i.disease?.name,
          max_clinical_stage: i.maxClinicalStage
        }))
      }
    }
  }
]
