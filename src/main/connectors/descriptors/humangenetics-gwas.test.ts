import { describe, it, expect, vi } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import { ParserEngine } from '../engine'
import { HUMANGENETICS_GWAS_TOOLS } from './humangenetics-gwas'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

// Mirrors the engine's non-retryable 4xx path so the get_* tools see an HTTP 404 error.
const errRes = (status: number): Response =>
  ({ ok: false, status, headers: { get: () => null } }) as unknown as Response

const tool = (id: string): (typeof HUMANGENETICS_GWAS_TOOLS)[number] => {
  const t = HUMANGENETICS_GWAS_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch }).call(tool(id), args, {})

// A representative v2 association record (or_value present, beta absent as "-").
const assoc = (id: number, pvalue: number): Record<string, unknown> => ({
  association_id: id,
  p_value: pvalue,
  pvalue_mantissa: 8,
  pvalue_exponent: -18,
  pvalue_description: '',
  or_value: '0.76',
  beta: '-',
  ci_lower: 0.71,
  ci_upper: 0.81,
  range: '[0.71-0.81]',
  risk_frequency: 'NR',
  snp_effect_allele: ['rs7412-T'],
  snp_allele: [{ rs_id: 'rs7412', effect_allele: 'T' }],
  locations: ['19:44908822'],
  mapped_genes: ['APOE'],
  efo_traits: [{ efo_id: 'HP_0003124', efo_trait: 'hypercholesterolemia' }],
  bg_efo_traits: [],
  reported_trait: ['Hypercholesterolemia'],
  multi_snp_haplotype: false,
  snp_interaction: false,
  accession_id: 'GCST90837533',
  pubmed_id: '41298473',
  first_author: 'Koyama S'
})

// A HAL association page; `next` is set when more pages follow.
const assocPage = (
  rows: Record<string, unknown>[],
  total: number,
  next?: string
): Record<string, unknown> => ({
  _embedded: { associations: rows },
  _links: next ? { next: { href: next } } : {},
  page: { size: rows.length, totalElements: total, totalPages: 99, number: 0 }
})

describe('gwas_associations_for_variant', () => {
  it('paginates HAL _embedded, count-verifies against page.totalElements, projects the row shape', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('page=1')) {
        return Promise.resolve(jsonRes(assocPage([assoc(2, 5e-10)], 3)))
      }
      return Promise.resolve(
        jsonRes(assocPage([assoc(1, 8e-18)], 3, 'https://x/v2/associations?rs_id=rs7412&page=1'))
      )
    })
    const out = (await run('gwas_associations_for_variant', { rs_id: 'rs7412' }, fetchImpl)) as {
      rs_id: string
      api_total: number
      returned: number
      truncated: boolean
      associations: Array<Record<string, unknown>>
    }
    // First request assembles the p-value-ascending v2 query.
    const firstUrl = String(fetchImpl.mock.calls[0][0])
    expect(firstUrl).toContain('/v2/associations?rs_id=rs7412')
    expect(firstUrl).toContain('sort=p_value')
    expect(firstUrl).toContain('direction=asc')
    // Two pages walked via _links.next; count matches the third association it never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.rs_id).toBe('rs7412')
    expect(out.api_total).toBe(3)
    expect(out.returned).toBe(2)
    expect(out.truncated).toBe(true)
    // Projection: effect alleles pluralized, rs_ids from snp_allele, study accession renamed.
    const r = out.associations[0]
    expect(r.association_id).toBe(1)
    expect(r.snp_effect_alleles).toEqual(['rs7412-T'])
    expect(r.rs_ids).toEqual(['rs7412'])
    expect(r.locations).toEqual(['19:44908822'])
    expect(r.study_accession_id).toBe('GCST90837533')
    expect(r.pubmed_id).toBe('41298473')
    expect(r.first_author).toBe('Koyama S')
    expect(r.efo_traits).toEqual([{ efo_id: 'HP_0003124', efo_trait: 'hypercholesterolemia' }])
    // or_value and beta are mutually exclusive: "-" becomes null.
    expect(r.or_value).toBe('0.76')
    expect(r.beta).toBeNull()
    expect(r.pvalue_description).toBeNull()
  })

  it('caps at max_records and flags truncation without over-fetching', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(assocPage([assoc(1, 1e-9), assoc(2, 2e-9)], 50, 'https://x/next'))
      )
    const out = (await run(
      'gwas_associations_for_variant',
      { rs_id: 'rs7412', max_records: 1 },
      fetchImpl
    )) as { returned: number; truncated: boolean; api_total: number }
    expect(out.returned).toBe(1)
    expect(out.api_total).toBe(50)
    expect(out.truncated).toBe(true)
    // Cap reached inside the first page — no follow-up request.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns zero rows (not an error) for a merged/retired rsID', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ _embedded: {}, _links: {}, page: { totalElements: 0 } }))
    const out = (await run(
      'gwas_associations_for_variant',
      { rs_id: 'rs00000zzz' },
      fetchImpl
    )) as { api_total: number; returned: number; truncated: boolean; associations: unknown[] }
    expect(out.api_total).toBe(0)
    expect(out.returned).toBe(0)
    expect(out.truncated).toBe(false)
    expect(out.associations).toEqual([])
  })
})

describe('gwas_associations_for_gene', () => {
  it('routes to the mapped_gene filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(assocPage([assoc(1, 1e-9)], 1)))
    const out = (await run('gwas_associations_for_gene', { gene_symbol: 'PCSK9' }, fetchImpl)) as {
      gene_symbol: string
      returned: number
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('mapped_gene=PCSK9')
    expect(out.gene_symbol).toBe('PCSK9')
    expect(out.returned).toBe(1)
  })
})

describe('gwas_associations_for_trait', () => {
  it('routes efo_id to the efo_id filter and echoes it', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(assocPage([assoc(1, 1e-9)], 1)))
    const out = (await run(
      'gwas_associations_for_trait',
      { efo_id: 'MONDO_0005010' },
      fetchImpl
    )) as { efo_id: string; returned: number }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('efo_id=MONDO_0005010')
    expect(out.efo_id).toBe('MONDO_0005010')
  })

  it('routes efo_trait (label) to the efo_trait filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(assocPage([], 0)))
    await run('gwas_associations_for_trait', { efo_trait: 'coronary artery disease' }, fetchImpl)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('efo_trait=coronary%20artery%20disease')
  })

  it('throws unless exactly one of efo_id/efo_trait is given', async () => {
    const fetchImpl = vi.fn()
    await expect(run('gwas_associations_for_trait', {}, fetchImpl)).rejects.toThrow(
      /exactly one of efo_id or efo_trait/
    )
    await expect(
      run('gwas_associations_for_trait', { efo_id: 'x', efo_trait: 'y' }, fetchImpl)
    ).rejects.toThrow(/exactly one of efo_id or efo_trait/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('gwas_search_traits', () => {
  it('searches efo-traits by substring, count-verifies, and sorts rows by label', async () => {
    const page = {
      _embedded: {
        efo_traits: [
          { efo_id: 'B', efo_trait: 'coronary atherosclerosis', uri: 'http://x/B' },
          { efo_id: 'A', efo_trait: 'coronary artery disorder', uri: 'http://x/A' }
        ]
      },
      _links: {},
      page: { totalElements: 2 }
    }
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(page))
    const out = (await run('gwas_search_traits', { query: 'coronary' }, fetchImpl)) as {
      api_total: number
      returned: number
      truncated: boolean
      efo_traits: Array<{ efo_id: string; efo_trait: string; uri: string }>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/v2/efo-traits?trait=coronary')
    expect(out.api_total).toBe(2)
    expect(out.returned).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.efo_traits.map((t) => t.efo_trait)).toEqual([
      'coronary artery disorder',
      'coronary atherosclerosis'
    ])
  })
})

describe('gwas_search_studies', () => {
  it('requires at least one filter', async () => {
    const fetchImpl = vi.fn()
    await expect(run('gwas_search_studies', {}, fetchImpl)).rejects.toThrow(/at least one filter/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('assembles the filter query and maps the lean study row (gxe/gxg kept separate)', async () => {
    const study = {
      accession_id: 'GCST90000001',
      disease_trait: 'coronary artery disease',
      efo_traits: [{ efo_id: 'MONDO_0005010', efo_trait: 'coronary artery disorder' }],
      bg_efo_traits: [],
      pubmed_id: '38714703',
      initial_sample_size: '100 cases',
      genotyping_technologies: ['Genome-wide genotyping array'],
      platforms: 'Illumina',
      full_summary_stats_available: true,
      imputed: true,
      gxg: false
    }
    const page = { _embedded: { studies: [study] }, _links: {}, page: { totalElements: 1 } }
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(page))
    const out = (await run('gwas_search_studies', { efo_id: 'MONDO_0005010' }, fetchImpl)) as {
      filters: Record<string, string>
      studies: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/v2/studies?efo_id=MONDO_0005010')
    expect(out.filters).toEqual({ efo_id: 'MONDO_0005010' })
    const s = out.studies[0]
    expect(s.accession_id).toBe('GCST90000001')
    expect(s.gxe).toBeNull()
    expect(s.gxg).toBe(false)
    expect(s.efo_traits).toEqual([
      { efo_id: 'MONDO_0005010', efo_trait: 'coronary artery disorder' }
    ])
  })
})

describe('gwas_get_study', () => {
  it('returns the study when found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ accession_id: 'GCST90841394', disease_trait: 'X' }))
    const out = (await run('gwas_get_study', { accession_id: 'GCST90841394' }, fetchImpl)) as {
      found: boolean
      study: Record<string, unknown> | null
    }
    expect(out.found).toBe(true)
    expect(out.study?.accession_id).toBe('GCST90841394')
  })

  it('maps an upstream 404 to found:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errRes(404))
    const out = (await run('gwas_get_study', { accession_id: 'GCST99999999' }, fetchImpl)) as {
      found: boolean
      study: null
    }
    expect(out.found).toBe(false)
    expect(out.study).toBeNull()
  })
})

describe('gwas_get_variant', () => {
  it('maps the variant record (locations projected to chromosome/position/region)', async () => {
    const variant = {
      rs_id: 'rs7412',
      merged: 0,
      functional_class: 'missense_variant',
      most_severe_consequence: 'missense_variant',
      alleles: 'C/T (forward)',
      mapped_genes: ['APOE'],
      locations: [
        { chromosome_name: '19', chromosome_position: 44908822, region: { name: '19q13.32' } }
      ],
      last_update_date: '2026-05-28T13:00:39.061+00:00'
    }
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(variant))
    const out = (await run('gwas_get_variant', { rs_id: 'rs7412' }, fetchImpl)) as {
      found: boolean
      variant: Record<string, unknown>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/v2/single-nucleotide-polymorphisms/rs7412'
    )
    expect(out.found).toBe(true)
    expect(out.variant.locations).toEqual([
      { chromosome: '19', position: 44908822, region: '19q13.32' }
    ])
  })

  it('maps an upstream 404 to found:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errRes(404))
    const out = (await run('gwas_get_variant', { rs_id: 'rs00000zzz' }, fetchImpl)) as {
      found: boolean
      variant: null
    }
    expect(out.found).toBe(false)
    expect(out.variant).toBeNull()
  })
})

describe('gwas_get_summary_statistics', () => {
  it('rejects an empty metadata selector while allowing omission and exact filenames', () => {
    const validate = new Ajv2020({ strict: true }).compile(
      tool('gwas_get_summary_statistics').input
    )
    expect(validate({ accession_id: 'GCST90000123', metadata_file: '' })).toBe(false)
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instancePath: '/metadata_file', keyword: 'minLength' })
      ])
    )
    expect(validate({ accession_id: 'GCST90000123' })).toBe(true)
    expect(
      validate({
        accession_id: 'GCST90000123',
        metadata_file: 'GCST90000123.h.tsv.gz-meta.yaml'
      })
    ).toBe(true)
  })

  it('derives the thousand-study FTP bucket, lists original/harmonised files and parses YAML', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/GCST90000123/')) {
        return Promise.resolve(
          textRes(`
            <a href="GCST90000123.tsv.gz">GCST90000123.tsv.gz</a>
            <a href="GCST90000123.tsv.gz-meta.yaml">GCST90000123.tsv.gz-meta.yaml</a>
            <a href="README.txt">README.txt</a>
            <a href="md5sum.txt">md5sum.txt</a>
            <a href="harmonised/">harmonised/</a>
          `)
        )
      }
      if (url.endsWith('/GCST90000123/harmonised/')) {
        return Promise.resolve(
          textRes(`
            <a href="GCST90000123.h.tsv.gz">GCST90000123.h.tsv.gz</a>
            <a href="GCST90000123.h.tsv.gz-meta.yaml">GCST90000123.h.tsv.gz-meta.yaml</a>
            <a href="GCST90000123.h.tsv.gz.tbi">GCST90000123.h.tsv.gz.tbi</a>
            <a href="report.txt">report.txt</a>
          `)
        )
      }
      if (url.endsWith('GCST90000123.tsv.gz-meta.yaml')) {
        return Promise.resolve(
          textRes(`gwas_id: GCST90000123\ngenome_assembly: GRCh37\nis_harmonised: false\n`)
        )
      }
      if (url.endsWith('GCST90000123.h.tsv.gz-meta.yaml')) {
        return Promise.resolve(
          textRes(
            `gwas_id: GCST90000123\ngenome_assembly: GRCh38\nis_harmonised: true\nharmonisation_reference: https://reference.example/GRCh38.fa\n`
          )
        )
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const out = (await run(
      'gwas_get_summary_statistics',
      { accession_id: 'GCST90000123' },
      fetchImpl
    )) as {
      found: boolean
      accession_id: string
      directory_url: string
      files: Array<{ name: string; scope: string; kind: string; url: string }>
      metadata: Array<{ scope: string; metadata: Record<string, unknown> }>
      reference_genomes: string[]
      harmonisation_references: string[]
      column_definitions: Array<{ name: string; required: boolean }>
      column_definitions_source: string
    }

    expect(out.found).toBe(true)
    expect(out.accession_id).toBe('GCST90000123')
    expect(out.directory_url).toBe(
      'https://ftp.ebi.ac.uk/pub/databases/gwas/summary_statistics/GCST90000001-GCST90001000/GCST90000123/'
    )
    expect(out.files.map((file) => `${file.scope}:${file.kind}:${file.name}`).sort()).toEqual(
      [
        'original:data:GCST90000123.tsv.gz',
        'original:metadata:GCST90000123.tsv.gz-meta.yaml',
        'original:readme:README.txt',
        'original:checksum:md5sum.txt',
        'harmonised:data:GCST90000123.h.tsv.gz',
        'harmonised:metadata:GCST90000123.h.tsv.gz-meta.yaml',
        'harmonised:index:GCST90000123.h.tsv.gz.tbi',
        'harmonised:other:report.txt'
      ].sort()
    )
    expect(out.metadata.map((entry) => entry.metadata.genome_assembly)).toEqual([
      'GRCh37',
      'GRCh38'
    ])
    expect(out.reference_genomes).toEqual(['GRCh37', 'GRCh38'])
    expect(out.harmonisation_references).toEqual(['https://reference.example/GRCh38.fa'])
    expect(out.column_definitions_source).toBe('GWAS-SSF standard')
    expect(out.column_definitions.find((column) => column.name === 'chromosome')?.required).toBe(
      true
    )
    expect(out.column_definitions.find((column) => column.name === 'beta')?.required).toBe(false)
  })

  it('rejects malformed accessions before making an upstream request', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('gwas_get_summary_statistics', { accession_id: '../GCST90000123' }, fetchImpl)
    ).rejects.toThrow(/accession_id must be a GWAS Catalog accession/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns found:false for an accession without an FTP directory', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(404))
    const out = (await run(
      'gwas_get_summary_statistics',
      { accession_id: 'GCST90000123' },
      fetchImpl
    )) as {
      found: boolean
      accession_id: string
      files: unknown[]
      metadata: unknown[]
      reference_genomes: unknown[]
    }
    expect(out).toMatchObject({
      found: false,
      accession_id: 'GCST90000123',
      files: [],
      metadata: [],
      reference_genomes: [],
      harmonisation_references: [],
      column_definitions: expect.arrayContaining([
        expect.objectContaining({ name: 'chromosome', required: true })
      ]),
      column_definitions_source: 'GWAS-SSF standard'
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('keeps original files when a stale harmonised directory link returns 404', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/GCST90000123/')) {
        return Promise.resolve(
          textRes(
            '<a href="GCST90000123.tsv.gz">raw</a><a href="GCST90000123.tsv.gz-meta.yaml">meta</a><a href="harmonised/">harmonised</a>'
          )
        )
      }
      if (url.endsWith('/harmonised/')) return Promise.resolve(errRes(404))
      if (url.endsWith('.yaml')) return Promise.resolve(textRes('genome_assembly: GRCh37\n'))
      throw new Error(`unexpected URL ${url}`)
    })
    const out = (await run(
      'gwas_get_summary_statistics',
      { accession_id: 'GCST90000123' },
      fetchImpl
    )) as {
      found: boolean
      files: Array<{ scope: string }>
    }
    expect(out.found).toBe(true)
    expect(out.files.every((file) => file.scope === 'original')).toBe(true)
  })

  it('filters metadata and reference summaries while retaining the complete file listing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        textRes(
          '<a href="raw.tsv.gz">raw</a><a href="raw-meta.yaml">meta</a><a href="harmonised/">harmonised</a>'
        )
      )
      .mockResolvedValueOnce(
        textRes('<a href="harm.h.tsv.gz">data</a><a href="harm-meta.yaml">meta</a>')
      )
      .mockResolvedValueOnce(
        textRes(
          'genome_assembly: GRCh38\nharmonisation_reference: https://reference.example/GRCh38.fa\n'
        )
      )
    const out = await run(
      'gwas_get_summary_statistics',
      { accession_id: 'GCST90000123', metadata_file: 'harm-meta.yaml' },
      fetchImpl
    )
    expect(out).toMatchObject({
      found: true,
      files: [
        { name: 'raw-meta.yaml', scope: 'original' },
        { name: 'raw.tsv.gz', scope: 'original' },
        { name: 'harm-meta.yaml', scope: 'harmonised' },
        { name: 'harm.h.tsv.gz', scope: 'harmonised' }
      ],
      metadata: [{ name: 'harm-meta.yaml', scope: 'harmonised' }],
      reference_genomes: ['GRCh38'],
      harmonisation_references: ['https://reference.example/GRCh38.fa']
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl).toHaveBeenLastCalledWith(
      expect.stringContaining('/harmonised/harm-meta.yaml'),
      expect.any(Object)
    )
  })

  it('rejects an unknown metadata filename without fetching any YAML', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        textRes('<a href="raw.tsv.gz">raw</a><a href="raw-meta.yaml">meta</a>')
      )
    await expect(
      run(
        'gwas_get_summary_statistics',
        { accession_id: 'GCST90000123', metadata_file: 'missing-meta.yaml' },
        fetchImpl
      )
    ).rejects.toThrow("No summary-statistics metadata file named 'missing-meta.yaml' was found.")
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('returns legacy files without inventing metadata or reference genomes', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes('<a href="old.txt.gz">data</a>'))
    const out = await run(
      'gwas_get_summary_statistics',
      { accession_id: 'GCST90000123' },
      fetchImpl
    )
    expect(out).toMatchObject({
      found: true,
      files: [{ name: 'old.txt.gz', scope: 'original' }],
      metadata: [],
      reference_genomes: [],
      harmonisation_references: []
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('propagates a metadata 404 instead of reporting the study directory as absent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes('<a href="raw-meta.yaml">meta</a>'))
      .mockResolvedValueOnce(errRes(404))
    await expect(
      run('gwas_get_summary_statistics', { accession_id: 'GCST90000123' }, fetchImpl)
    ).rejects.toThrow(/HTTP 404/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['malformed YAML', 'value: [', /unexpected end/],
    ['a YAML scalar', 'GRCh38', /is not a YAML object/],
    ['a YAML sequence', '- GRCh38', /is not a YAML object/]
  ])('rejects %s instead of returning a successful package', async (_name, yaml, error) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes('<a href="raw-meta.yaml">meta</a>'))
      .mockResolvedValueOnce(textRes(yaml as string))
    await expect(
      run('gwas_get_summary_statistics', { accession_id: 'GCST90000123' }, fetchImpl)
    ).rejects.toThrow(error)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('propagates a harmonised directory 403 instead of silently omitting its files', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        textRes('<a href="raw.tsv.gz">raw</a><a href="harmonised/">harmonised</a>')
      )
      .mockResolvedValueOnce(errRes(403))
    await expect(
      run('gwas_get_summary_statistics', { accession_id: 'GCST90000123' }, fetchImpl)
    ).rejects.toThrow(/HTTP 403/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
