import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { abortableDelay, ParserEngine } from '@aipoch/connector-core'
import { HUMANGENETICS_EQTL_TOOLS } from './humangenetics-eqtl'

// Exercise real engine dispatch, HTTP byte ranges, TBI virtual offsets and BGZF/CRC decoding.
// Advance admission time without sleeping or firing the engine's whole-call deadline.
vi.mock('@aipoch/connector-core', async (original) => ({
  ...(await original<typeof import('@aipoch/connector-core')>()),
  abortableDelay: vi.fn(async (ms: number, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    vi.setSystemTime(Date.now() + ms)
  })
}))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const fields = [
  'study_id',
  'dataset_id',
  'study_label',
  'sample_group',
  'tissue_id',
  'tissue_label',
  'condition_label',
  'sample_size',
  'quant_method',
  'ftp_path'
]
const dataset = (id = 'QTD000021', quant = 'ge'): string[] => [
  'QTS000002',
  id,
  'BLUEPRINT',
  'monocyte',
  'CL_0002057',
  'monocyte',
  'naive',
  '191',
  quant,
  `ftp://ftp.ebi.ac.uk/pub/databases/spot/eQTL/sumstats/QTS000002/${id}/${id}.${quant === 'ge' ? 'all' : 'cc'}.tsv.gz`
]
const manifest = (rows = [dataset()]): string =>
  [fields.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n') + '\n'
const columns = [
  'molecular_trait_id',
  'chromosome',
  'position',
  'ref',
  'alt',
  'variant',
  'ma_samples',
  'maf',
  'pvalue',
  'beta',
  'se',
  'type',
  'ac',
  'an',
  'r2',
  'molecular_trait_object_id',
  'gene_id',
  'median_tpm',
  'rsid'
]
const gene = 'ENSG00000130203'
const row = (overrides: Record<string, string> = {}): string => {
  const values: Record<string, string> = {
    molecular_trait_id: gene,
    gene_id: gene,
    chromosome: '20',
    position: '46120612',
    ref: 'C',
    alt: 'T',
    variant: 'chr20_46120612_C_T',
    ma_samples: '20',
    maf: '0.1',
    pvalue: '1e-8',
    beta: '-0.5',
    se: '0.1',
    type: 'SNP',
    ac: '21',
    an: '382',
    r2: 'NA',
    molecular_trait_object_id: gene,
    median_tpm: '5',
    rsid: 'rs4239702',
    ...overrides
  }
  return columns.map((c) => values[c]).join('\t')
}
function bgzf(text: string | Buffer): Buffer {
  const gzip = gzipSync(text)
  const header = Buffer.from([31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0, 0, 0])
  header.writeUInt16LE(header.length + gzip.length - 10 - 1, 16)
  return Buffer.concat([header, gzip.subarray(10)])
}
const i32 = (value: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(value)
  return b
}
const u64 = (value: bigint): Buffer => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(value)
  return b
}
function fixture(
  rows = [row()],
  options: {
    split?: boolean
    duplicateChunks?: boolean
    badIndex?: boolean
    startByte?: number
    endByte?: number
    bin?: number
    largeChunk?: boolean
    badCrc?: boolean
    oversizedBlock?: boolean
    inflationBomb?: boolean
    swappedCoordinates?: boolean
    invalidUtf8?: boolean
    invalidIndexUtf8?: boolean
  } = {}
): { data: Buffer; index: Buffer; headerLength: number } {
  const headerColumns = [...columns]
  if (options.swappedCoordinates)
    [headerColumns[1], headerColumns[2]] = [headerColumns[2], headerColumns[1]]
  const header = bgzf(
    headerColumns.join('\t') + '\r\n' + (options.oversizedBlock ? 'x'.repeat(65536) : '')
  )
  const text =
    rows
      .map((line) => {
        const values = line.split('\t')
        if (options.swappedCoordinates) [values[1], values[2]] = [values[2], values[1]]
        return values.join('\t')
      })
      .join('\r\n') + '\r\n'
  const body = Buffer.from(text)
  if (options.invalidUtf8) body[body.lastIndexOf(gene)] = 255
  const split = options.split ? Math.floor(text.length / 2) : text.length
  const blocks = options.inflationBomb
    ? Array.from({ length: 1030 }, () => bgzf(text.repeat(Math.floor(65536 / text.length))))
    : [bgzf(body.subarray(0, split)), ...(split < body.length ? [bgzf(body.subarray(split))] : [])]
  const data = Buffer.concat([header, ...blocks])
  if (options.badCrc) data[data.length - 5] ^= 1
  const start = (BigInt(header.length) << 16n) + BigInt(options.startByte ?? 0)
  const end = options.largeChunk
    ? BigInt(20 * 1024 * 1024) << 16n
    : options.endByte === undefined
      ? BigInt(data.length) << 16n
      : (BigInt(header.length) << 16n) + BigInt(options.endByte)
  const chunks = options.duplicateChunks ? 2 : 1
  const reference = options.swappedCoordinates ? '46120612' : '20'
  const referenceBytes = Buffer.from(reference + '\0')
  if (options.invalidIndexUtf8) referenceBytes[1] = 255
  const index = gzipSync(
    Buffer.concat([
      Buffer.from('TBI\x01'),
      ...[1, 0, options.badIndex ? 1 : 2, 3, 3, 35, 1, reference.length + 1].map(i32),
      referenceBytes,
      i32(1),
      i32(
        options.bin ??
          (options.swappedCoordinates ? 4681 : 4681 + Math.floor((46120612 - 1) / 16384))
      ),
      i32(chunks),
      ...Array.from({ length: chunks }, () => [u64(start), u64(end)]).flat(),
      i32(0)
    ])
  )
  return { data, index, headerLength: header.length }
}
function server(
  rows = [row()],
  options: Parameters<typeof fixture>[1] & {
    manifest?: string
    mutateRange?: (response: Response, call: number) => Response
  } = {}
): { fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>; files: ReturnType<typeof fixture> } {
  const files = fixture(rows, options)
  let ranges = 0
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('raw.githubusercontent.com'))
      return new Response(options.manifest ?? manifest())
    if (url.endsWith('.tbi')) return new Response(Uint8Array.from(files.index))
    const range = new Headers(init?.headers).get('range')
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
    if (!m) throw new Error(`Missing range: ${url}`)
    const from = Number(m[1]),
      to = Math.min(Number(m[2]), files.data.length - 1)
    const response = new Response(Uint8Array.from(files.data.subarray(from, to + 1)), {
      status: 206,
      headers: { 'content-range': `bytes ${from}-${to}/${files.data.length}`, etag: '"fixture-v1"' }
    })
    return options.mutateRange ? options.mutateRange(response, ++ranges) : response
  })
  return { fetchImpl, files }
}
type Result = {
  total: number
  returned: number
  truncated: boolean
  datasets: Array<Record<string, unknown>>
  associations: Array<Record<string, unknown>>
  reference_data: Record<string, unknown>
  region: { chrom: string; start: number; end: number }
  coordinate_source: string
}
const run = (
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>,
  id = 'eqtl_associations',
  signal?: AbortSignal
): Promise<Result> =>
  new ParserEngine({ fetchImpl: fetchImpl as typeof fetch, retries: 0 }).call(
    HUMANGENETICS_EQTL_TOOLS.find((t) => t.id === id)!,
    args,
    {},
    signal
  ) as Promise<Result>
const query = {
  dataset_id: 'QTD000021',
  genome_build: 'GRCh38',
  pos: '20:46120612-46120613'
}

describe('official eQTL file catalogue', () => {
  it('uses one pinned official manifest, exact filters, numeric metadata and real HTTPS paths', async () => {
    const { fetchImpl } = server([], {
      manifest: manifest([dataset('QTD000022', 'exon'), dataset()])
    })
    const out = await run(
      { study_label: 'BLUEPRINT', quant_method: 'ge' },
      fetchImpl,
      'eqtl_list_datasets'
    )
    expect(out).toMatchObject({
      filters: { study_label: 'BLUEPRINT', quant_method: 'ge' },
      total: 1,
      returned: 1,
      truncated: false,
      datasets: [
        {
          dataset_id: 'QTD000021',
          sample_size: 191,
          file_url: expect.stringContaining('/QTD000021.all.tsv.gz')
        }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/7a5b65b8c2eb54bc7432825f265a449f604f906b/tabix/tabix_ftp_paths.tsv'
    )
    expect(out.reference_data).toMatchObject({ catalogue_release: '7', genome_build: 'GRCh38' })
  })
  it.each([1, 2])(
    'counts filtered rows before capping and proves exact-cap exhaustion (%i)',
    async (max_records) => {
      const { fetchImpl } = server([], {
        manifest: manifest([dataset('QTD000022', 'exon'), dataset()])
      })
      const out = await run({ max_records }, fetchImpl, 'eqtl_list_datasets')
      expect(out.total).toBe(2)
      expect(out.returned).toBe(max_records)
      expect(out.truncated).toBe(max_records === 1)
      expect(out.datasets[0].dataset_id).toBe('QTD000021')
    }
  )
  it('returns a proven empty selection for a valid manifest', async () => {
    const { fetchImpl } = server()
    expect(await run({ tissue_label: 'unknown' }, fetchImpl, 'eqtl_list_datasets')).toMatchObject({
      total: 0,
      returned: 0,
      truncated: false,
      datasets: []
    })
  })
  it.each([
    '<html>unavailable</html>',
    manifest([dataset(), dataset()]),
    manifest([
      dataset().map((v, i) => (i === 9 ? 'https://evil.example/QTD000021.all.tsv.gz' : v))
    ]),
    manifest([dataset().map((v, i) => (i === 7 ? 'NA' : v))]),
    manifest().replace('ftp_path', 'renamed_path'),
    manifest().replace('QTD000021.all', 'QTD000099.all'),
    fields.join('\t') + '\n'
  ])('fails closed on malformed or unsafe metadata', async (body) => {
    const { fetchImpl } = server([], { manifest: body })
    await expect(run({}, fetchImpl, 'eqtl_list_datasets')).rejects.toThrow(/eQTL/)
  })
})

describe('eQTL indexed association queries', () => {
  it.each([undefined, null, 'GRCh37', 'GRCh39', 38])(
    'rejects missing or unsupported genome_build before network access: %j',
    async (genome_build) => {
      const { fetchImpl } = server()
      await expect(run({ ...query, genome_build }, fetchImpl)).rejects.toThrow(
        genome_build === 'GRCh37' ? /liftover_variant.*unique GRCh38/ : /genome_build/
      )
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )
  it('requires explicit coordinates instead of silently losing an old-annotation cis boundary', async () => {
    // Same stable gene ID; historical TSS=46120611, current Ensembl TSS=46120612.
    // The historical -1 Mb boundary is one base outside the inferred current window.
    const { fetchImpl } = server([row({ position: '45120611', variant: 'chr20_45120611_C_T' })], {
      bin: 4681 + Math.floor((45120611 - 1) / 16384)
    })
    await expect(
      run({ dataset_id: query.dataset_id, genome_build: 'GRCh38', gene_id: gene }, fetchImpl)
    ).rejects.toThrow(/explicit GRCh38/)
    expect(fetchImpl).not.toHaveBeenCalled()
    const explicit = await run({ ...query, pos: '20:45120611-45120611', gene_id: gene }, fetchImpl)
    expect(explicit.returned).toBe(1)
  })

  it('reads real BGZF/TBI layout with 1-based inclusive boundaries, null NA and exact filters', async () => {
    const { fetchImpl } = server([
      row({ position: '46120611' }),
      row(),
      row({ gene_id: 'ENSG00000100001' }),
      row({ position: '46120613', variant: 'chr20_46120613_C_T' }),
      row({ position: '46120614' })
    ])
    const out = await run({ ...query, gene_id: gene, nlog10p_min: 8 }, fetchImpl)
    expect(out).toMatchObject({
      returned: 2,
      truncated: false,
      region: { chrom: '20', start: 46120612, end: 46120613 },
      coordinate_source: 'caller_GRCh38',
      filters: { gene_id: gene, pos: query.pos, nlog10p_min: 8 }
    })
    expect(out.associations[0]).toMatchObject({
      pvalue: 1e-8,
      pvalue_text: '1e-8',
      nlog10p: 8,
      beta: -0.5,
      se: 0.1,
      ac: 21,
      an: 382,
      r2: null,
      rsid: 'rs4239702'
    })
    expect(out.reference_data.statistics_scope).toBe('full_nominal')
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/eqtl/api/'))).toBe(false)
    expect(new Headers(fetchImpl.mock.calls.at(-1)?.[1]?.headers).get('if-range')).toBe(
      '"fixture-v1"'
    )
  })
  it('reassembles a row crossing BGZF blocks and merges duplicate index chunks', async () => {
    const { fetchImpl } = server([row(), row({ pvalue: '1e-400' })], {
      split: true,
      duplicateChunks: true
    })
    const out = await run({ ...query, nlog10p_min: 300 }, fetchImpl)
    expect(out).toMatchObject({
      returned: 1,
      truncated: false,
      associations: [{ pvalue: 0, pvalue_text: '1e-400', nlog10p: 400 }]
    })
  })
  it.each([1, 2, 3])(
    'checks one extra matching row to prove truncation at cap %i',
    async (max_records) => {
      const { fetchImpl } = server([row(), row()])
      const out = await run({ ...query, max_records }, fetchImpl)
      expect(out.returned).toBe(Math.min(max_records, 2))
      expect(out.truncated).toBe(max_records === 1)
    }
  )
  it('uses the catalogue .cc URL and identifies its filtered statistics', async () => {
    const { fetchImpl } = server([row()], { manifest: manifest([dataset('QTD000022', 'exon')]) })
    const out = await run({ ...query, dataset_id: 'QTD000022' }, fetchImpl)
    expect(out.reference_data).toMatchObject({
      statistics_scope: 'filtered',
      file_url: expect.stringContaining('QTD000022.cc.tsv.gz')
    })
  })
  it.each([{ gene_id: gene }, { rsid: 'rs4239702' }])(
    'requires coordinates for identifier filters: %j',
    async (filters) => {
      const fetchImpl = vi.fn()
      await expect(
        run({ dataset_id: query.dataset_id, genome_build: 'GRCh38', ...filters }, fetchImpl)
      ).rejects.toThrow(/explicit GRCh38/)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )
  it('uses an explicit variant coordinate without an Ensembl dependency', async () => {
    const { fetchImpl } = server()
    expect(
      await run(
        { dataset_id: query.dataset_id, genome_build: 'GRCh38', variant: 'chr20_46120612_C_T' },
        fetchImpl
      )
    ).toMatchObject({ returned: 1 })
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('ensembl'))).toBe(false)
  })
  it('returns no matches only after reading valid, complete data', async () => {
    const { fetchImpl } = server([row({ pvalue: '1' })])
    expect(await run({ ...query, nlog10p_min: 1 }, fetchImpl)).toMatchObject({
      returned: 0,
      truncated: false,
      associations: []
    })
  })
  it.each([
    {},
    { ...query, dataset_id: '../bad' },
    { dataset_id: query.dataset_id, genome_build: 'GRCh38' },
    { ...query, pos: '20:0-1' },
    { ...query, pos: '20:1-5000001' },
    { ...query, pos: '20:2-1' },
    { ...query, max_records: 0 },
    { ...query, max_records: 1001 },
    { ...query, max_records: 1.5 },
    { ...query, nlog10p_min: -1 },
    { ...query, nlog10p_min: NaN },
    { ...query, nlog10p_min: Infinity },
    { ...query, rsid: 'rs1/../../' },
    { ...query, gene_id: 'ENSG00000130203.1' },
    { ...query, variant: 'not_a_variant' },
    { ...query, variant: 'chr20_0_C_T' },
    { ...query, variant: 'chr20_999999999999999999_C_T' }
  ])('validates arguments before network access: %j', async (args) => {
    const fetchImpl = vi.fn()
    await expect(run(args, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('rejects unknown dataset IDs without guessing a data URL', async () => {
    const { fetchImpl } = server()
    await expect(run({ ...query, dataset_id: 'QTD999999' }, fetchImpl)).rejects.toThrow(
      /not in the pinned/
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it.each([400, 404, 410, 429, 500])(
    'retains upstream file failures (%i) as errors, never empty results',
    async (status) => {
      const { fetchImpl } = server()
      const actual = fetchImpl.getMockImplementation()!
      fetchImpl.mockImplementation((url, init) =>
        String(url).endsWith('.tbi')
          ? Promise.resolve(new Response('upstream failure', { status }))
          : actual(url, init)
      )
      await expect(run(query, fetchImpl)).rejects.toMatchObject({
        name: 'ConnectorHttpError',
        status
      })
    }
  )
  it.each(['ignored', 'bad-range', 'changed', 'truncated', 'no-validator'])(
    'rejects unsafe byte-range transport: %s',
    async (mode) => {
      const { fetchImpl } = server([row()], {
        mutateRange: (response, call) => {
          if (mode === 'ignored') return new Response('whole file')
          if (mode === 'bad-range') response.headers.set('content-range', 'bytes 1-9/100')
          if (mode === 'changed' && call > 1) response.headers.set('etag', '"fixture-v2"')
          if (mode === 'no-validator') response.headers.delete('etag')
          if (mode === 'truncated')
            return new Response('short', { status: 206, headers: response.headers })
          return response
        }
      })
      await expect(run(query, fetchImpl)).rejects.toThrow(/eQTL/)
    }
  )
  it('rejects an equal-length range mapped to a different file address', async () => {
    const { fetchImpl } = server([row()], {
      mutateRange: (response, call) => {
        if (call > 1) {
          const [from, to, total] = /^bytes (\d+)-(\d+)\/(\d+)$/
            .exec(response.headers.get('content-range')!)!
            .slice(1)
            .map(Number)
          response.headers.set('content-range', `bytes ${from - 1}-${to - 1}/${total}`)
        }
        return response
      }
    })
    await expect(run(query, fetchImpl)).rejects.toThrow(/Mismatched eQTL Content-Range/)
  })
  it('rejects weak ETags even when Last-Modified is present', async () => {
    const { fetchImpl } = server([row()], {
      mutateRange: (response) => {
        response.headers.set('etag', 'W/"fixture"')
        response.headers.set('last-modified', 'Mon, 02 Nov 2026 00:00:00 GMT')
        return response
      }
    })
    await expect(run(query, fetchImpl)).rejects.toThrow(/strong ETag/)
  })
  // The reader oracle covers all six levels; one parent exercises engine integration here.
  it('reads point records packed into a parent bin', async () => {
    const { fetchImpl } = server([row()], { bin: 585 + Math.floor((46120612 - 1) / 131072) })
    expect(await run(query, fetchImpl)).toMatchObject({ returned: 1, truncated: false })
  })
  it('rejects a header/index coordinate-column mismatch rather than returning zero rows', async () => {
    const { fetchImpl } = server([row()], { swappedCoordinates: true })
    await expect(run(query, fetchImpl)).rejects.toThrow(/coordinate columns/)
  })
  it('rejects invalid UTF-8 in chromosome names rather than reporting a missing chromosome', async () => {
    const { fetchImpl } = server([row()], { invalidIndexUtf8: true })
    await expect(run(query, fetchImpl)).rejects.toThrow()
  })
  it('rejects invalid UTF-8 instead of silently losing identifier matches', async () => {
    const { fetchImpl } = server([row()], { invalidUtf8: true })
    await expect(run({ ...query, gene_id: gene }, fetchImpl)).rejects.toThrow()
  })
  it.each(['bad-index', 'incomplete-row', 'bad-pvalue', 'bad-numeric', 'bad-begin', 'bad-end'])(
    'rejects corrupt data: %s',
    async (mode) => {
      const { fetchImpl } = server(
        [
          mode === 'incomplete-row'
            ? row() + '\textra'
            : row(
                mode === 'bad-pvalue'
                  ? { pvalue: '-0.01' }
                  : mode === 'bad-numeric'
                    ? { beta: 'garbage' }
                    : {}
              )
        ],
        {
          badIndex: mode === 'bad-index',
          startByte: mode === 'bad-begin' ? 65535 : 0,
          endByte: mode === 'bad-end' ? 5 : undefined
        }
      )
      await expect(run(query, fetchImpl)).rejects.toThrow()
    }
  )
  it('selects the real 16-Kb Tabix bin and excludes nonoverlapping bins', async () => {
    const matchingBin = 4681 + ((46120612 - 1) >> 14)
    const matching = server([row()], { bin: matchingBin })
    expect(await run(query, matching.fetchImpl)).toMatchObject({ returned: 1 })
    const absent = server([row()], { bin: matchingBin + 1 })
    expect(await run(query, absent.fetchImpl)).toMatchObject({ returned: 0, truncated: false })
  })
  it('treats a chromosome absent from a valid index as an exhausted empty query', async () => {
    const { fetchImpl } = server()
    expect(await run({ ...query, pos: '19:44908822-44908822' }, fetchImpl)).toMatchObject({
      returned: 0,
      truncated: false
    })
  })
  it('limits the compressed byte range before transferring a large data chunk', async () => {
    const { fetchImpl } = server([row()], { largeChunk: true })
    await expect(run(query, fetchImpl)).rejects.toThrow(/bounded remote-read budget/)
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('.gz'))).toHaveLength(1)
  })
  it('rejects an oversized inflated BGZF block before using its header', async () => {
    const { fetchImpl } = server([row()], { oversizedBlock: true })
    await expect(run(query, fetchImpl)).rejects.toMatchObject({ code: 'ERR_BUFFER_TOO_LARGE' })
  })
  it('enforces the cumulative inflation budget even for valid highly compressed rows', async () => {
    const { fetchImpl } = server([row()], { inflationBomb: true })
    await expect(run({ ...query, max_records: 1 }, fetchImpl)).rejects.toThrow(
      /bounded remote-read budget/
    )
  })
  it('rejects damaged BGZF payloads using gzip integrity checks', async () => {
    const { fetchImpl } = server([row()], { badCrc: true })
    await expect(run(query, fetchImpl)).rejects.toThrow()
  })
  it('limits index response bytes instead of accepting an unbounded index', async () => {
    const { fetchImpl } = server()
    const actual = fetchImpl.getMockImplementation()!
    fetchImpl.mockImplementation((url, init) =>
      String(url).endsWith('.tbi')
        ? Promise.resolve(new Response(Buffer.alloc(4 * 1024 * 1024 + 1)))
        : actual(url, init)
    )
    await expect(run(query, fetchImpl)).rejects.toThrow(/bounded remote-read budget/)
  })
  it('retains nonzero decimal p-value significance even when Number underflows', async () => {
    const pvalue = '0.' + '0'.repeat(399) + '1'
    const { fetchImpl } = server([row({ pvalue })])
    expect(await run({ ...query, nlog10p_min: 399 }, fetchImpl)).toMatchObject({
      returned: 1,
      associations: [{ pvalue: 0, pvalue_text: pvalue, nlog10p: 400 }]
    })
  })
  it('keeps literal-zero significance unknown and does not turn it into Infinity', async () => {
    const { fetchImpl } = server([row({ pvalue: '0' })])
    expect(await run(query, fetchImpl)).toMatchObject({
      returned: 1,
      associations: [{ pvalue: 0, nlog10p: null }]
    })
    expect(await run({ ...query, nlog10p_min: 0 }, fetchImpl)).toMatchObject({ returned: 0 })
  })
  it('cancels an in-flight index request and stops all later reads', async () => {
    const controller = new AbortController(),
      { fetchImpl } = server()
    const actual = fetchImpl.getMockImplementation()!
    fetchImpl.mockImplementation(async (url, init) => {
      if (String(url).endsWith('.tbi')) controller.abort(new Error('cancel index read'))
      return actual(url, init)
    })
    await expect(run(query, fetchImpl, 'eqtl_associations', controller.signal)).rejects.toThrow(
      'cancel index read'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('spaces every file request through process-shared admission', async () => {
    vi.mocked(abortableDelay).mockClear()
    const { fetchImpl } = server(),
      actual = fetchImpl.getMockImplementation()!,
      times: number[] = []
    fetchImpl.mockImplementation((url, init) => {
      if (String(url).includes('ftp.ebi.ac.uk')) times.push(Date.now())
      return actual(url, init)
    })
    await run(query, fetchImpl)
    expect(times.length).toBeGreaterThanOrEqual(3)
    expect(times.slice(1).every((t, i) => t - times[i] >= 2000)).toBe(true)
    expect(abortableDelay).toHaveBeenCalled()
  })
  it('propagates cancellation into an unfinished HTTP operation', async () => {
    const controller = new AbortController(),
      stopped = vi.fn(),
      { fetchImpl } = server(),
      actual = fetchImpl.getMockImplementation()!
    fetchImpl.mockImplementation((url, init) => {
      if (!String(url).endsWith('.tbi')) return actual(url, init)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            stopped()
            reject(init.signal?.reason)
          },
          { once: true }
        )
        controller.abort(new Error('stop unfinished HTTP'))
      })
    })
    await expect(run(query, fetchImpl, 'eqtl_associations', controller.signal)).rejects.toThrow(
      'stop unfinished HTTP'
    )
    expect(stopped).toHaveBeenCalledOnce()
  })
  it('honors cancellation before any request', async () => {
    const fetchImpl = vi.fn(),
      controller = new AbortController()
    controller.abort(new Error('audit cancellation'))
    await expect(run(query, fetchImpl, 'eqtl_associations', controller.signal)).rejects.toThrow(
      'audit cancellation'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
