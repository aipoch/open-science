import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { HUMANGENETICS_EQTL_TOOLS } from './humangenetics-eqtl'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): (typeof HUMANGENETICS_EQTL_TOOLS)[number] => {
  const t = HUMANGENETICS_EQTL_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

// Runs a tool through the engine with a URL-dispatching fetch mock.
const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch }).call(tool(id), args, {})

// Two datasets from the same study, intentionally out of dataset_id order to prove the sort.
const dsB = {
  study_id: 'QTS000001',
  quant_method: 'exon',
  sample_group: 'macrophage_naive',
  tissue_id: 'CL_0000235',
  study_label: 'Alasoo_2018',
  tissue_label: 'macrophage',
  condition_label: 'naive',
  dataset_id: 'QTD000002',
  sample_size: 84
}
const dsA = { ...dsB, quant_method: 'ge', dataset_id: 'QTD000001' }

const assocRow = {
  nlog10p: 1.24,
  pvalue: 0.0575,
  molecular_trait_id: 'ENSG00000215014',
  gene_id: 'ENSG00000215014',
  position: 791100,
  chromosome: '1',
  ref: 'G',
  alt: 'GGGA',
  type: 'INDEL',
  variant: 'chr1_791100_G_GGGA',
  rsid: 'rs1323158546',
  ac: 21,
  an: 168,
  beta: -0.136166,
  maf: 0.113095,
  median_tpm: 3.644,
  r2: 0.4679,
  se: 0.300142
}

describe('eqtl_list_datasets', () => {
  it('assembles the filter params and size, and sorts records by dataset_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([dsB, dsA]))
    const out = (await run(
      'eqtl_list_datasets',
      {
        study_label: 'Alasoo_2018',
        tissue_label: 'macrophage',
        quant_method: 'ge',
        max_records: 50
      },
      fetchImpl
    )) as {
      filters: Record<string, string>
      returned: number
      truncated: boolean
      datasets: Array<Record<string, unknown>>
    }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/datasets?')
    expect(url).toContain('study_label=Alasoo_2018')
    expect(url).toContain('tissue_label=macrophage')
    expect(url).toContain('quant_method=ge')
    expect(url).toContain('size=50')
    expect(out.filters).toEqual({
      study_label: 'Alasoo_2018',
      tissue_label: 'macrophage',
      quant_method: 'ge'
    })
    // Sorted ascending by dataset_id despite upstream returning QTD000002 first.
    expect(out.datasets.map((d) => d.dataset_id)).toEqual(['QTD000001', 'QTD000002'])
    expect(out.datasets[0]).toEqual({
      dataset_id: 'QTD000001',
      study_id: 'QTS000001',
      study_label: 'Alasoo_2018',
      sample_group: 'macrophage_naive',
      tissue_id: 'CL_0000235',
      tissue_label: 'macrophage',
      condition_label: 'naive',
      quant_method: 'ge',
      sample_size: 84
    })
    expect(out.returned).toBe(2)
  })

  it('truncated=false proves complete when the page is shorter than the cap', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([dsA, dsB]))
    const out = (await run('eqtl_list_datasets', { max_records: 1000 }, fetchImpl)) as {
      truncated: boolean
      returned: number
    }
    expect(out.returned).toBe(2)
    expect(out.truncated).toBe(false)
  })

  it('truncated=true when the page fills the cap (exhaustion not proven)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([dsA, dsB]))
    const out = (await run('eqtl_list_datasets', { max_records: 2 }, fetchImpl)) as {
      truncated: boolean
    }
    expect(out.truncated).toBe(true)
  })

  it('normalizes the {message:"No results"} empty body to an empty listing', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ message: 'No results' }))
    const out = (await run('eqtl_list_datasets', { study_label: 'NoSuchStudyXYZ' }, fetchImpl)) as {
      returned: number
      truncated: boolean
      datasets: unknown[]
    }
    expect(out.returned).toBe(0)
    expect(out.datasets).toEqual([])
    expect(out.truncated).toBe(false)
  })
})

describe('eqtl_associations', () => {
  it('throws when the required dataset_id is missing (engine-level required)', async () => {
    const fetchImpl = vi.fn()
    await expect(run('eqtl_associations', { gene_id: 'ENSG1' }, fetchImpl)).rejects.toThrow(
      /dataset_id/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws when no locus filter (gene_id/rsid/variant/pos) is provided', async () => {
    const fetchImpl = vi.fn()
    await expect(run('eqtl_associations', { dataset_id: 'QTD000001' }, fetchImpl)).rejects.toThrow(
      /at least one of gene_id, rsid, variant, or pos/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps nlog10p_min to the nlog10p param, sets size, and passes rows through', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([assocRow]))
    const out = (await run(
      'eqtl_associations',
      {
        dataset_id: 'QTD000001',
        gene_id: 'ENSG00000215014',
        nlog10p_min: 0.5,
        max_records: 100
      },
      fetchImpl
    )) as {
      dataset_id: string
      filters: Record<string, unknown>
      returned: number
      truncated: boolean
      associations: Array<Record<string, unknown>>
    }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/datasets/QTD000001/associations?')
    expect(url).toContain('gene_id=ENSG00000215014')
    // Tool-facing nlog10p_min becomes the upstream nlog10p query param.
    expect(url).toContain('nlog10p=0.5')
    expect(url).not.toContain('nlog10p_min=')
    expect(url).toContain('size=100')
    expect(out.dataset_id).toBe('QTD000001')
    expect(out.filters).toEqual({ gene_id: 'ENSG00000215014', nlog10p_min: 0.5 })
    expect(out.returned).toBe(1)
    // Row is surfaced in the documented shape.
    expect(out.associations[0]).toEqual({
      molecular_trait_id: 'ENSG00000215014',
      gene_id: 'ENSG00000215014',
      variant: 'chr1_791100_G_GGGA',
      rsid: 'rs1323158546',
      chromosome: '1',
      position: 791100,
      ref: 'G',
      alt: 'GGGA',
      type: 'INDEL',
      beta: -0.136166,
      se: 0.300142,
      pvalue: 0.0575,
      nlog10p: 1.24,
      maf: 0.113095,
      ac: 21,
      an: 168,
      r2: 0.4679,
      median_tpm: 3.644
    })
  })

  it('URL-encodes a pos/variant filter and reports truncated=false for a short page', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([assocRow]))
    const out = (await run(
      'eqtl_associations',
      { dataset_id: 'QTD000001', pos: '1:791000-792000', max_records: 1000 },
      fetchImpl
    )) as { truncated: boolean; filters: Record<string, unknown> }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain(`pos=${encodeURIComponent('1:791000-792000')}`)
    expect(out.filters).toEqual({ pos: '1:791000-792000' })
    expect(out.truncated).toBe(false)
  })

  it('truncated=true when the page fills the cap', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([assocRow, assocRow]))
    const out = (await run(
      'eqtl_associations',
      { dataset_id: 'QTD000001', rsid: 'rs1323158546', max_records: 2 },
      fetchImpl
    )) as { truncated: boolean; returned: number }
    expect(out.returned).toBe(2)
    expect(out.truncated).toBe(true)
  })

  it('normalizes the {message:"No results"} empty body to zero associations', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ message: 'No results' }))
    const out = (await run(
      'eqtl_associations',
      { dataset_id: 'QTD000001', gene_id: 'ENSG00000187608' },
      fetchImpl
    )) as { returned: number; truncated: boolean; associations: unknown[] }
    expect(out.returned).toBe(0)
    expect(out.associations).toEqual([])
    expect(out.truncated).toBe(false)
  })

  it('treats an HTTP 400 "No results" from a well-formed query as empty (not a throw)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 400 } as Response)
    const out = (await run(
      'eqtl_associations',
      { dataset_id: 'QTD000266', gene_id: 'ENSG00000130203' },
      fetchImpl
    )) as { returned: number; truncated: boolean; associations: unknown[] }
    expect(out.returned).toBe(0)
    expect(out.associations).toEqual([])
    expect(out.truncated).toBe(false)
  })
})
