import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { HUMAN_GENETICS_TOOLS } from './human-genetics'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => HUMAN_GENETICS_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

// GWAS Catalog REST API v2 shape: flat snake_case association records wrapped in a HAL-style
// `_embedded` collection (confirmed against the upstream fleet client's gwas_catalog/tool.py).
const HAL_ASSOCIATIONS = {
  page: { size: 50, totalElements: 2, totalPages: 1, number: 0 },
  _embedded: {
    associations: [
      {
        association_id: '12345',
        p_value: 1.2e-15,
        snp_effect_allele: ['rs7412-T'],
        snp_allele: [{ rs_id: 'rs7412' }],
        mapped_genes: ['APOE'],
        efo_traits: [{ efo_id: 'EFO_0004611', efo_trait: 'LDL cholesterol measurement' }],
        reported_trait: ['LDL cholesterol']
      },
      {
        association_id: '67890',
        p_value: 3.4e-8,
        snp_effect_allele: ['rs429358-C'],
        snp_allele: [{ rs_id: 'rs429358' }],
        mapped_genes: ['APOE', 'TOMM40'],
        efo_traits: [],
        reported_trait: ['Alzheimer disease']
      }
    ]
  }
}

describe('human_genetics / gwas_search_associations', () => {
  it('builds the mapped_gene URL and parses the HAL _embedded collection', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(HAL_ASSOCIATIONS))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('gwas_search_associations'),
      { gene: 'APOE' },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://www.ebi.ac.uk/gwas/rest/api/v2/associations?mapped_gene=APOE&size=50&sort=p_value&direction=asc'
    )
    expect(out).toEqual([
      {
        rsId: 'rs7412',
        pValue: 1.2e-15,
        riskAllele: 'rs7412-T',
        mappedGenes: ['APOE'],
        trait: 'LDL cholesterol measurement'
      },
      {
        rsId: 'rs429358',
        pValue: 3.4e-8,
        riskAllele: 'rs429358-C',
        mappedGenes: ['APOE', 'TOMM40'],
        trait: 'Alzheimer disease'
      }
    ])
  })

  it('returns an empty array when there are no embedded associations', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ page: { totalElements: 0 }, _embedded: { associations: [] } }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('gwas_search_associations'),
      { gene: 'NOPE' },
      {}
    )
    expect(out).toEqual([])
  })
})

describe('human_genetics / gwas_variant_associations', () => {
  it('builds the rs_id URL and parses associations', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(HAL_ASSOCIATIONS))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('gwas_variant_associations'),
      { rsId: 'rs7412' },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://www.ebi.ac.uk/gwas/rest/api/v2/associations?rs_id=rs7412&size=50&sort=p_value&direction=asc'
    )
    expect((out as unknown[])[0]).toEqual({
      rsId: 'rs7412',
      pValue: 1.2e-15,
      riskAllele: 'rs7412-T',
      mappedGenes: ['APOE'],
      trait: 'LDL cholesterol measurement'
    })
  })

  it('tolerates missing embedded/trait fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        page: { totalElements: 1 },
        _embedded: {
          associations: [{ p_value: 0.001, snp_allele: [{ rs_id: 'rs1' }], mapped_genes: [] }]
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('gwas_variant_associations'),
      { rsId: 'rs1' },
      {}
    )
    expect(out).toEqual([
      { rsId: 'rs1', pValue: 0.001, riskAllele: undefined, mappedGenes: [], trait: undefined }
    ])
  })
})
