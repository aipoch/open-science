import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENOMES_TOOLS } from './genomes'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => GENOMES_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const BRCA2_FEATURE = {
  id: 'ENSG00000139618',
  display_name: 'BRCA2',
  biotype: 'protein_coding',
  seq_region_name: '13',
  start: 32315086,
  end: 32400268,
  strand: 1,
  version: 19,
  assembly_name: 'GRCh38',
  description: 'BRCA2 DNA repair associated'
}

describe('genomes / ensembl_lookup_symbol', () => {
  it('builds the lookup URL with a default species and parses the feature', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(BRCA2_FEATURE))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('ensembl_lookup_symbol'),
      { symbol: 'BRCA2' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rest.ensembl.org/lookup/symbol/homo_sapiens/BRCA2?content-type=application/json'
    )
    expect(out).toEqual({
      id: 'ENSG00000139618',
      display_name: 'BRCA2',
      biotype: 'protein_coding',
      seq_region_name: '13',
      start: 32315086,
      end: 32400268,
      strand: 1
    })
  })

  it('honors an explicit species', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(BRCA2_FEATURE))
    await new ParserEngine({ fetchImpl }).call(
      tool('ensembl_lookup_symbol'),
      { symbol: 'Brca2', species: 'mus_musculus' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rest.ensembl.org/lookup/symbol/mus_musculus/Brca2?content-type=application/json'
    )
  })
})

describe('genomes / ensembl_lookup_id', () => {
  it('builds the lookup URL and parses the feature', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(BRCA2_FEATURE))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('ensembl_lookup_id'),
      { id: 'ENSG00000139618' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rest.ensembl.org/lookup/id/ENSG00000139618?content-type=application/json'
    )
    expect(out).toEqual({
      id: 'ENSG00000139618',
      display_name: 'BRCA2',
      biotype: 'protein_coding',
      seq_region_name: '13',
      start: 32315086,
      end: 32400268,
      strand: 1
    })
  })
})
