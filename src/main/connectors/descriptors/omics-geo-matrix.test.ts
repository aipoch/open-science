import { describe, expect, it, vi, type Mock } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { ParserEngine } from '../engine'
import { OMICS_ARCHIVES_TOOLS } from './omics-archives'
import { GEO_MATRIX_TOOLS } from './omics-geo-matrix'

const ajv = new Ajv2020({ strict: true })
const validators = GEO_MATRIX_TOOLS.map((descriptor) => ajv.compile(descriptor.input))
const validateToolArguments = (
  descriptor: (typeof GEO_MATRIX_TOOLS)[number],
  args: Record<string, unknown>
): void => {
  if (!validators[GEO_MATRIX_TOOLS.indexOf(descriptor)](args)) throw new Error('invalid_arguments')
}

const accession = 'GSE164073'
const matrixUrl = `https://ftp.ncbi.nlm.nih.gov/geo/series/GSE164nnn/${accession}/matrix/`
const countUrl = `https://www.ncbi.nlm.nih.gov/geo/download/?type=rnaseq_counts&acc=${accession}`
const countLink = (file: string, acc = accession): string =>
  `<a href="/geo/download/?type=rnaseq_counts&amp;acc=${acc}&amp;format=file&amp;file=${file}">${file}</a>`
const samples = [
  { accession: 'GSM1', title: 'control', platform_id: 'GPL1' },
  { accession: 'GSM2', title: 'treated', platform_id: 'GPL1' }
]
const series =
  '!Sample_geo_accession\t"GSM2"\t"GSM1"\n!series_matrix_table_begin\n"ID_REF"\t"GSM2"\t"GSM1"\n"probe1"\t1.5\t-2\n!series_matrix_table_end\n'

type Result = Record<string, unknown> & {
  files: Array<{ kind: string; url: string }>
  sources: Array<{ status: string }>
  sample_mapping: Array<{ accession: string | null; status: string }>
  dimensions: { features: number | null }
  next_steps: string[]
}

function setup(
  matrix = '',
  counts = ''
): {
  fetchImpl: Mock<typeof fetch>
  call: (id: string, args: Record<string, unknown>) => Promise<Result>
} {
  const fetchImpl = vi.fn<typeof fetch>(
    async (url) => new Response(String(url).includes('/matrix/') ? matrix : counts)
  )
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  return {
    fetchImpl,
    // Descriptor return values are intentionally dynamic at the engine boundary.
    call: async (id: string, args: Record<string, unknown>) => {
      const descriptor = GEO_MATRIX_TOOLS.find((tool) => tool.id === id)!
      validateToolArguments(descriptor, args)
      return (await engine.call(descriptor, args, {})) as Result
    }
  }
}
const inspect = (text: string, rest: Record<string, unknown> = {}): Promise<Result> =>
  setup().call('geo_preflight_matrix', { text, samples, complete: true, ...rest })

describe('GEO matrix discovery', () => {
  it('registers both tools with strict input schemas', () => {
    for (const descriptor of GEO_MATRIX_TOOLS)
      expect(OMICS_ARCHIVES_TOOLS.find((tool) => tool.id === descriptor.id)).toBe(descriptor)
    expect(() =>
      validateToolArguments(GEO_MATRIX_TOOLS[0], { accession: 'GSE1/../GSE2' })
    ).toThrow()
    expect(() =>
      validateToolArguments(GEO_MATRIX_TOOLS[0], { accession: 'GSE1', download: true })
    ).toThrow()
    expect(() =>
      validateToolArguments(GEO_MATRIX_TOOLS[1], { text: 'x', complete: 'true' })
    ).toThrow()
    expect(() =>
      validateToolArguments(GEO_MATRIX_TOOLS[1], { text: 'x', samples: [{ accession: 'SRR1' }] })
    ).toThrow()
  })

  it('discovers platform files, raw/normalized counts and annotation without fetching matrices', async () => {
    const raw = `${accession}_raw_counts_GRCh38.p13_NCBI.tsv.gz`
    const norm = `${accession}_norm_counts_TPM_GRCh38.p13_NCBI.tsv.gz`
    const { call, fetchImpl } = setup(
      `<a href="${accession}-GPL1_series_matrix.txt.gz">one</a><a href="${accession}-GPL2_series_matrix.txt.gz">two</a>`,
      countLink(raw) + countLink(norm) + countLink('Human.GRCh38.p13.annot.tsv.gz') + countLink(raw)
    )
    const result = await call('geo_get_matrix_files', { accession })
    expect(result.files.map((file: { kind: string }) => file.kind)).toEqual([
      'series_matrix',
      'series_matrix',
      'raw_counts',
      'normalized_counts',
      'gene_annotation'
    ])
    expect(result.files[0]).toMatchObject({
      platform_id: 'GPL1',
      source_url: matrixUrl,
      compression: 'gzip'
    })
    expect(result.files[2].url).toContain('&acc=GSE164073&format=file&file=')
    expect(result.status).toBe('ok')
    expect(result).not.toHaveProperty('discovery_complete')
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([matrixUrl, countUrl])
  })

  it.each(['GSE1', 'GSE99', 'GSE999', 'GSE1000', 'GSE9999'])(
    'uses the correct FTP bucket for %s',
    async (acc) => {
      const { call, fetchImpl } = setup()
      await call('geo_get_matrix_files', { accession: acc })
      const bucket = acc.length <= 6 ? 'GSEnnn' : `${acc.slice(0, -3)}nnn`
      expect(fetchImpl.mock.calls[0][0]).toBe(
        `https://ftp.ncbi.nlm.nih.gov/geo/series/${bucket}/${acc}/matrix/`
      )
    }
  )

  it('rejects foreign, cross-series, traversal and credential-bearing links', async () => {
    const matrix = `${accession}_series_matrix.txt.gz`
    const { call } = setup(
      `<a href="https://evil.test/${matrix}">bad</a><a href="../${matrix}">bad</a><a href="https://u:p@ftp.ncbi.nlm.nih.gov/geo/series/GSE164nnn/${accession}/matrix/${matrix}">bad</a>`,
      countLink('GSE2_raw_counts_GRCh38.p13_NCBI.tsv.gz', 'GSE2') + countLink('../bad.tsv.gz')
    )
    expect((await call('geo_get_matrix_files', { accession })).files).toEqual([])
  })

  it('reports an access challenge separately while retaining successful discovery', async () => {
    const { call } = setup(
      `<a href="${accession}_series_matrix.txt.gz">file</a>`,
      '<html>Checking your browser reCAPTCHA</html>'
    )
    const result = await call('geo_get_matrix_files', { accession })
    expect(result.files).toHaveLength(1)
    expect(result.sources[1]).toMatchObject({
      status: 'unavailable',
      error: expect.stringContaining('access challenge')
    })
    expect(result.status).toBe(result.files.length ? 'partial' : 'unrecognized')
  })

  it('does not equate HTTP 404 or empty/unrecognized pages with proven absence', async () => {
    const { call, fetchImpl } = setup('<html>New layout</html>')
    fetchImpl.mockImplementation(
      async (url) => new Response('', { status: String(url).includes('/matrix/') ? 404 : 200 })
    )
    const result = await call('geo_get_matrix_files', { accession })
    expect(result.sources.map((source: { status: string }) => source.status)).toEqual([
      'unavailable',
      'no_recognized_links'
    ])
    expect(result.status).toBe(result.files.length ? 'partial' : 'unrecognized')
  })

  it('propagates cancellation rather than returning a successful partial response', async () => {
    const controller = new AbortController()
    controller.abort()
    const engine = new ParserEngine({ fetchImpl: vi.fn() })
    await expect(
      engine.call(GEO_MATRIX_TOOLS[0], { accession }, {}, controller.signal)
    ).rejects.toThrow()
  })

  it('throws with both source errors when neither listing can be fetched', async () => {
    const { call, fetchImpl } = setup()
    fetchImpl.mockImplementation(
      async (url) =>
        new Response('', {
          status: String(url).includes('/matrix/') ? 404 : 503
        })
    )
    await expect(call('geo_get_matrix_files', { accession })).rejects.toThrow(
      /GEO matrix discovery failed.*HTTP 404.*HTTP 503/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps the available source when the other source has a network failure', async () => {
    const { call, fetchImpl } = setup()
    fetchImpl.mockImplementation(async (url) => {
      if (String(url).includes('/matrix/')) throw new Error('network failure')
      return new Response(countLink(`${accession}_raw_counts_GRCh38.p13_NCBI.tsv.gz`))
    })
    const result = await call('geo_get_matrix_files', { accession })
    expect(result.status).toBe('partial')
    expect(result.files).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ status: 'unavailable', error: 'network failure' })
  })

  it('reports unrecognized listings without claiming exhaustive discovery or absence', async () => {
    const { call } = setup('<html>New layout</html>', '<html>No known links</html>')
    const result = await call('geo_get_matrix_files', { accession })
    expect(result.status).toBe('unrecognized')
    expect(result.sources.map((source: { status: string }) => source.status)).toEqual([
      'no_recognized_links',
      'no_recognized_links'
    ])
    expect(result).not.toHaveProperty('discovery_complete')
    expect(result.next_steps.join(' ')).toContain('manual download by the user')
  })
})

describe('GEO matrix preflight', () => {
  it('preserves matrix order when aligning Series Matrix samples to metadata', async () => {
    const result = await inspect(series)
    expect(result.dimensions).toEqual({ features: 1, features_observed: 1, samples: 2 })
    expect(result.sample_mapping.map((row) => row.accession)).toEqual(['GSM2', 'GSM1'])
    expect(result.diagnostics).toMatchObject({
      negative_values: 1,
      non_integer_or_unsafe_values: 1
    })
    expect(result.matrix_kind).toBe('series_matrix')
    expect(result.structural_checks_passed).toBe(true)
  })

  it('handles BOM, CRLF, scientific notation and unique title mapping for count TSV', async () => {
    const result = await inspect('\uFEFFGeneID\t"treated"\tcontrol\r\n1\t1e2\t0\r\n2\t3\t4\r\n', {
      matrix_kind: 'raw_counts'
    })
    expect(result.structural_checks_passed).toBe(true)
    expect(result.sample_mapping[0]).toMatchObject({
      column_index: 1,
      accession: 'GSM2',
      matched_by: 'unique_title'
    })
    expect(result.dimensions.features).toBe(2)
  })

  it('never claims complete dimensions for a preview, including a missing Series Matrix end', async () => {
    const preview = await inspect('GeneID\tGSM1\n1\t2\n', { complete: false })
    expect(preview.dimensions.features).toBeNull()
    expect(preview.structural_checks_passed).toBe(false)
    const truncated = await inspect(series.replace('!series_matrix_table_end\n', ''))
    expect(truncated.complete).toBe(false)
    expect(truncated.dimensions.features).toBeNull()
  })

  it('reports malformed dimensions, duplicate features, missing and nonnumeric values', async () => {
    const result = await inspect('GeneID\tGSM1\tGSM2\nA\tNA\tbad\nA\t1\n\t2\t3\n')
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'inconsistent_row_width',
        'duplicate_feature_ids',
        'empty_feature_ids',
        'missing_values',
        'non_numeric_values'
      ])
    )
    expect(result.structural_checks_passed).toBe(false)
  })

  it('does not silently accept empty matrices or treat normalized values as raw counts', async () => {
    expect((await inspect('GeneID\tGSM1\n')).issues).toContain('empty_matrix')
    const raw = await inspect('GeneID\tGSM1\nA\t-1.5\nB\t9007199254740992\n', {
      matrix_kind: 'raw_counts'
    })
    expect(raw.issues).toContain('raw_counts_require_nonnegative_safe_integers')
    const normalized = await inspect('GeneID\tGSM1\nA\t1.5\n', { matrix_kind: 'normalized_counts' })
    expect(normalized.matrix_kind).toBe('normalized_counts')
    await expect(inspect(series, { matrix_kind: 'raw_counts' })).rejects.toThrow(
      'cannot be declared'
    )
  })

  it.each([
    '1.0000000000000001',
    '9007199254740990.5',
    '9007199254740991.1',
    '1e-999',
    '-1e-999',
    '1e-999999999999999999999',
    '1001e-3',
    '9007199254740992'
  ])(
    'rejects raw counts without hiding fractions, underflow or unsafe magnitude: %s',
    async (cell) => {
      const result = await inspect(`GeneID\tGSM1\nA\t${cell}\n`, { matrix_kind: 'raw_counts' })
      expect(result.structural_checks_passed).toBe(false)
      expect(result.issues).toContain('raw_counts_require_nonnegative_safe_integers')
      expect(result.diagnostics).toMatchObject({
        non_integer_or_unsafe_values: 1,
        negative_values: cell.startsWith('-') ? 1 : 0
      })
    }
  )

  it.each([
    '0',
    '-0.000e-999',
    '0e999999999999999999999',
    '1.0',
    '+0001.000',
    '1e2',
    '1000e-3',
    '.001e3',
    '9007199254740991',
    '9.007199254740991e15'
  ])('preserves exact safe integer raw-count representations: %s', async (cell) => {
    const result = await inspect(`GeneID\tGSM1\nA\t${cell}\n`, { matrix_kind: 'raw_counts' })
    expect(result.structural_checks_passed).toBe(true)
    expect(result.diagnostics).toMatchObject({
      non_integer_or_unsafe_values: 0,
      negative_values: 0
    })
  })

  it('keeps decimal normalized values outside the raw-count integer requirement', async () => {
    const result = await inspect('GeneID\tGSM1\nA\t1.0000000000000001\nB\t1e-999\n', {
      matrix_kind: 'normalized_counts'
    })
    expect(result.structural_checks_passed).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('does not guess ambiguous titles, SRR identifiers or absent metadata', async () => {
    const result = await inspect('GeneID\tshared\tSRR1\nA\t1\t2\n', {
      samples: samples.map((sample) => ({ ...sample, title: 'shared' }))
    })
    expect(result.sample_mapping.map((row: { status: string }) => row.status)).toEqual([
      'ambiguous',
      'unmatched'
    ])
    expect(result.metadata_samples_not_in_matrix).toEqual(['GSM1', 'GSM2'])
    expect((await inspect('GeneID\tGSM1\nA\t1\n', { samples: undefined })).issues).toContain(
      'sample_mapping_incomplete'
    )
  })

  it('reports repeated columns, duplicate metadata and multiple columns targeting one sample', async () => {
    expect((await inspect('GeneID\tGSM1\tGSM1\nA\t1\t2\n')).issues).toContain(
      'duplicate_sample_columns'
    )
    expect((await inspect('GeneID\tGSM1\tcontrol\nA\t1\t2\n')).issues).toContain(
      'multiple_columns_map_to_same_sample'
    )
    expect(
      (await inspect('GeneID\tGSM1\nA\t1\n', { samples: [samples[0], samples[0]] })).issues
    ).toContain('duplicate_metadata_accessions')
  })

  it('never maps an unknown GSM-shaped header to another sample title', async () => {
    const result = await inspect('GeneID\tGSM999\n1\t2\n', {
      samples: [{ accession: 'GSM1', title: 'GSM999' }]
    })
    expect(result.sample_mapping[0]).toMatchObject({ accession: null, status: 'unmatched' })
    expect(result.issues).toContain('sample_mapping_incomplete')
    expect(result.structural_checks_passed).toBe(false)
  })

  it('prefers a GSM identity over a competing sample title', async () => {
    const result = await inspect('GeneID\tGSM1\n1\t2\n', {
      samples: [
        { accession: 'GSM1', title: 'control' },
        { accession: 'GSM2', title: 'GSM1' }
      ]
    })
    expect(result.sample_mapping[0]).toMatchObject({ accession: 'GSM1', matched_by: 'accession' })
    expect(result.metadata_samples_not_in_matrix).toEqual(['GSM2'])
  })

  it('checks Series Matrix platforms in matrix order against matching sample metadata', async () => {
    const matching = '!Sample_platform_id\tGPL2\tGPL1\n' + series
    const metadata = [samples[0], { ...samples[1], platform_id: 'GPL2' }]
    const valid = await inspect(matching, { samples: metadata })
    expect(valid.structural_checks_passed).toBe(true)
    expect(valid.warnings).toEqual([expect.stringContaining('multiple_platforms_in_matrix')])
    const conflicting = await inspect(matching)
    expect(conflicting.issues).toContain('series_platform_metadata_mismatch')
    expect(conflicting.structural_checks_passed).toBe(false)
  })

  it.each(['!Sample_geo_accession\tGSM2\tGSM1\n', '!Sample_geo_accession\tGSM1\tGSM2\n'])(
    'rejects repeated Series Matrix sample identity headers %j',
    async (extraHeader) => {
      const result = await inspect(extraHeader + series)
      expect(result.issues).toContain('series_sample_header_mismatch')
      expect(result.structural_checks_passed).toBe(false)
    }
  )

  it.each(['GSM2', 'GSM2\tGSM1\tGSM3'])(
    'rejects Series Matrix sample identity counts that differ from the columns %j',
    async (identities) => {
      const result = await inspect(series.replace('"GSM2"\t"GSM1"', identities))
      expect(result.issues).toContain('series_sample_header_mismatch')
      expect(result.structural_checks_passed).toBe(false)
    }
  )

  it.each(['GSM0', 'gsm2'])(
    'rejects invalid GSM identities even when metadata and columns agree: %s',
    async (identity) => {
      const result = await inspect(series.replaceAll('"GSM2"', `"${identity}"`))
      expect(result.issues).toContain('series_sample_header_mismatch')
      expect(result.structural_checks_passed).toBe(false)
    }
  )

  it('never accepts titles as Series Matrix identities even when metadata and columns agree', async () => {
    const result = await inspect(series.replaceAll('"GSM1"', '"control"'))
    expect(result.sample_mapping[1]).toMatchObject({
      accession: null,
      matched_by: null,
      status: 'unmatched'
    })
    expect(result.issues).toEqual(
      expect.arrayContaining(['series_sample_header_mismatch', 'sample_mapping_incomplete'])
    )
    expect(result.structural_checks_passed).toBe(false)
  })

  it.each([
    '!Sample_platform_id\tGPL1\n',
    '!Sample_platform_id\tGPL1\tinvalid\n',
    '!Sample_platform_id\tGPL1\tGPL1\n!Sample_platform_id\tGPL1\tGPL1\n'
  ])('rejects malformed Series Matrix platform metadata %j', async (platformHeader) => {
    const result = await inspect(platformHeader + series)
    expect(result.issues).toContain('series_platform_header_mismatch')
    expect(result.structural_checks_passed).toBe(false)
  })

  it('keeps multiple raw-count platforms advisory without concealing structural errors', async () => {
    const metadata = [samples[0], { ...samples[1], platform_id: 'GPL2' }]
    const valid = await inspect('GeneID\tGSM1\tGSM2\n1\t2\t3\n', {
      samples: metadata,
      matrix_kind: 'raw_counts'
    })
    expect(valid.structural_checks_passed).toBe(true)
    expect(valid.warnings).toEqual([expect.stringContaining('multiple_platforms_in_matrix')])
    const invalid = await inspect('GeneID\tGSM1\tGSM2\n1\t2\t-3\n', {
      samples: metadata,
      matrix_kind: 'raw_counts'
    })
    expect(invalid.issues).toContain('raw_counts_require_nonnegative_safe_integers')
    expect(invalid.structural_checks_passed).toBe(false)
  })

  it('maps the supported 10,000-sample input while preserving reverse column order', async () => {
    const metadata = Array.from({ length: 10000 }, (_, index) => ({ accession: `GSM${index + 1}` }))
    const columns = metadata.map((sample) => sample.accession).reverse()
    const result = await inspect(
      `GeneID\t${columns.join('\t')}\n1\t${columns.map(() => '1').join('\t')}\n`,
      { samples: metadata }
    )
    expect(result.structural_checks_passed).toBe(true)
    expect(result.sample_mapping[0].accession).toBe('GSM10000')
    expect(result.sample_mapping[9999].accession).toBe('GSM1')
    expect(result.metadata_samples_not_in_matrix).toEqual([])
  })

  it('reports platform mixing, missing samples and Series metadata order mismatches', async () => {
    const mixed = await inspect(series, {
      samples: [samples[0], { ...samples[1], platform_id: 'GPL2' }]
    })
    expect(mixed.warnings).toEqual([expect.stringContaining('multiple_platforms_in_matrix')])
    expect(mixed.structural_checks_passed).toBe(true)
    const subset = await inspect('GeneID\tGSM1\nA\t1\n')
    expect(subset.metadata_samples_not_in_matrix).toEqual(['GSM2'])
    expect(
      (
        await inspect(
          series.replace(
            '!Sample_geo_accession\t"GSM2"\t"GSM1"',
            '!Sample_geo_accession\t"GSM1"\t"GSM2"'
          )
        )
      ).issues
    ).toContain('series_sample_header_mismatch')
  })

  it.each([
    '<html>Error</html>',
    '\u001f\u008bgarbage',
    '%%MatrixMarket matrix coordinate real general',
    'a,b\n1,2',
    'gene\tGSM1\n"unterminated\t1',
    series + series
  ])('rejects unsupported or malformed input %j', async (text) => {
    await expect(inspect(text)).rejects.toThrow()
  })

  it('enforces the decompressed byte budget and does not make network calls', async () => {
    const { call, fetchImpl } = setup()
    await expect(
      call('geo_preflight_matrix', { text: '界'.repeat(3 * 1024 * 1024) })
    ).rejects.toThrow('8 MiB')
    await call('geo_preflight_matrix', { text: 'GeneID\tGSM1\nA\t1\n' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
