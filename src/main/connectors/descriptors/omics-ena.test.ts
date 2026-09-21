import { describe, expect, it, vi, type Mock } from 'vitest'
import type { ToolDescriptor } from '../types'
import { ParserEngine } from '../engine'
import Ajv2020 from 'ajv/dist/2020.js'
import { ENA_OMICS_TOOLS } from './omics-ena'

const tool = (id: string): ToolDescriptor =>
  ENA_OMICS_TOOLS.find((descriptor) => descriptor.id === id)!
const ajv = new Ajv2020({ strict: true })
const validators = new Map(
  ENA_OMICS_TOOLS.map((descriptor) => [descriptor.id, ajv.compile(descriptor.input)])
)
const runId = 'SRR037073'
const md5 = '89359f77f5870d2b563ebd77baeeeaf6'
const path = `ftp.sra.ebi.ac.uk/vol1/fastq/SRR037/${runId}/${runId}.fastq.gz`
const fileRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  run_accession: runId,
  library_layout: 'SINGLE',
  fastq_ftp: path,
  fastq_bytes: '25154397',
  fastq_md5: md5,
  ...extra
})

function setup(
  payload: unknown,
  status = 200
): {
  fetchImpl: Mock<typeof fetch>
  call: (id: string, args: Record<string, unknown>) => Promise<unknown>
} {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(payload), { status })
  )
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  return {
    fetchImpl,
    call: (id: string, args: Record<string, unknown>) => {
      const descriptor = tool(id)
      if (!validators.get(id)!(args)) throw new Error('invalid_arguments')
      return engine.call(descriptor, args, {})
    }
  }
}

describe('ENA tool registration and contracts', () => {
  it.each([
    ['ena_query_runs', {}],
    ['ena_query_runs', { tax_id: 0 }],
    ['ena_query_runs', { tax_id: -1 }],
    ['ena_query_runs', { tax_id: 6239.5 }],
    ['ena_query_runs', { tax_id: '6239' }],
    ['ena_query_runs', { tax_id: 2147483648 }],
    ['ena_query_runs', { keyword: '' }],
    ['ena_query_runs', { keyword: 'a'.repeat(201) }],
    ['ena_query_runs', { keyword: 'worm" OR tax_tree(9606)' }],
    ['ena_query_runs', { keyword: 'worm\\test' }],
    ['ena_query_runs', { keyword: '*worm*' }],
    ['ena_query_runs', { keyword: 'worm?' }],
    ['ena_query_runs', { keyword: 'worm\nRNA' }],
    ['ena_query_runs', { library_strategy: 'rna-seq' }],
    ['ena_query_runs', { tax_id: 6239, limit: 0 }],
    ['ena_query_runs', { tax_id: 6239, limit: 1001 }],
    ['ena_query_runs', { tax_id: 6239, limit: '1' }],
    ['ena_query_runs', { tax_id: 6239, offset: 1 }],
    ['ena_query_runs', { query: 'tax_tree(6239)' }],
    ['ena_get_submitted_files', {}],
    ['ena_get_submitted_files', { run_accession: runId, download: true }],
    ['ena_search_runs', {}],
    ['ena_search_runs', { accession: ['PRJNA123835'] }],
    ['ena_search_runs', { accession: 'PRJNA123835', offset: 1 }],
    ['ena_search_runs', { accession: 'PRJNA123835', limit: 0 }],
    ['ena_search_runs', { accession: 'PRJNA123835', limit: 1001 }],
    ['ena_search_runs', { accession: 'PRJNA123835', limit: 1.5 }],
    ['ena_search_runs', { accession: 'PRJNA123835', limit: '1' }],
    ['ena_get_run_files', { accession: runId }],
    ['ena_get_run_files', { run_accession: runId, download: true }]
  ])('rejects invalid %s arguments before HTTP: %j', (id, args) => {
    const { call, fetchImpl } = setup([])
    expect(() => call(id as string, args as Record<string, unknown>)).toThrow(/invalid_arguments/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ena_search_runs', () => {
  it('uses one bounded file-report request and carries nonhuman organism/library metadata', async () => {
    const { call, fetchImpl } = setup([
      { run_accession: 'SRR037074', scientific_name: 'Caenorhabditis elegans', tax_id: '6239' },
      {
        run_accession: runId,
        study_accession: 'PRJNA123835',
        secondary_study_accession: 'SRP002056',
        sample_accession: 'SAMN00009557',
        experiment_accession: 'SRX017289',
        tax_id: '6239',
        scientific_name: 'Caenorhabditis elegans',
        library_strategy: 'RNA-Seq',
        library_layout: 'SINGLE',
        library_source: 'TRANSCRIPTOMIC',
        instrument_platform: 'ILLUMINA',
        instrument_model: 'Illumina Genome Analyzer II'
      }
    ])
    const out = await call('ena_search_runs', { accession: ' prjna123835 ' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const request = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(request.origin + request.pathname).toBe(
      'https://www.ebi.ac.uk/ena/portal/api/filereport'
    )
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      accession: 'PRJNA123835',
      result: 'read_run',
      format: 'json',
      limit: '101'
    })
    expect(request.searchParams.has('offset')).toBe(false)
    expect(request.searchParams.get('fields')).toContain('library_layout')
    expect(request.searchParams.get('fields')).not.toContain('fastq_ftp')
    expect(out).toMatchObject({
      accession: 'PRJNA123835',
      n_runs_returned: 2,
      truncated: false,
      runs: [
        {
          run_accession: runId,
          tax_id: '6239',
          library_strategy: 'RNA-Seq',
          library_layout: 'SINGLE'
        },
        { run_accession: 'SRR037074', library_layout: null }
      ]
    })
  })

  it.each([
    'ERP123',
    'SRP123',
    'DRP123',
    'PRJEB123',
    'PRJNA123',
    'PRJDB123',
    'ERX123',
    'SRX123',
    'DRX123',
    'ERS123',
    'SRS123',
    'DRS123',
    'SAMEA123',
    'SAMN123',
    'SAMD123',
    'SAMD000123',
    'ERR123',
    'SRR123',
    'DRR123'
  ])('accepts the documented INSDC accession family %s', async (accession) => {
    await expect(setup([]).call('ena_search_runs', { accession })).resolves.toMatchObject({
      runs: []
    })
  })

  it.each([
    'GSE131907',
    'GSM1',
    'E-MTAB-5061',
    'MGYS00000410',
    'PRJNA123,PRJNA456',
    'SRX1&limit=0',
    ' ',
    '12345'
  ])('rejects unsupported accession %s before HTTP', async (accession) => {
    const { call, fetchImpl } = setup([])
    await expect(call('ena_search_runs', { accession })).rejects.toThrow(/INSDC/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses a lookahead to distinguish exactly-limit results from a truncated subset', async () => {
    for (const [rows, truncated] of [
      [[{ run_accession: runId }], false],
      [[{ run_accession: runId }, { run_accession: 'SRR037074' }], true]
    ] as const) {
      const { call, fetchImpl } = setup(rows)
      await expect(
        call('ena_search_runs', { accession: 'SRP002056', limit: 1 })
      ).resolves.toMatchObject({
        n_runs_returned: 1,
        truncated,
        runs: [{ run_accession: runId }]
      })
      expect(String(fetchImpl.mock.calls[0][0])).toContain('limit=2')
    }
  })

  it('returns an empty public result without asserting accession nonexistence', async () => {
    await expect(setup([]).call('ena_search_runs', { accession: 'SRP999999999' })).resolves.toEqual(
      {
        accession: 'SRP999999999',
        n_runs_returned: 0,
        truncated: false,
        runs: []
      }
    )
  })

  it.each([
    {},
    { message: 'bad query' },
    [null],
    ['error'],
    [{}],
    [{ run_accession: 'GSE1' }],
    [{ run_accession: runId, tax_id: 6239 }],
    [{ run_accession: runId }, { run_accession: runId }]
  ])('rejects malformed reports rather than presenting empty success: %j', async (payload) => {
    await expect(
      setup(payload).call('ena_search_runs', { accession: 'SRP002056' })
    ).rejects.toThrow(/Invalid ENA file report/)
  })

  it('fails if the upstream ignores the requested row limit', async () => {
    await expect(
      setup([1, 2, 3].map((n) => ({ run_accession: `ERR${n}` }))).call('ena_search_runs', {
        accession: 'ERP1',
        limit: 1
      })
    ).rejects.toThrow(/exceeds/)
  })
})

describe('ena_get_run_files', () => {
  it('converts only scheme-less FTP paths and returns file-level bytes and MD5', async () => {
    const { call, fetchImpl } = setup([fileRow()])
    await expect(call('ena_get_run_files', { run_accession: ' srr037073 ' })).resolves.toEqual({
      run_accession: runId,
      found: true,
      library_layout: 'SINGLE',
      fastq_available: true,
      n_files: 1,
      fastq_files: [{ file_index: 1, url: `ftp://${path}`, size_bytes: 25154397, md5 }]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('format=json')
  })

  it('retains all three paired/unpaired files in upstream order with aligned checksums', async () => {
    const names = ['_1', '', '_2'].map((suffix) => path.replace('.fastq.gz', `${suffix}.fastq.gz`))
    const checksums = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]
    const { call } = setup([
      fileRow({
        library_layout: 'PAIRED',
        fastq_ftp: names.join(';'),
        fastq_bytes: '11;22;33',
        fastq_md5: checksums.join(';')
      })
    ])
    await expect(call('ena_get_run_files', { run_accession: runId })).resolves.toMatchObject({
      n_files: 3,
      fastq_files: names.map((name, i) => ({
        file_index: i + 1,
        url: `ftp://${name}`,
        size_bytes: (i + 1) * 11,
        md5: checksums[i]
      }))
    })
  })

  it('does not equate library_layout PAIRED with two files', async () => {
    await expect(
      setup([fileRow({ library_layout: 'PAIRED' })]).call('ena_get_run_files', {
        run_accession: runId
      })
    ).resolves.toMatchObject({ n_files: 1, library_layout: 'PAIRED' })
  })

  it('keeps missing metadata positions rather than shifting the next checksum', async () => {
    const { call } = setup([
      fileRow({
        fastq_ftp: `${path};${path.replace('.fastq', '_2.fastq')}`,
        fastq_bytes: ';22',
        fastq_md5: `;${md5}`
      })
    ])
    await expect(call('ena_get_run_files', { run_accession: runId })).resolves.toMatchObject({
      fastq_files: [
        { size_bytes: null, md5: null },
        { size_bytes: 22, md5 }
      ]
    })
  })

  it('represents entirely unavailable bytes/checksums as null', async () => {
    await expect(
      setup([fileRow({ fastq_bytes: '', fastq_md5: null })]).call('ena_get_run_files', {
        run_accession: runId
      })
    ).resolves.toMatchObject({ fastq_files: [{ size_bytes: null, md5: null }] })
  })

  it('distinguishes a public run without FASTQ from no public report', async () => {
    for (const [payload, found, layout] of [
      [[], false, null],
      [[fileRow({ fastq_ftp: '', fastq_md5: '', fastq_bytes: '' })], true, 'SINGLE']
    ] as const) {
      await expect(
        setup(payload).call('ena_get_run_files', { run_accession: runId })
      ).resolves.toEqual({
        run_accession: runId,
        found,
        library_layout: layout,
        fastq_available: false,
        n_files: 0,
        fastq_files: []
      })
    }
  })

  it.each(['ftp', 'https', 'http'])('preserves existing %s URLs', async (scheme) => {
    await expect(
      setup([fileRow({ fastq_ftp: `${scheme}://${path}` })]).call('ena_get_run_files', {
        run_accession: runId
      })
    ).resolves.toMatchObject({ fastq_files: [{ url: `${scheme}://${path}` }] })
  })

  it.each([
    { fastq_bytes: '1;2' },
    { fastq_md5: `${md5};${md5}` },
    { fastq_ftp: '', fastq_md5: md5 },
    { fastq_ftp: `;${path}`, fastq_bytes: '1;2', fastq_md5: `;${md5}` },
    { fastq_ftp: 'not-a-url' },
    { fastq_ftp: 'file:///tmp/test.fastq' },
    { fastq_ftp: 'ftp://user:password@ftp.sra.ebi.ac.uk/x' },
    { fastq_bytes: '-1' },
    { fastq_bytes: '1.2' },
    { fastq_bytes: '1e6' },
    { fastq_bytes: '9007199254740992' },
    { fastq_bytes: 123 },
    { fastq_md5: 'bad' },
    { run_accession: 'SRR1' }
  ])('fails closed on inconsistent file reports: %j', async (extra) => {
    await expect(
      setup([fileRow(extra)]).call('ena_get_run_files', { run_accession: runId })
    ).rejects.toThrow(/Invalid ENA file report/)
  })

  it.each(['fastq_ftp', 'fastq_bytes', 'fastq_md5'])(
    'rejects absent requested field %s',
    async (field) => {
      const row: Record<string, unknown> = fileRow()
      delete row[field]
      await expect(
        setup([row]).call('ena_get_run_files', { run_accession: runId })
      ).rejects.toThrow(`missing ${field}`)
    }
  )

  it.each(['PRJNA123835', 'SRX017289', 'GSM1'])(
    'requires a run rather than %s',
    async (run_accession) => {
      const { call, fetchImpl } = setup([])
      await expect(call('ena_get_run_files', { run_accession })).rejects.toThrow(/ERR, SRR or DRR/)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it.each([400, 403, 404, 429, 500])(
    'keeps HTTP %i as failure rather than a missing run',
    async (status) => {
      await expect(
        setup({ message: 'error' }, status).call('ena_get_run_files', { run_accession: runId })
      ).rejects.toThrow(`HTTP ${status}`)
    }
  )

  it('does not cache empty reports across calls', async () => {
    const { call, fetchImpl } = setup([])
    await call('ena_get_run_files', { run_accession: runId })
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify([fileRow()])))
    await expect(call('ena_get_run_files', { run_accession: runId })).resolves.toMatchObject({
      found: true,
      n_files: 1
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('ena_query_runs', () => {
  it.each(['a', '𠮷', '😀'])(
    'accepts a 200-code-point keyword built from %s',
    async (character) => {
      const keyword = character.repeat(200)
      const { call, fetchImpl } = setup([])
      await expect(call('ena_query_runs', { keyword })).resolves.toMatchObject({
        filters: { keyword },
        runs: []
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const params = new URL(String(fetchImpl.mock.calls[0][0])).searchParams
      expect(params.get('query')).toContain(`study_title="*${keyword}*"`)
    }
  )

  it.each(['a', '𠮷', '😀'])(
    'rejects a 201-code-point keyword built from %s before HTTP at both boundaries',
    async (character) => {
      const args = { keyword: character.repeat(201) }
      const { call, fetchImpl } = setup([])
      expect(() => call('ena_query_runs', args)).toThrow(/invalid_arguments/)
      await expect(
        new ParserEngine({ fetchImpl }).call(tool('ena_query_runs'), args, {})
      ).rejects.toThrow(/keyword/)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('combines literal title keywords with taxonomy and strategy in one bounded search', async () => {
    const { call, fetchImpl } = setup([
      { run_accession: 'SRR037074', tax_id: '6239', library_strategy: 'RNA-Seq' },
      {
        run_accession: runId,
        tax_id: '6239',
        scientific_name: 'Caenorhabditis elegans',
        study_title: 'worm transcriptome'
      },
      { run_accession: 'SRR037075' }
    ])
    const out = await call('ena_query_runs', {
      tax_id: 6239,
      library_strategy: 'RNA-Seq',
      keyword: ' transcriptome ',
      limit: 2
    })
    expect(out).toMatchObject({
      filters: { tax_id: 6239, library_strategy: 'RNA-Seq', keyword: 'transcriptome' },
      n_runs_returned: 2,
      truncated: true,
      runs: [
        { run_accession: runId, tax_id: '6239', study_title: 'worm transcriptome' },
        { run_accession: 'SRR037074', sample_title: null }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const request = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(request.origin + request.pathname).toBe('https://www.ebi.ac.uk/ena/portal/api/search')
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      result: 'read_run',
      format: 'json',
      limit: '3',
      includeMetagenomes: 'true',
      query:
        'tax_tree(6239) AND library_strategy="RNA-Seq" AND (study_title="*transcriptome*" OR experiment_title="*transcriptome*" OR sample_title="*transcriptome*" OR description="*transcriptome*")'
    })
    expect(request.searchParams.has('offset')).toBe(false)
    expect(request.searchParams.get('fields')).not.toContain('ftp')
  })

  it.each([
    [{ tax_id: 2 }, 'tax_tree(2)'],
    [{ library_strategy: 'WGS' }, 'library_strategy="WGS"'],
    [{ keyword: "Crohn's & RNA" }, 'study_title="*Crohn\'s & RNA*"']
  ])('allows an independent filter %j without an implicit human default', async (args, query) => {
    const { call, fetchImpl } = setup([])
    await expect(call('ena_query_runs', args as Record<string, unknown>)).resolves.toMatchObject({
      n_runs_returned: 0,
      truncated: false,
      runs: []
    })
    const params = new URL(String(fetchImpl.mock.calls[0][0])).searchParams
    expect(params.get('query')).toContain(query)
    expect(params.get('query')).not.toContain('9606')
    expect(params.get('limit')).toBe('101')
  })

  it('keeps descendant taxa and distinguishes an exact limit from truncation', async () => {
    await expect(
      setup([{ run_accession: 'ERR1', tax_id: '562' }]).call('ena_query_runs', {
        tax_id: 2,
        limit: 1
      })
    ).resolves.toMatchObject({ truncated: false, runs: [{ tax_id: '562' }] })
  })

  it.each([
    {},
    { message: 'error' },
    [null],
    [{}],
    [{ run_accession: 'GSE1' }],
    [{ run_accession: runId }, { run_accession: runId }],
    [{ run_accession: runId, study_title: 1 }],
    [{ run_accession: 'ERR1' }, { run_accession: 'ERR2' }, { run_accession: 'ERR3' }]
  ])('rejects malformed or oversized search responses: %j', async (payload) => {
    await expect(setup(payload).call('ena_query_runs', { tax_id: 6239, limit: 1 })).rejects.toThrow(
      /Invalid ENA file report/
    )
  })

  it.each([
    {},
    { tax_id: null },
    { tax_id: -1 },
    { tax_id: '6239' },
    { library_strategy: 'RNA' },
    { keyword: '   ' },
    { keyword: '" OR tax_tree(9606)' },
    { keyword: '*worm*' },
    { keyword: 'worm\nRNA' },
    { tax_id: 6239, limit: 0 }
  ])('also rejects invalid arguments at the executor boundary: %j', async (args) => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('ena_query_runs'), args, {})
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([400, 403, 429, 500])('propagates HTTP %i', async (status) => {
    await expect(
      setup({ message: 'error' }, status).call('ena_query_runs', { keyword: 'worm' })
    ).rejects.toThrow(`HTTP ${status}`)
  })
})

describe('ena_get_submitted_files', () => {
  const submitted = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    run_accession: 'ERR10015065',
    library_layout: 'PAIRED',
    submitted_ftp: 'ftp.sra.ebi.ac.uk/vol1/run/ERR100/ERR10015065/44660_2#4.cram',
    submitted_format: 'CRAM',
    submitted_bytes: '34815792971',
    submitted_md5: '2b07424b27807998926f2624e5909fec',
    ...extra
  })
  const args = { run_accession: 'ERR10015065' }

  it('preserves literal # in submitted CRAM paths without treating it as a URL fragment', async () => {
    const { call, fetchImpl } = setup([submitted()])
    await expect(call('ena_get_submitted_files', args)).resolves.toEqual({
      ...args,
      found: true,
      library_layout: 'PAIRED',
      submitted_available: true,
      n_files: 1,
      submitted_files: [
        {
          file_index: 1,
          ftp_location: submitted().submitted_ftp,
          format: 'CRAM',
          size_bytes: 34815792971,
          md5: submitted().submitted_md5
        }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const params = new URL(String(fetchImpl.mock.calls[0][0])).searchParams
    expect(params.get('fields')).toBe(
      'run_accession,library_layout,submitted_ftp,submitted_format,submitted_bytes,submitted_md5'
    )
    expect(params.get('limit')).toBe('2')
  })

  it('retains file order and empty metadata positions without inferring paired mates', async () => {
    const { call } = setup([
      submitted({
        submitted_ftp: 'first.bam;second.cram;third.fastq.gz',
        submitted_format: 'BAM;;FASTQ',
        submitted_bytes: '0;;25',
        submitted_md5: `${'A'.repeat(32)};;${'c'.repeat(32)}`
      })
    ])
    await expect(call('ena_get_submitted_files', args)).resolves.toMatchObject({
      n_files: 3,
      submitted_files: [
        {
          file_index: 1,
          ftp_location: 'first.bam',
          format: 'BAM',
          size_bytes: 0,
          md5: 'a'.repeat(32)
        },
        { file_index: 2, ftp_location: 'second.cram', format: null, size_bytes: null, md5: null },
        {
          file_index: 3,
          ftp_location: 'third.fastq.gz',
          format: 'FASTQ',
          size_bytes: 25,
          md5: 'c'.repeat(32)
        }
      ]
    })
  })

  it('distinguishes a public run with no submitted files from no public run report', async () => {
    await expect(
      setup([
        submitted({
          submitted_ftp: '',
          submitted_format: '',
          submitted_bytes: '',
          submitted_md5: ''
        })
      ]).call('ena_get_submitted_files', args)
    ).resolves.toMatchObject({
      found: true,
      submitted_available: false,
      n_files: 0,
      submitted_files: []
    })
    await expect(setup([]).call('ena_get_submitted_files', args)).resolves.toMatchObject({
      found: false,
      submitted_available: false,
      n_files: 0,
      submitted_files: []
    })
  })

  it('preserves unknown metadata as null', async () => {
    await expect(
      setup([submitted({ submitted_format: '', submitted_bytes: null, submitted_md5: '' })]).call(
        'ena_get_submitted_files',
        args
      )
    ).resolves.toMatchObject({
      submitted_files: [{ format: null, size_bytes: null, md5: null }]
    })
  })

  it.each([
    { run_accession: 'ERR1' },
    { submitted_ftp: ';file.cram' },
    { submitted_ftp: '', submitted_bytes: '123' },
    { submitted_bytes: '1;2' },
    { submitted_bytes: '-1' },
    { submitted_bytes: '9007199254740992' },
    { submitted_md5: 'not-an-md5' },
    { submitted_md5: `${'a'.repeat(32)};${'b'.repeat(32)}` },
    { submitted_format: 'BAM;CRAM' },
    { submitted_ftp: 3 }
  ])('fails inconsistent or malformed submitted metadata: %j', async (extra) => {
    await expect(setup([submitted(extra)]).call('ena_get_submitted_files', args)).rejects.toThrow(
      /Invalid ENA file report/
    )
  })

  it.each(['submitted_ftp', 'submitted_bytes', 'submitted_md5', 'submitted_format'])(
    'rejects a missing requested %s field',
    async (field) => {
      const row = submitted()
      delete row[field]
      await expect(setup([row]).call('ena_get_submitted_files', args)).rejects.toThrow(
        `missing ${field}`
      )
    }
  )

  it.each(['PRJNA123835', 'SRX017289', 'GSM1'])(
    'requires a run rather than %s',
    async (run_accession) => {
      const { call, fetchImpl } = setup([])
      await expect(call('ena_get_submitted_files', { run_accession })).rejects.toThrow(
        /ERR, SRR or DRR/
      )
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it.each([400, 403, 404, 429, 500])('propagates HTTP %i', async (status) => {
    await expect(
      setup({ message: 'error' }, status).call('ena_get_submitted_files', args)
    ).rejects.toThrow(`HTTP ${status}`)
  })

  it('does not cache empty reports', async () => {
    const { call, fetchImpl } = setup([])
    await call('ena_get_submitted_files', args)
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify([submitted()])))
    await expect(call('ena_get_submitted_files', args)).resolves.toMatchObject({
      found: true,
      n_files: 1
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe.skipIf(!process.env.LIVE_API)('ENA live file reports', () => {
  it('discovers nonhuman RNA-Seq runs using taxonomy, strategy and keyword', async () => {
    const out = (await new ParserEngine().call(
      tool('ena_query_runs'),
      {
        tax_id: 6239,
        library_strategy: 'RNA-Seq',
        keyword: 'transcriptome',
        limit: 2
      },
      {}
    )) as { truncated: boolean; runs: Array<Record<string, unknown>> }
    expect(out.truncated).toBe(true)
    expect(out.runs).toHaveLength(2)
    expect(
      out.runs.every((run) => run.tax_id === '6239' && run.library_strategy === 'RNA-Seq')
    ).toBe(true)
  }, 120_000)

  it.each([
    ['ERR10015065', 'CRAM', 1],
    ['SRR14611230', 'BAM', 5]
  ])(
    'retrieves submitted files for %s through ParserEngine',
    async (run_accession, format, count) => {
      const out = (await new ParserEngine().call(
        tool('ena_get_submitted_files'),
        { run_accession },
        {}
      )) as {
        found: boolean
        n_files: number
        submitted_files: Array<Record<string, unknown>>
      }
      expect(out.found).toBe(true)
      expect(out.n_files).toBe(count)
      expect(
        out.submitted_files.every((file) => file.format === format && Number(file.size_bytes) > 0)
      ).toBe(true)
      if (format === 'CRAM') expect(out.submitted_files[0].ftp_location).toContain('#4.cram')
    },
    120_000
  )

  it('resolves an experiment and retrieves its known FASTQ through ParserEngine', async () => {
    const engine = new ParserEngine()
    const runs = await engine.call(tool('ena_search_runs'), { accession: 'SRX017289' }, {})
    expect(runs).toMatchObject({
      truncated: false,
      runs: [{ run_accession: runId, tax_id: '6239' }]
    })
    const files = await engine.call(tool('ena_get_run_files'), { run_accession: runId }, {})
    expect(files).toMatchObject({
      found: true,
      n_files: 1,
      fastq_files: [{ url: `ftp://${path}`, size_bytes: 25154397, md5 }]
    })
  }, 120_000)
})
