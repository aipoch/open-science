import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { HUMANGENETICS_PHEWAS_TOOLS } from './humangenetics-phewas'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

// A 404 response the engine turns into an "HTTP 404 for <url>" error (client error, no retry).
const notFoundRes = (): Response =>
  ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

const tool = (id: string): (typeof HUMANGENETICS_PHEWAS_TOOLS)[number] => {
  const t = HUMANGENETICS_PHEWAS_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }).call(
    tool(id),
    args,
    {}
  )

// ---- fixtures modelled on the LIVE responses (r12.finngen.fi + pheweb.jp) --------------------

const finngenVariant = {
  variant: {
    chr: 19,
    pos: 44908822,
    ref: 'C',
    alt: 'T',
    varid: '19:44908822:C:T',
    annotation: {
      annot: { gene_most_severe: 'APOE', most_severe: 'missense_variant' },
      gnomad: {
        AF: 0.073846,
        AF_fin: 0.049875,
        AF_nfe: 0.078227,
        AF_popmax: 0.10699,
        AN: '1388698',
        consequences: '[...]'
      },
      rsids: 'rs7412'
    }
  },
  results: [
    {
      phenocode: 'MID_SIG',
      phenostring: 'Middle hit',
      category: 'X',
      pval: 0.5,
      mlogp: 0.3,
      beta: 0.1,
      sebeta: 0.2,
      maf: 0.05,
      maf_case: 0.06,
      maf_control: 0.05,
      n_case: 100,
      n_control: 400,
      n_sample: 500
    },
    {
      phenocode: 'TOP_SIG',
      phenostring: 'Top hit',
      category: 'Y',
      pval: 1e-20,
      mlogp: 20,
      beta: -0.5,
      sebeta: 0.05,
      maf: 0.05,
      maf_case: 0.02,
      maf_control: 0.05,
      n_case: 124,
      n_control: 439048,
      n_sample: 439172
    }
  ]
}

const bbjVariant = {
  chrom: '1',
  pos: 55505647,
  ref: 'G',
  alt: 'T',
  rsids: 'rs11591147',
  nearest_genes: 'PCSK9',
  phenos: [
    {
      af: 0.018,
      beta: 0.022,
      sebeta: 0.00052,
      pval: 0.33,
      category: 'ICD10 J, L',
      num_cases: 81062,
      num_controls: 291471,
      num_samples: 372533,
      phenocode: 'Allergy_UKB',
      phenostring: 'Allergy multi-trait'
    },
    {
      af: 0.018,
      beta: -0.6,
      sebeta: 0.01,
      pval: 1e-30,
      category: 'Lipid',
      num_cases: 1000,
      num_controls: 2000,
      num_samples: 3000,
      phenocode: 'LDL',
      phenostring: 'LDL cholesterol'
    }
  ]
}

const finngenGene = {
  region: { chrom: '1', start: 54939447, end: 55164852 },
  phenotypes: [
    {
      assoc: {
        phenocode: 'GENE_MID',
        phenostring: 'Gene middle',
        category: 'I',
        pval: 0.9,
        mlogp: 0.04,
        beta: 0.01,
        sebeta: 0.2,
        maf: 0.0004,
        maf_case: 0.0028,
        maf_control: 0.0004,
        n_case: 534,
        n_control: 439048,
        n_sample: 439582
      },
      pheno: { phenocode: 'GENE_MID' },
      variant: {
        chr: 1,
        pos: 55117454,
        ref: 'C',
        alt: 'T',
        varid: '1:55117454:C:T',
        annotation: { rsids: 'rs952773513' }
      }
    },
    {
      assoc: {
        phenocode: 'GENE_TOP',
        phenostring: 'Gene top',
        category: 'IX',
        pval: 1e-10,
        mlogp: 10,
        beta: -0.4,
        sebeta: 0.03,
        maf: 0.02,
        maf_case: 0.05,
        maf_control: 0.02,
        n_case: 4000,
        n_control: 400000,
        n_sample: 404000
      },
      pheno: { phenocode: 'GENE_TOP' },
      variant: {
        chr: 1,
        pos: 55505647,
        ref: 'G',
        alt: 'T',
        varid: '1:55505647:G:T',
        annotation: { rsids: 'rs11591147' }
      }
    }
  ]
}

const finngenPhenos = [
  {
    phenocode: 'T2D',
    phenostring: 'Type 2 diabetes',
    category: 'Endocrine',
    num_cases: 50000,
    num_controls: 400000,
    num_gw_significant: 120
  },
  {
    phenocode: 'AB1_TB',
    phenostring: 'Tuberculosis',
    category: 'Infection',
    num_cases: 60,
    num_controls: 497285,
    num_gw_significant: 0
  }
]

const finngenAutocomplete = [
  { display: 'Type 2 diabetes, definitions combined (T2D)', pheno: 'T2D' },
  { display: 'Type 1 diabetes, definitions combined (T1D)', pheno: 'T1D' }
]

const bbjAutocomplete = [
  { display: 'Drugs used in diabetes (ATC_A10)', url: '/pheno/ATC_A10', value: 'ATC_A10' },
  { display: 'Type 1 diabetes (T1D)', url: '/pheno/T1D', value: 'T1D' }
]

// ---------------------------------------------------------------------------------------------

describe('phewas_instances', () => {
  it('returns the in-code registry with both instances, builds and capabilities', async () => {
    const out = (await run('phewas_instances', {}, vi.fn())) as {
      instances: Record<string, { base_url: string; genome_build: string; capabilities: string[] }>
    }
    expect(Object.keys(out.instances)).toEqual(['finngen', 'bbj'])
    expect(out.instances.finngen.base_url).toBe('https://r12.finngen.fi')
    expect(out.instances.finngen.genome_build).toBe('GRCh38')
    expect(out.instances.finngen.capabilities).toEqual([
      'variant',
      'gene',
      'phenotypes',
      'autocomplete'
    ])
    expect(out.instances.bbj.base_url).toBe('https://pheweb.jp')
    expect(out.instances.bbj.genome_build).toBe('GRCh37')
    // BBJ exposes only variant + autocomplete.
    expect(out.instances.bbj.capabilities).toEqual(['variant', 'autocomplete'])
  })
})

describe('phewas_variant', () => {
  it('finngen: normalizes variant (chr prefix + :/_ separators), sorts by pval, caps, maps meta + rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(finngenVariant))
    const out = (await run(
      'phewas_variant',
      { instance: 'finngen', variant: 'chr19:44908822_C:T', max_phenos: 1 },
      fetchImpl
    )) as {
      instance: string
      genome_build: string
      variant: string
      variant_meta: Record<string, unknown>
      total: number
      returned: number
      truncated: boolean
      phenotypes: Array<Record<string, unknown>>
    }
    // Normalized id used in the URL (chr stripped, all separators -> '-').
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://r12.finngen.fi/api/variant/19-44908822-C-T'
    )
    expect(out.instance).toBe('finngen')
    expect(out.genome_build).toBe('GRCh38')
    expect(out.variant).toBe('19-44908822-C-T')
    // variant_meta: rsids/nearest_genes as arrays, lean gnomad AF block.
    expect(out.variant_meta.rsids).toEqual(['rs7412'])
    expect(out.variant_meta.nearest_genes).toEqual(['APOE'])
    expect(out.variant_meta.gnomad).toEqual({
      AF: 0.073846,
      AF_fin: 0.049875,
      AF_nfe: 0.078227,
      AF_popmax: 0.10699
    })
    // p-value sort + cap: TOP_SIG (1e-20) beats MID_SIG (0.5); only 1 returned of 2.
    expect(out.total).toBe(2)
    expect(out.returned).toBe(1)
    expect(out.truncated).toBe(true)
    const row = out.phenotypes[0]
    expect(row.phenocode).toBe('TOP_SIG')
    expect(row.mlogp).toBe(20)
    expect(row.maf_case).toBe(0.02)
    expect(row.n_cases).toBe(124)
    expect(row.n_controls).toBe(439048)
    expect(row.n_samples).toBe(439172)
    // FinnGen rows have maf, not af.
    expect(row.af).toBeNull()
    expect(row.maf).toBe(0.05)
  })

  it('bbj: flat response, af (not maf), no gnomad, no mlogp', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(bbjVariant))
    const out = (await run(
      'phewas_variant',
      { instance: 'bbj', variant: '1-55505647-G-T' },
      fetchImpl
    )) as {
      genome_build: string
      variant_meta: Record<string, unknown>
      phenotypes: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://pheweb.jp/api/variant/1-55505647-G-T')
    expect(out.genome_build).toBe('GRCh37')
    expect(out.variant_meta.rsids).toEqual(['rs11591147'])
    expect(out.variant_meta.nearest_genes).toEqual(['PCSK9'])
    expect(out.variant_meta.gnomad).toBeNull()
    // Sorted: LDL (1e-30) first.
    const row = out.phenotypes[0]
    expect(row.phenocode).toBe('LDL')
    expect(row.af).toBe(0.018)
    expect(row.maf).toBeNull()
    expect(row.mlogp).toBeNull()
    expect(row.n_cases).toBe(1000)
    expect(row.n_samples).toBe(3000)
  })

  it('rejects a malformed variant string before any request', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('phewas_variant', { instance: 'finngen', variant: '19-44908822-C' }, fetchImpl)
    ).rejects.toThrow(/Invalid variant/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps an upstream 404 to a clean not-found error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(notFoundRes())
    await expect(
      run('phewas_variant', { instance: 'finngen', variant: '19-99999999-C-T' }, fetchImpl)
    ).rejects.toThrow(/not found on PheWeb instance 'finngen'/)
  })
})

describe('phewas_finngen_gene', () => {
  it('reads /api/gene_phenos, sorts by pval, caps, attaches the per-endpoint variant', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(finngenGene))
    const out = (await run(
      'phewas_finngen_gene',
      { gene_symbol: 'PCSK9', max_phenos: 5 },
      fetchImpl
    )) as {
      instance: string
      genome_build: string
      gene_symbol: string
      total: number
      returned: number
      truncated: boolean
      phenotypes: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://r12.finngen.fi/api/gene_phenos/PCSK9')
    expect(out.instance).toBe('finngen')
    expect(out.genome_build).toBe('GRCh38')
    expect(out.total).toBe(2)
    expect(out.returned).toBe(2)
    expect(out.truncated).toBe(false)
    // GENE_TOP (1e-10) sorts before GENE_MID (0.9).
    const top = out.phenotypes[0]
    expect(top.phenocode).toBe('GENE_TOP')
    expect(top.n_cases).toBe(4000)
    // Each row carries its best variant in {chrom,pos,ref,alt,varid,rsids}.
    expect(top.variant).toEqual({
      chrom: '1',
      pos: 55505647,
      ref: 'G',
      alt: 'T',
      varid: '1:55505647:G:T',
      rsids: ['rs11591147']
    })
  })

  it('unknown gene -> not-found error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(notFoundRes())
    await expect(
      run('phewas_finngen_gene', { gene_symbol: 'NOTAGENE' }, fetchImpl)
    ).rejects.toThrow(/Gene 'NOTAGENE' not found/)
  })
})

describe('phewas_list_phenotypes', () => {
  it('finngen-only: reads /api/phenos, sorts by phenocode, maps count fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(finngenPhenos))
    const out = (await run('phewas_list_phenotypes', {}, fetchImpl)) as {
      instance: string
      total: number
      returned: number
      truncated: boolean
      phenotypes: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://r12.finngen.fi/api/phenos')
    expect(out.instance).toBe('finngen')
    expect(out.total).toBe(2)
    // Sorted by phenocode: AB1_TB before T2D.
    expect(out.phenotypes.map((p) => p.phenocode)).toEqual(['AB1_TB', 'T2D'])
    expect(out.phenotypes[1]).toEqual({
      phenocode: 'T2D',
      phenostring: 'Type 2 diabetes',
      category: 'Endocrine',
      num_cases: 50000,
      num_controls: 400000,
      num_gw_significant: 120
    })
  })

  it('caps at max_records and flags truncation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(finngenPhenos))
    const out = (await run('phewas_list_phenotypes', { max_records: 1 }, fetchImpl)) as {
      returned: number
      truncated: boolean
    }
    expect(out.returned).toBe(1)
    expect(out.truncated).toBe(true)
  })

  it('rejects an instance without the phenotypes capability (bbj)', async () => {
    const fetchImpl = vi.fn()
    // enum forbids bbj, but the run guard must also reject it defensively.
    await expect(run('phewas_list_phenotypes', { instance: 'bbj' }, fetchImpl)).rejects.toThrow(
      /does not support 'phenotypes'/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('phewas_search_phenotypes', () => {
  it('finngen autocomplete: maps pheno -> phenocode, url null', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(finngenAutocomplete))
    const out = (await run('phewas_search_phenotypes', { query: 'diabetes' }, fetchImpl)) as {
      instance: string
      matches: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://r12.finngen.fi/api/autocomplete?query=diabetes'
    )
    expect(out.instance).toBe('finngen')
    expect(out.matches[0]).toEqual({
      display: 'Type 2 diabetes, definitions combined (T2D)',
      phenocode: 'T2D',
      url: null
    })
  })

  it('bbj autocomplete: maps value -> phenocode and keeps instance-relative url', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(bbjAutocomplete))
    const out = (await run(
      'phewas_search_phenotypes',
      { query: 'diabetes', instance: 'bbj', max_records: 1 },
      fetchImpl
    )) as {
      total: number
      returned: number
      truncated: boolean
      matches: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://pheweb.jp/api/autocomplete?query=diabetes'
    )
    expect(out.total).toBe(2)
    expect(out.returned).toBe(1)
    expect(out.truncated).toBe(true)
    expect(out.matches[0]).toEqual({
      display: 'Drugs used in diabetes (ATC_A10)',
      phenocode: 'ATC_A10',
      url: '/pheno/ATC_A10'
    })
  })
})
