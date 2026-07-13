import type { ToolDescriptor } from '../types'

const GWAS_ASSOCIATIONS = 'https://www.ebi.ac.uk/gwas/rest/api/v2/associations'
const PAGE_SIZE = 50

// v2 API response shapes (confirmed against the upstream fleet client's gwas_catalog/tool.py:
// flat snake_case records wrapped in a HAL-style `_embedded` collection, NOT link-follow HATEOAS).
type GwasEfoTrait = { efo_id?: string; efo_trait?: string }
type GwasSnpAllele = { rs_id?: string }
type GwasAssociationRecord = {
  p_value?: number
  snp_effect_allele?: string[]
  snp_allele?: GwasSnpAllele[]
  mapped_genes?: string[]
  efo_traits?: GwasEfoTrait[]
  reported_trait?: string[]
}
type GwasAssociationsResponse = { _embedded?: { associations?: GwasAssociationRecord[] } }

type CompactAssociation = {
  rsId?: string
  pValue?: number
  riskAllele?: string
  mappedGenes: string[]
  trait?: string
}

function flattenAssociations(raw: unknown): CompactAssociation[] {
  const records = (raw as GwasAssociationsResponse)._embedded?.associations ?? []
  return records.map((rec) => ({
    rsId: rec.snp_allele?.[0]?.rs_id,
    pValue: rec.p_value,
    riskAllele: rec.snp_effect_allele?.[0],
    mappedGenes: rec.mapped_genes ?? [],
    trait: rec.efo_traits?.[0]?.efo_trait ?? rec.reported_trait?.[0]
  }))
}

// NHGRI-EBI GWAS Catalog REST API v2: read-only genome-wide-association lookups by gene or rsID.
export const HUMAN_GENETICS_TOOLS: ToolDescriptor[] = [
  {
    id: 'gwas_search_associations',
    connector: 'human_genetics',
    description:
      'Search GWAS Catalog associations mapped to a gene symbol, most significant (lowest p-value) first.',
    input: {
      type: 'object',
      properties: {
        gene: {
          type: 'string',
          description: 'HGNC gene symbol, exact match, e.g. PCSK9, APOE'
        }
      },
      required: ['gene']
    },
    required: ['gene'],
    returns:
      '`[ { "rsId": str, "pValue": float, "riskAllele": str, "mappedGenes": [ str ], "trait": str } ]` — up to 50 associations sorted by ascending p-value; `[]` when none match. `mappedGenes` may be empty; `trait` falls back to reported trait.',
    url: (a) =>
      `${GWAS_ASSOCIATIONS}?mapped_gene=${encodeURIComponent(String(a.gene))}&size=${PAGE_SIZE}&sort=p_value&direction=asc`,
    parse: (raw) => flattenAssociations(raw)
  },
  {
    id: 'gwas_variant_associations',
    connector: 'human_genetics',
    description:
      'GWAS Catalog associations reported for one dbSNP variant (rsID), most significant first.',
    input: {
      type: 'object',
      properties: {
        rsId: { type: 'string', description: 'dbSNP rsID, e.g. rs7412' }
      },
      required: ['rsId']
    },
    required: ['rsId'],
    returns:
      '`[ { "rsId": str, "pValue": float, "riskAllele": str, "mappedGenes": [ str ], "trait": str } ]` — up to 50 associations sorted by ascending p-value; `[]` when none match. `mappedGenes` may be empty; `trait` falls back to reported trait.',
    url: (a) =>
      `${GWAS_ASSOCIATIONS}?rs_id=${encodeURIComponent(String(a.rsId))}&size=${PAGE_SIZE}&sort=p_value&direction=asc`,
    parse: (raw) => flattenAssociations(raw)
  }
]
