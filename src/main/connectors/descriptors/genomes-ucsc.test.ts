import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENOMES_UCSC_TOOLS } from './genomes-ucsc'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): (typeof GENOMES_UCSC_TOOLS)[number] => {
  const t = GENOMES_UCSC_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch }).call(tool(id), args, {})

// A nested /list/tracks response: one composite (with child leaves) + two plain leaves. The genome
// key is unique per test so the module-level cache never crosses test boundaries.
const tracksBody = (genome: string): Record<string, unknown> => ({
  [genome]: {
    refSeqComposite: {
      shortLabel: 'NCBI RefSeq',
      longLabel: 'RefSeq genes composite',
      type: 'genePred',
      compositeContainer: 'TRUE',
      group: 'genes',
      // Two nested leaf tracks — the queryable ones.
      ncbiRefSeq: {
        shortLabel: 'RefSeq All',
        longLabel: 'NCBI RefSeq all',
        type: 'bigBed',
        parent: 'refSeqComposite'
      },
      ncbiRefSeqCurated: {
        shortLabel: 'RefSeq Curated',
        longLabel: 'NCBI RefSeq curated',
        type: 'bigBed',
        parent: 'refSeqComposite'
      }
    },
    phyloP100way: {
      shortLabel: 'Cons 100 phyloP',
      longLabel: '100 vertebrates Basewise Conservation by PhyloP',
      type: 'wig',
      group: 'compGeno'
    },
    augustusGene: {
      shortLabel: 'AUGUSTUS',
      longLabel: 'AUGUSTUS ab initio predictions',
      type: 'genePred',
      group: 'genes'
    }
  }
})

describe('ucsc_list_tracks', () => {
  it('flattens composites to leaf tracks, sorts by name, and reports counts', async () => {
    const genome = 'testFlatten1'
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(tracksBody(genome)))
    const out = (await run('ucsc_list_tracks', { genome }, fetchImpl)) as {
      n_total: number
      tracks_truncated: boolean
      tracks: Array<{ track: string; short_label: unknown; parent: unknown; group: unknown }>
    }
    // The composite container itself is dropped; its two children + the two plain leaves remain.
    expect(out.n_total).toBe(4)
    expect(out.tracks.map((t) => t.track)).toEqual([
      'augustusGene',
      'ncbiRefSeq',
      'ncbiRefSeqCurated',
      'phyloP100way'
    ])
    expect(out.tracks_truncated).toBe(false)
    const refseq = out.tracks.find((t) => t.track === 'ncbiRefSeq')!
    expect(refseq.short_label).toBe('RefSeq All')
    expect(refseq.parent).toBe('refSeqComposite')
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain(`/list/tracks?genome=${genome}`)
  })

  it('caches the listing per genome (module-level Map) — second call does not re-fetch', async () => {
    const genome = 'testCache1'
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(tracksBody(genome)))
    await run('ucsc_list_tracks', { genome }, fetchImpl)
    await run('ucsc_list_tracks', { genome, filter_text: 'refseq' }, fetchImpl)
    // Only the first call hits the network; the second is served from cache.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('filters case-insensitively over name/short/long label and caps at max_tracks', async () => {
    const genome = 'testFilter1'
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(tracksBody(genome)))
    const out = (await run(
      'ucsc_list_tracks',
      { genome, filter_text: 'PHYLOP', max_tracks: 1 },
      fetchImpl
    )) as { n_total: number; tracks_truncated: boolean; tracks: Array<{ track: string }> }
    // "phyloP" matches the phyloP100way long label only.
    expect(out.n_total).toBe(1)
    expect(out.tracks).toHaveLength(1)
    expect(out.tracks[0].track).toBe('phyloP100way')
    expect(out.tracks_truncated).toBe(false)

    const out2 = (await run(
      'ucsc_list_tracks',
      { genome, filter_text: 'refseq', max_tracks: 1 },
      fetchImpl
    )) as { n_total: number; tracks_truncated: boolean; tracks: Array<{ track: string }> }
    expect(out2.n_total).toBe(2)
    expect(out2.tracks).toHaveLength(1)
    expect(out2.tracks_truncated).toBe(true)
  })
})

describe('ucsc_track_data', () => {
  it('passes rows through under the track key and assembles the getData URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        trackType: 'genePred',
        track: 'knownGene',
        cpgIslandExt: undefined,
        knownGene: [
          { chrom: 'chr7', chromStart: 100, chromEnd: 200, name: 'g1' },
          { chrom: 'chr7', chromStart: 300, chromEnd: 400, name: 'g2' }
        ],
        itemsReturned: 2
      })
    )
    const out = (await run(
      'ucsc_track_data',
      { track: 'knownGene', chrom: 'chr7', start: 50, end: 500, max_rows: 10 },
      fetchImpl
    )) as {
      track_type: string
      items_returned: number
      truncated: boolean
      rows: unknown[]
      dataDownloadUrl?: string
    }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/getData/track?genome=hg38;track=knownGene;chrom=chr7;')
    expect(url).toContain('start=50;end=500;maxItemsOutput=10')
    expect(out.track_type).toBe('genePred')
    expect(out.items_returned).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.rows).toHaveLength(2)
    expect(out.dataDownloadUrl).toBeUndefined()
  })

  it('reflects the maxItemsLimit truncation flag and echoes dataDownloadUrl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        trackType: 'factorSource',
        maxItemsLimit: true,
        dataDownloadUrl: 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/x.bb',
        clinvarMain: [{ chrom: 'chr7', chromStart: 1, chromEnd: 2, name: 'v' }]
      })
    )
    const out = (await run(
      'ucsc_track_data',
      { track: 'clinvarMain', chrom: 'chr7', start: 0, end: 100 },
      fetchImpl
    )) as { truncated: boolean; dataDownloadUrl?: string; items_returned: number }
    expect(out.truncated).toBe(true)
    expect(out.dataDownloadUrl).toBe('https://hgdownload.soe.ucsc.edu/gbdb/hg38/x.bb')
    expect(out.items_returned).toBe(1)
  })

  it('propagates an unknown-track upstream 400 as an error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, json: async () => ({}) } as Response)
    await expect(
      run('ucsc_track_data', { track: 'nope', chrom: 'chr7', start: 0, end: 10 }, fetchImpl)
    ).rejects.toThrow(/HTTP 400/)
  })
})

describe('ucsc_conservation', () => {
  it('computes base-span-weighted stats clipped to the window with coverage fraction', async () => {
    // Window [100,110): row A covers [100,102) val 4, row B [105,107) val 2, row C [108,112) val 6
    // (clipped to [108,110) = 2 bp). Covered = 2+2+2 = 6 bp of 10; mean = (4*2+2*2+6*2)/6 = 4.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        trackType: 'wig -20 7.5',
        phyloP100way: [
          { chrom: 'chr7', start: 100, end: 102, value: 4 },
          { chrom: 'chr7', start: 105, end: 107, value: 2 },
          { chrom: 'chr7', start: 108, end: 112, value: 6 }
        ]
      })
    )
    const out = (await run(
      'ucsc_conservation',
      { chrom: 'chr7', start: 100, end: 110, include_values: true },
      fetchImpl
    )) as {
      span_bp: number
      n_bases_covered: number
      coverage_fraction: number
      mean: number
      min: number
      max: number
      values: unknown[]
      values_truncated: boolean
    }
    expect(out.span_bp).toBe(10)
    expect(out.n_bases_covered).toBe(6)
    expect(out.coverage_fraction).toBeCloseTo(0.6, 6)
    expect(out.mean).toBeCloseTo(4, 6)
    expect(out.min).toBe(2)
    expect(out.max).toBe(6)
    expect(out.values).toHaveLength(3)
    expect(out.values_truncated).toBe(false)
    // Default conservation track drives the getData URL.
    expect(String(fetchImpl.mock.calls[0][0])).toContain('track=phyloP100way')
  })

  it('throws when the span exceeds the 100kb cap (no fetch)', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('ucsc_conservation', { chrom: 'chr7', start: 0, end: 200000 }, fetchImpl)
    ).rejects.toThrow(/exceeds the 100000 bp cap/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('raises on a non-score (BED-like) track', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        trackType: 'bed',
        knownGene: [{ chrom: 'chr7', chromStart: 100, chromEnd: 200, name: 'g1' }]
      })
    )
    await expect(
      run(
        'ucsc_conservation',
        { chrom: 'chr7', start: 100, end: 200, track: 'knownGene' },
        fetchImpl
      )
    ).rejects.toThrow(/not a score\/wiggle track/)
  })

  it('raises when the upstream row list is itself truncated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        trackType: 'wig',
        maxItemsLimit: true,
        phyloP100way: [{ chrom: 'chr7', start: 100, end: 101, value: 1 }]
      })
    )
    await expect(
      run('ucsc_conservation', { chrom: 'chr7', start: 100, end: 200 }, fetchImpl)
    ).rejects.toThrow(/upstream truncated/)
  })
})

describe('ucsc_tfbs_clusters', () => {
  it('selects the hg38 track, sorts clusters, and dedups factors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        trackType: 'factorSource',
        encRegTfbsClustered: [
          {
            chrom: 'chr7',
            chromStart: 300,
            chromEnd: 400,
            name: 'MAFK',
            score: 296,
            sourceCount: 3
          },
          {
            chrom: 'chr7',
            chromStart: 100,
            chromEnd: 200,
            name: 'CTCF',
            score: 500,
            sourceCount: 5
          },
          {
            chrom: 'chr7',
            chromStart: 100,
            chromEnd: 250,
            name: 'CTCF',
            score: 480,
            sourceCount: 4
          }
        ]
      })
    )
    const out = (await run(
      'ucsc_tfbs_clusters',
      { chrom: 'chr7', start: 0, end: 1000, genome: 'hg38' },
      fetchImpl
    )) as {
      track: string
      items_returned: number
      n_factors: number
      factors: string[]
      clusters: Array<{ name: string; chromStart: number }>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('track=encRegTfbsClustered')
    expect(out.track).toBe('encRegTfbsClustered')
    expect(out.items_returned).toBe(3)
    // Sorted by (chromStart, name): the two chr7:100 CTCF rows first, then MAFK at 300.
    expect(out.clusters.map((c) => c.chromStart)).toEqual([100, 100, 300])
    expect(out.factors).toEqual(['CTCF', 'MAFK'])
    expect(out.n_factors).toBe(2)
  })

  it('picks the hg19 track name', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ trackType: 'factorSource', wgEncodeRegTfbsClusteredV3: [] }))
    const out = (await run(
      'ucsc_tfbs_clusters',
      { chrom: 'chr7', start: 0, end: 100, genome: 'hg19' },
      fetchImpl
    )) as { track: string }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('track=wgEncodeRegTfbsClusteredV3')
    expect(out.track).toBe('wgEncodeRegTfbsClusteredV3')
  })

  it('raises for an assembly without an ENCODE TFBS-cluster track (no fetch)', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('ucsc_tfbs_clusters', { chrom: 'chr1', start: 0, end: 100, genome: 'mm39' }, fetchImpl)
    ).rejects.toThrow(/no ENCODE TFBS-cluster track/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ucsc_chrom_sizes', () => {
  it('sorts chromosomes by size descending and echoes the assembly-wide chrom_count', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        chromCount: 5,
        chromosomes: {
          chr1: 248956422,
          chr2: 242193529,
          chrM: 16569,
          chrUn_x: 970,
          chrX: 156040895
        }
      })
    )
    const out = (await run('ucsc_chrom_sizes', { genome: 'hg38' }, fetchImpl)) as {
      chrom_count: number
      n_total: number
      chroms_truncated: boolean
      chromosomes: Array<{ name: string; size_bp: number }>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/list/chromosomes?genome=hg38')
    expect(out.chrom_count).toBe(5)
    expect(out.n_total).toBe(5)
    expect(out.chroms_truncated).toBe(false)
    expect(out.chromosomes.map((c) => c.name)).toEqual(['chr1', 'chr2', 'chrX', 'chrM', 'chrUn_x'])
    expect(out.chromosomes[0].size_bp).toBe(248956422)
  })

  it('filters by name substring and caps at max_chroms while chrom_count stays assembly-wide', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        chromCount: 4,
        chromosomes: { chr1: 1000, chr11: 900, chr2: 800, chrX: 700 }
      })
    )
    const out = (await run(
      'ucsc_chrom_sizes',
      { genome: 'hg38', filter_text: 'chr1', max_chroms: 1 },
      fetchImpl
    )) as {
      chrom_count: number
      n_total: number
      chroms_truncated: boolean
      chromosomes: Array<{ name: string }>
    }
    // chr1 and chr11 match; chrom_count remains the assembly-wide 4.
    expect(out.chrom_count).toBe(4)
    expect(out.n_total).toBe(2)
    expect(out.chromosomes).toHaveLength(1)
    expect(out.chromosomes[0].name).toBe('chr1')
    expect(out.chroms_truncated).toBe(true)
  })
})
