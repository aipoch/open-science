import { describe, it, expect, vi, afterEach } from 'vitest'
import { ParserEngine } from '../engine'
import { REGULATION_TOOLS } from './regulation'
import type { ToolContext, ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => REGULATION_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const errRes = (status: number, body: unknown = {}): Response =>
  ({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => body
  }) as unknown as Response

// Single-response call helper: returns the parsed output plus the first request URL.
const call = (
  id: string,
  args: Record<string, unknown>,
  body: unknown
): Promise<{ out: unknown; url: string }> => {
  const fetchImpl = vi.fn().mockResolvedValue(jsonRes(body))
  return new ParserEngine({ fetchImpl })
    .call(tool(id), args, {})
    .then((out) => ({ out, url: fetchImpl.mock.calls[0][0] as string }))
}

// Multi-response call helper: hands each queued response to successive fetches; returns every URL.
const callSeq = (
  id: string,
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: unknown; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  return new ParserEngine({ fetchImpl })
    .call(tool(id), args, {})
    .then((out) => ({ out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }))
}

// ENCODE tools bypass ctx.fetchJson (they need a non-Mozilla User-Agent the portal accepts) and talk
// to the global fetch directly, so ENCODE tests stub the global fetch and invoke run() directly.
const ENCODE_CTX: ToolContext = {
  credentials: {},
  fetchJson: async () => {
    throw new Error('ENCODE tools must not use ctx.fetchJson')
  },
  fetchText: async () => {
    throw new Error('unused')
  },
  fetchJsonWithHeaders: async () => {
    throw new Error('unused')
  },
  postJson: async () => {
    throw new Error('unused')
  }
}
const encodeRun = async (
  id: string,
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: unknown; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  vi.stubGlobal('fetch', fetchImpl)
  const out = await tool(id).run!(ENCODE_CTX, args)
  return { out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('regulation / all 16 tools are registered', () => {
  it('exposes the exact ENCODE + JASPAR + UniBind tool ids', () => {
    expect(REGULATION_TOOLS.map((t) => t.id).sort()).toEqual(
      [
        'encode_search_experiments',
        'encode_search_biosamples',
        'encode_list_files',
        'encode_get_experiment',
        'encode_get_file',
        'encode_get_biosample',
        'jaspar_get_matrix',
        'jaspar_matrix_versions',
        'jaspar_list_matrices',
        'jaspar_list_species',
        'jaspar_list_taxa',
        'jaspar_list_collections',
        'jaspar_list_releases',
        'unibind_search_tfbs',
        'unibind_get_dataset',
        'unibind_tfbs_in_region'
      ].sort()
    )
  })

  it('every tool is on the regulation connector and carries returns + example', () => {
    for (const t of REGULATION_TOOLS) {
      expect(t.connector).toBe('regulation')
      expect(t.returns).toBeTruthy()
      expect(t.example).toBeTruthy()
    }
  })
})

describe('regulation / encode search', () => {
  const expRow = (accession: string, term: string): Record<string, unknown> => ({
    accession,
    assay_title: 'TF ChIP-seq',
    assay_term_name: 'ChIP-seq',
    target: { label: 'CTCF' },
    biosample_ontology: { term_name: term },
    status: 'released',
    date_released: '2012-09-10',
    lab: { title: 'Some Lab' }
  })

  it('walks /report/ across pages, count-verifies, and caps rows while keeping all accessions', async () => {
    // total=3, page size collapses to two mocked pages; max_rows=2 truncates the row list only.
    const { out, urls } = await encodeRun(
      'encode_search_experiments',
      { target: 'CTCF', assay_title: 'TF ChIP-seq', max_rows: 2 },
      [
        jsonRes({ total: 3, '@graph': [expRow('ENCSR003', 'A'), expRow('ENCSR001', 'B')] }),
        jsonRes({ total: 3, '@graph': [expRow('ENCSR002', 'C')] })
      ]
    )
    expect(urls[0]).toContain('https://www.encodeproject.org/report/?')
    expect(urls[0]).toContain('type=Experiment')
    expect(urls[0]).toContain('sort=accession')
    expect(urls[0]).toContain('target.label=CTCF')
    expect(urls[0]).toContain(encodeURIComponent('assay_title') + '=TF+ChIP-seq')
    expect(urls[0]).toContain('from=0')
    // second page requested at offset = rows collected so far (2).
    expect(urls[1]).toContain('from=2')
    const o = out as Record<string, unknown>
    expect(o.total).toBe(3)
    expect(o.returned).toBe(2)
    expect(o.truncated).toBe(true)
    // accessions are the FULL sorted match set, not the truncated rows.
    expect(o.accessions).toEqual(['ENCSR001', 'ENCSR002', 'ENCSR003'])
    expect((o.experiments as unknown[]).length).toBe(2)
  })

  it('applies status default, date window, and extra_filters', async () => {
    const { urls } = await encodeRun(
      'encode_search_experiments',
      {
        target: 'CTCF',
        date_released_before: '2013-01-01',
        extra_filters: { 'biosample_ontology.term_name': 'K562' }
      },
      [jsonRes({ total: 0, '@graph': [] })]
    )
    expect(urls[0]).toContain('status=released')
    // URLSearchParams encodes spaces as '+' inside the advancedQuery closed-window clause.
    expect(urls[0]).toContain('advancedQuery=date_released%3A%5B*+TO+2013-01-01%5D')
    expect(urls[0]).toContain('biosample_ontology.term_name=K562')
  })

  it('treats the zero-hit 404 as an empty, count-verified result', async () => {
    const { out } = await encodeRun('encode_search_experiments', { target: 'NOPE' }, [errRes(404)])
    expect(out).toEqual({
      total: 0,
      returned: 0,
      truncated: false,
      accessions: [],
      experiments: []
    })
  })

  it('raises when the walk does not converge to the reported total', async () => {
    await expect(
      encodeRun('encode_search_experiments', { target: 'X' }, [jsonRes({ total: 5, '@graph': [] })])
    ).rejects.toThrow(/pagination incomplete/)
  })

  it('encode_list_files sends assay_term_name (ontology term) as a filter param', async () => {
    const { urls } = await encodeRun(
      'encode_list_files',
      { file_format: 'bed', assay_term_name: 'ChIP-seq', biosample_term_name: 'K562' },
      [jsonRes({ total: 0, '@graph': [] })]
    )
    expect(urls[0]).toContain('file_format=bed')
    expect(urls[0]).toContain('assay_term_name=ChIP-seq')
    expect(urls[0]).toContain(encodeURIComponent('biosample_ontology.term_name') + '=K562')
  })
})

describe('regulation / encode get_* stable records', () => {
  it('encode_get_experiment builds the accession URL and extracts the stable record', async () => {
    const { out, urls } = await encodeRun('encode_get_experiment', { accession: 'ENCSR000AKP' }, [
      jsonRes({
        accession: 'ENCSR000AKP',
        status: 'released',
        assay_term_name: 'ChIP-seq',
        assay_title: 'Histone ChIP-seq',
        target: { label: 'H3K27ac', schema_version: '14' },
        biosample_ontology: { term_name: 'K562', classification: 'cell line' },
        biosample_summary: 'K562',
        description: 'desc',
        lab: { title: 'Bradley Bernstein, Broad' },
        award: { project: 'ENCODE' },
        date_released: '2011-05-05',
        date_submitted: '2010-12-17',
        assembly: ['hg19', 'GRCh38'],
        bio_replicate_count: 3,
        tech_replicate_count: 3,
        replication_type: 'isogenic',
        dbxrefs: ['GEO:GSM733656', 'SCREEN-GRCh38:K562'],
        doi: '10.17989/ENCSR000AKP',
        uuid: 'abc-123',
        audit: { WARNING: [] }
      })
    ])
    expect(urls[0]).toBe('https://www.encodeproject.org/ENCSR000AKP/?format=json')
    expect(out).toEqual({
      record_type: 'experiment',
      accession: 'ENCSR000AKP',
      status: 'released',
      assay_term_name: 'ChIP-seq',
      assay_title: 'Histone ChIP-seq',
      target_label: 'H3K27ac',
      biosample_term_name: 'K562',
      biosample_classification: 'cell line',
      biosample_summary: 'K562',
      description: 'desc',
      lab: 'Bradley Bernstein, Broad',
      award_project: 'ENCODE',
      date_released: '2011-05-05',
      date_submitted: '2010-12-17',
      assembly: ['GRCh38', 'hg19'],
      bio_replicate_count: 3,
      tech_replicate_count: 3,
      replication_type: 'isogenic',
      dbxrefs: ['GEO:GSM733656', 'SCREEN-GRCh38:K562'],
      doi: '10.17989/ENCSR000AKP',
      uuid: 'abc-123'
    })
    // volatile fields are dropped.
    expect((out as Record<string, unknown>).audit).toBeUndefined()
  })

  it('encode_get_file maps a file record', async () => {
    const { out } = await encodeRun('encode_get_file', { accession: 'ENCFF002JUR' }, [
      jsonRes({
        accession: 'ENCFF002JUR',
        status: 'released',
        file_format: 'bigWig',
        output_type: 'plus strand signal of all reads',
        assembly: 'GRCh38',
        dataset: '/experiments/ENCSR000AKP/',
        biological_replicates: [2, 1],
        md5sum: '64ce896ebc4ac35c5737d12ab56987a8',
        href: '/files/ENCFF002JUR/@@download/ENCFF002JUR.bigWig',
        uuid: 'file-uuid'
      })
    ])
    expect(out).toMatchObject({
      record_type: 'file',
      accession: 'ENCFF002JUR',
      file_format: 'bigWig',
      assembly: 'GRCh38',
      biological_replicates: [1, 2],
      href: '/files/ENCFF002JUR/@@download/ENCFF002JUR.bigWig'
    })
  })

  it('encode_get_biosample maps organism/donor and a bare @id source string', async () => {
    const { out } = await encodeRun('encode_get_biosample', { accession: 'ENCBS013JZP' }, [
      jsonRes({
        accession: 'ENCBS013JZP',
        status: 'released',
        biosample_ontology: { term_name: 'K562', classification: 'cell line' },
        organism: { scientific_name: 'Homo sapiens' },
        donor: { accession: 'ENCDO000AAD' },
        source: '/sources/atcc/',
        treatments: [{ treatment_term_name: 'DMSO' }],
        genetic_modifications: [{ '@id': '/genetic-modifications/x/' }],
        uuid: 'bio-uuid'
      })
    ])
    expect(out).toMatchObject({
      record_type: 'biosample',
      term_name: 'K562',
      classification: 'cell line',
      organism: 'Homo sapiens',
      donor: 'ENCDO000AAD',
      source: '/sources/atcc/',
      treatments: ['DMSO'],
      genetic_modifications: ['/genetic-modifications/x/']
    })
  })
})

describe('regulation / jaspar', () => {
  it('jaspar_get_matrix requires a versioned id and passes it through', async () => {
    const body = { matrix_id: 'MA0002.2', name: 'Runx1', pfm: { A: [1], C: [2], G: [3], T: [4] } }
    const { out, url } = await call('jaspar_get_matrix', { matrix_id: 'MA0002.2' }, body)
    expect(url).toBe('https://jaspar.elixir.no/api/v1/matrix/MA0002.2/')
    expect(out).toEqual(body)
  })

  it('jaspar_get_matrix rejects a base id (no version)', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('jaspar_get_matrix'), { matrix_id: 'MA0002' }, {})
    ).rejects.toThrow(/base id/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('jaspar_matrix_versions reduces a versioned id to its base and returns count+results', async () => {
    const results = [
      { matrix_id: 'MA0002.1', version: 1 },
      { matrix_id: 'MA0002.2', version: 2 }
    ]
    const { out, url } = await call(
      'jaspar_matrix_versions',
      { base_id: 'MA0002.2' },
      { count: 2, results, next: null }
    )
    expect(url).toBe('https://jaspar.elixir.no/api/v1/matrix/MA0002/versions/?page_size=1000')
    expect(out).toEqual({ count: 2, results })
  })

  it('jaspar_list_matrices walks the DRF next chain, count-verifies, and caps rows', async () => {
    const page1 = {
      count: 3,
      results: [{ matrix_id: 'MA1' }, { matrix_id: 'MA2' }],
      next: 'https://jaspar.elixir.no/api/v1/matrix/?page=2'
    }
    const page2 = { count: 3, results: [{ matrix_id: 'MA3' }], next: null }
    const { out, urls } = await callSeq(
      'jaspar_list_matrices',
      { tax_id: 9606, version: 'latest', max_rows: 2 },
      [jsonRes(page1), jsonRes(page2)]
    )
    expect(urls[0]).toContain('tax_id=9606')
    expect(urls[0]).toContain('version=latest')
    expect(urls[0]).toContain('page_size=1000')
    expect(urls[1]).toBe('https://jaspar.elixir.no/api/v1/matrix/?page=2')
    expect(out).toEqual({
      count: 3,
      returned: 2,
      truncated: true,
      matrices: [{ matrix_id: 'MA1' }, { matrix_id: 'MA2' }]
    })
  })

  it('jaspar_list_matrices raises when the walk row count != count', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ count: 9, results: [{ matrix_id: 'MA1' }], next: null }))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('jaspar_list_matrices'), {}, {})
    ).rejects.toThrow(/pagination walk/)
  })

  it('jaspar_list_species / taxa / collections / releases return count+results', async () => {
    const species = await call(
      'jaspar_list_species',
      {},
      { count: 1, results: [{ tax_id: '9606' }], next: null }
    )
    expect(species.url).toBe('https://jaspar.elixir.no/api/v1/species/?page_size=1000')
    expect(species.out).toEqual({ count: 1, results: [{ tax_id: '9606' }] })

    const taxa = await call(
      'jaspar_list_taxa',
      {},
      { count: 1, results: [{ name: 'vertebrates' }], next: null }
    )
    expect(taxa.url).toContain('/taxon/')

    const collections = await call(
      'jaspar_list_collections',
      {},
      { count: 1, results: [{ name: 'CORE' }], next: null }
    )
    expect(collections.url).toContain('/collections/')

    const releases = await call(
      'jaspar_list_releases',
      {},
      { count: 1, results: [{ release_number: 11 }], next: null }
    )
    expect(releases.url).toContain('/releases/')
  })
})

describe('regulation / unibind', () => {
  it('unibind_search_tfbs sends filters, derives tf_id, and flags truncation', async () => {
    const results = [
      {
        tf_name: 'CTCF',
        total_peaks: '57900',
        url: 'https://unibind.uio.no/api/v1/datasets/ENCSR000AUE.A549_lung_carcinoma.CTCF/'
      }
    ]
    const { out, url } = await call(
      'unibind_search_tfbs',
      { tf_name: 'CTCF', collection: 'Robust', max_rows: 1 },
      { count: 982, results, next: 'https://unibind.uio.no/api/v1/datasets/?page=2' }
    )
    expect(url).toContain('https://unibind.uio.no/api/v1/datasets/?')
    expect(url).toContain('tf_name=CTCF')
    expect(url).toContain('collection=Robust')
    expect(url).toContain('page_size=500')
    expect(out).toEqual({
      total: 982,
      returned: 1,
      truncated: true,
      datasets: [
        {
          tf_id: 'ENCSR000AUE.A549_lung_carcinoma.CTCF',
          tf_name: 'CTCF',
          total_peaks: '57900',
          identifier: 'ENCSR000AUE',
          cell_line: 'A549_lung_carcinoma'
        }
      ]
    })
  })

  it('unibind_get_dataset flattens per-model tfbs rows and file URLs', async () => {
    const { out, url } = await call(
      'unibind_get_dataset',
      { tf_id: 'ENCSR000AUE.A549_lung_carcinoma.CTCF' },
      {
        tf_id: 'ENCSR000AUE.A549_lung_carcinoma.CTCF',
        tf_name: 'CTCF',
        identifier: ['ENCSR000AUE', 'EXP011091'],
        cell_line: ['A549 (lung carcinoma)'],
        biological_condition: [],
        jaspar_id: ['MA0139.1'],
        prediction_models: ['DAMO'],
        total_peaks: 57900,
        tfbs: [
          {
            DAMO: [
              {
                jaspar_id: 'MA0139',
                jaspar_version: '1',
                total_tfbs: '50435',
                score_threshold: '77.7',
                distance_threshold: '92',
                adj_centrimo_pvalue: -89.66,
                bed_url: 'https://unibind.uio.no/x.bed',
                fasta_url: 'https://unibind.uio.no/x.fa'
              }
            ]
          }
        ]
      }
    )
    expect(url).toBe('https://unibind.uio.no/api/v1/datasets/ENCSR000AUE.A549_lung_carcinoma.CTCF/')
    expect(out).toMatchObject({
      tf_id: 'ENCSR000AUE.A549_lung_carcinoma.CTCF',
      tf_name: 'CTCF',
      identifiers: ['ENCSR000AUE', 'EXP011091'],
      jaspar_ids: ['MA0139.1'],
      total_peaks: 57900,
      n_models: 1,
      models: [
        {
          prediction_model: 'DAMO',
          jaspar_id: 'MA0139',
          total_tfbs: '50435',
          bed_url: 'https://unibind.uio.no/x.bed',
          fasta_url: 'https://unibind.uio.no/x.fa'
        }
      ]
    })
  })

  it('unibind_tfbs_in_region parses item names, honors the honest cap, and filters by tf_name', async () => {
    const { out, url } = await call(
      'unibind_tfbs_in_region',
      {
        genome: 'hg38',
        chrom: 'chr1',
        start: 1000000,
        end: 1010000,
        tf_name: 'E2F1',
        max_sites: 5
      },
      {
        UniBind: [
          {
            chrom: 'chr1',
            chromStart: 1000003,
            chromEnd: 1000015,
            strand: '-',
            name: 'ENCSR000EVJ_HeLa-S3_E2F1_MA0024.3'
          },
          {
            chrom: 'chr1',
            chromStart: 1000100,
            chromEnd: 1000112,
            strand: '+',
            name: 'ENCSR111AAA_K562_CTCF_MA0139.1'
          }
        ],
        maxItemsLimit: true
      }
    )
    expect(url).toContain('https://api.genome.ucsc.edu/getData/track?')
    expect(url).toContain('track=UniBind')
    expect(url).toContain('genome=hg38')
    expect(url).toContain('maxItemsOutput=20000')
    expect(url).toContain(encodeURIComponent('UniBind_hubs_Robust'))
    const o = out as Record<string, unknown>
    expect(o.items_scanned).toBe(2)
    // maxItemsLimit true -> scan not complete -> truncated true even under the site cap.
    expect(o.region_scan_complete).toBe(false)
    expect(o.truncated).toBe(true)
    expect(o.n_matching).toBe(1)
    expect(o.sites).toEqual([
      {
        chrom: 'chr1',
        start: 1000003,
        end: 1000015,
        strand: '-',
        dataset: 'ENCSR000EVJ',
        cell_line: 'HeLa-S3',
        tf_name: 'E2F1',
        jaspar_matrix: 'MA0024.3'
      }
    ])
  })

  it('unibind_tfbs_in_region rejects an out-of-hub genome and an over-wide span', async () => {
    const fetchImpl = vi.fn()
    const engine = new ParserEngine({ fetchImpl })
    await expect(
      engine.call(
        tool('unibind_tfbs_in_region'),
        { genome: 'hg19', chrom: 'chr1', start: 0, end: 10 },
        {}
      )
    ).rejects.toThrow(/not in the UniBind/)
    await expect(
      engine.call(
        tool('unibind_tfbs_in_region'),
        { genome: 'hg38', chrom: 'chr1', start: 0, end: 2_000_000 },
        {}
      )
    ).rejects.toThrow(/exceeds the/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
