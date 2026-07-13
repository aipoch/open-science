import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CANCER_MODELS_TOOLS } from './cancer-models'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CANCER_MODELS_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('cancer_models / search studies', () => {
  it('cbioportal_search_studies builds the search URL and parses compact rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes([
        {
          studyId: 'brca_pareja_msk_2020',
          name: 'Breast Cancer (MSK, Clinical Cancer Res 2020)',
          description: 'Whole-exome and MSK-IMPACT sequencing of 60 tumor/normal matched samples.',
          cancerTypeId: 'brca',
          cancerType: { name: 'Invasive Breast Carcinoma' },
          allSampleCount: 60,
          sequencedSampleCount: 60
        },
        {
          studyId: 'brca_hta9_htan_2022',
          name: 'Breast Cancer (HTAN, 2022)',
          cancerTypeId: 'brca',
          cancerType: { name: 'Invasive Breast Carcinoma' },
          allSampleCount: 5,
          sequencedSampleCount: 5
        }
      ])
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('cbioportal_search_studies'),
      { query: 'breast' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.cbioportal.org/api/studies?keyword=breast&projection=DETAILED&pageSize=10&pageNumber=0'
    )
    expect(out).toEqual([
      {
        studyId: 'brca_pareja_msk_2020',
        name: 'Breast Cancer (MSK, Clinical Cancer Res 2020)',
        cancerType: 'Invasive Breast Carcinoma',
        allSampleCount: 60
      },
      {
        studyId: 'brca_hta9_htan_2022',
        name: 'Breast Cancer (HTAN, 2022)',
        cancerType: 'Invasive Breast Carcinoma',
        allSampleCount: 5
      }
    ])
  })

  it('respects a custom page_size and returns an empty array for no matches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('cbioportal_search_studies'),
      { query: 'nonexistent-cancer-xyz', page_size: 5 },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toContain('pageSize=5')
    expect(out).toEqual([])
  })

  it('encodes special characters in the query', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    await new ParserEngine({ fetchImpl }).call(
      tool('cbioportal_search_studies'),
      { query: 'a b&c' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.cbioportal.org/api/studies?keyword=a%20b%26c&projection=DETAILED&pageSize=10&pageNumber=0'
    )
  })
})

describe('cancer_models / get study', () => {
  it('cbioportal_get_study builds the record URL and parses a compact summary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        studyId: 'msk_impact_2017',
        name: 'MSK-IMPACT Clinical Sequencing Cohort (MSK, Nat Med 2017)',
        description: 'Targeted sequencing of tumor/normal pairs.',
        cancerTypeId: 'mixed',
        cancerType: { name: 'Mixed Cancer Types' },
        pmid: '28481359',
        citation: 'Zehir et al. Nat Med 2017',
        referenceGenome: 'hg19',
        allSampleCount: 10945,
        sequencedSampleCount: 10945,
        cnaSampleCount: 10336,
        structuralVariantCount: 0
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('cbioportal_get_study'),
      { study_id: 'msk_impact_2017' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.cbioportal.org/api/studies/msk_impact_2017?projection=DETAILED'
    )
    expect(out).toEqual({
      studyId: 'msk_impact_2017',
      name: 'MSK-IMPACT Clinical Sequencing Cohort (MSK, Nat Med 2017)',
      description: 'Targeted sequencing of tumor/normal pairs.',
      cancerType: 'Mixed Cancer Types',
      cancerTypeId: 'mixed',
      pmid: '28481359',
      citation: 'Zehir et al. Nat Med 2017',
      referenceGenome: 'hg19',
      allSampleCount: 10945,
      sequencedSampleCount: 10945,
      cnaSampleCount: 10336,
      structuralVariantCount: 0
    })
  })

  it('encodes special characters in the study id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ studyId: 'a/b' }))
    await new ParserEngine({ fetchImpl }).call(
      tool('cbioportal_get_study'),
      { study_id: 'a b' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.cbioportal.org/api/studies/a%20b?projection=DETAILED'
    )
  })
})
