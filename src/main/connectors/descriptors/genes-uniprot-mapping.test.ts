import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENES_UNIPROT_MAPPING_TOOLS } from './genes-uniprot-mapping'

const submit = 'submit_uniprot_id_mapping'
const status = 'get_uniprot_id_mapping_status'
const results = 'get_uniprot_id_mapping_results'
const job = 'aQoMsmJlHz'
const base = `https://rest.uniprot.org/idmapping/results/${job}`
const submission = { from_db: 'UniProtKB_AC-ID', to_db: 'GeneID', ids: ['P04637'] }
const response = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { headers })
const link = (cursor = 'next+/token=='): string =>
  `<${base}?format=json&cursor=${encodeURIComponent(cursor)}&size=2>; rel="next"`
const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as typeof fetch, retryBackoffMs: 1 }).call(
    GENES_UNIPROT_MAPPING_TOOLS.find((tool) => tool.id === id)!,
    args,
    {}
  )

describe('UniProt ID mapping submission', () => {
  it('submits multipart once, preserves case/versions and reports exact deduplication', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ jobId: job }))
    expect(
      await run(
        submit,
        {
          from_db: 'Gene_Name',
          to_db: 'UniProtKB',
          ids: ['TP53', 'TP53', 'tp53', 'ENSG00000141510.18'],
          taxon_id: 9606
        },
        fetchImpl
      )
    ).toEqual({
      job_id: job,
      from_db: 'Gene_Name',
      to_db: 'UniProtKB',
      taxon_id: 9606,
      n_input: 4,
      n_submitted: 3,
      n_duplicates_removed: 1
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://rest.uniprot.org/idmapping/run')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBeUndefined()
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({
      from: 'Gene_Name',
      to: 'UniProtKB',
      ids: 'TP53,tp53,ENSG00000141510.18',
      taxId: '9606'
    })
  })

  it('omits an unspecified taxon and returns the job receipt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ jobId: job }))
    await expect(run(submit, submission, fetchImpl)).resolves.toMatchObject({
      taxon_id: null,
      n_submitted: 1
    })
    expect(fetchImpl.mock.calls[0][1].body.has('taxId')).toBe(false)
  })

  it('reports HTTP 400 as a rejected submission requiring parameter correction', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: ["The combination of 'from=GeneID' and 'to=Ensembl' parameters is invalid"]
        }),
        { status: 400 }
      )
    )
    const error = await run(
      submit,
      { ...submission, from_db: 'GeneID', to_db: 'Ensembl' },
      fetchImpl
    ).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('submission was rejected (HTTP 400)')
    expect((error as Error).message).toContain('Correct the parameters before submitting again')
    expect((error as Error).message).toContain('do not retry unchanged')
    expect((error as Error).message).not.toContain('unconfirmed')
    expect((error as Error).message).not.toContain('remote job may already exist')
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['http', 'network', 'malformed', 'invalid-json'])(
    'never retries an uncertain %s submission',
    async (kind) => {
      const fetchImpl = vi.fn()
      if (kind === 'network') fetchImpl.mockRejectedValue(new TypeError('connection lost'))
      else
        fetchImpl.mockResolvedValue(
          kind === 'http'
            ? new Response('', { status: 503, headers: { 'retry-after': '3' } })
            : kind === 'invalid-json'
              ? new Response('{')
              : response({})
        )
      const error = await run(submit, submission, fetchImpl).catch((error: Error) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('submission outcome is unconfirmed')
      expect((error as Error).message).toContain('Do not automatically resubmit')
      expect((error as Error).message).not.toContain('Retry after')
      expect((error as Error).cause).toBeInstanceOf(Error)
      if (kind === 'http') expect((error as Error).message).toContain('HTTP 503')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([{}, { jobId: '../escape' }, { jobId: 123 }])(
    'rejects invalid job receipts %j',
    async (body) => {
      await expect(
        run(submit, submission, vi.fn().mockResolvedValue(response(body)))
      ).rejects.toThrow()
    }
  )
})

describe('UniProt ID mapping status', () => {
  it.each(['NEW', 'RUNNING', 'FINISHED'] as const)('reports %s without polling', async (value) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ jobStatus: value }))
    await expect(run(status, { job_id: job }, fetchImpl)).resolves.toEqual({
      job_id: job,
      status: value,
      ready: value === 'FINISHED',
      messages: []
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://rest.uniprot.org/idmapping/status/${job}`)
  })

  it.each([400, 500])(
    'normalizes terminal HTTP %s ERROR without retries and retains every reason',
    async (httpStatus) => {
      const fetchImpl = vi.fn().mockImplementation(
        () =>
          new Response(
            JSON.stringify({
              jobStatus: 'ERROR',
              errors: [
                { code: 40, message: 'Mapping result limit exceeded' },
                { code: 41, message: 'Narrow the input' }
              ]
            }),
            { status: httpStatus, headers: { 'retry-after': '0' } }
          )
      )
      await expect(run(status, { job_id: job }, fetchImpl)).resolves.toEqual({
        job_id: job,
        status: 'FAILED',
        ready: false,
        messages: ['[40] Mapping result limit exceeded', '[41] Narrow the input']
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it('recognizes an HTTP 500 terminal ERROR with no optional details', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ jobStatus: 'ERROR' }), { status: 500 }))
    await expect(run(status, { job_id: job }, fetchImpl)).resolves.toEqual({
      job_id: job,
      status: 'FAILED',
      ready: false,
      messages: []
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    { messages: ['Invalid request'] },
    { results: [] },
    { jobStatus: 'RUNNING' },
    { jobStatus: 'FINISHED' },
    { jobStatus: 'ERROR', errors: [{ code: '40', message: 'bad code' }] }
  ])(
    'does not interpret an unrecognized HTTP 500 body as a terminal job result: %j',
    async (body) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 500 }))
      await expect(run(status, { job_id: job }, fetchImpl)).rejects.toThrow()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves generic HTTP 400 validation messages while throwing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: ['Invalid request'] }), { status: 400 })
      )
    await expect(run(status, { job_id: job }, fetchImpl)).rejects.toThrow(
      'HTTP 400 for UniProt mapping status: Invalid request'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    { results: [{ from: 'TP53', to: { primaryAccession: 'P04637' } }] },
    { failedIds: ['NOT_A_REAL_PROTEIN'] },
    { results: [], failedIds: [] }
  ])('recognizes a followed completion redirect, including all unmatched: %j', async (body) => {
    await expect(
      run(status, { job_id: job }, vi.fn().mockResolvedValue(response(body)))
    ).resolves.toMatchObject({ status: 'FINISHED', ready: true })
  })

  it.each([
    {},
    { jobStatus: 'UNRECOGNIZED' },
    { jobStatus: 'FAILED' },
    { results: true },
    { messages: ['failed'] },
    { results: [], errors: [{ code: 40, message: 'failed' }] }
  ])('does not report malformed/error status as success: %j', async (body) => {
    await expect(
      run(status, { job_id: job }, vi.fn().mockResolvedValue(response(body)))
    ).rejects.toThrow()
  })

  it.each([404, 410])(
    'propagates unknown/expired job HTTP %s without resubmission',
    async (code) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: code }))
      await expect(run(status, { job_id: job }, fetchImpl)).rejects.toThrow(String(code))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )
})

describe('UniProt ID mapping results', () => {
  it('preserves all pairs, page-local one-to-many and upstream unmatched IDs', async () => {
    const records = [
      { from: 'P04637', to: '7157' },
      { from: 'P04637', to: '22059' },
      { from: 'P04637', to: '7157' }
    ]
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ results: records, failedIds: ['missing'] }, { 'x-total-results': '3' })
      )
    await expect(run(results, { job_id: job }, fetchImpl)).resolves.toEqual({
      job_id: job,
      page_size: 100,
      n_records: 3,
      total_results: 3,
      has_more: false,
      next_cursor: null,
      records,
      failed_ids: ['missing'],
      one_to_many_in_page: [{ from: 'P04637', to: ['7157', '22059'] }]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fetches one page per call and preserves a source spanning two pages', async () => {
    const firstPair = { from: 'P04637', to: '7157' }
    const lastPair = { from: 'P04637', to: '22059' }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { results: [firstPair], failedIds: ['missing'] },
          {
            link: link(),
            'x-total-results': '2'
          }
        )
      )
      .mockResolvedValueOnce(response({ results: [lastPair] }, { 'x-total-results': '2' }))
    const first = await run(results, { job_id: job, page_size: 1 }, fetchImpl)
    expect(first).toMatchObject({
      has_more: true,
      next_cursor: 'next+/token==',
      one_to_many_in_page: []
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const last = await run(
      results,
      { job_id: job, page_size: 1, cursor: 'next+/token==' },
      fetchImpl
    )
    expect(last).toMatchObject({
      has_more: false,
      next_cursor: null,
      records: [lastPair],
      failed_ids: []
    })
    const nextUrl = new URL(fetchImpl.mock.calls[1][0])
    expect(nextUrl.origin + nextUrl.pathname).toBe(base)
    expect(Object.fromEntries(nextUrl.searchParams)).toEqual({
      format: 'json',
      size: '1',
      cursor: 'next+/token=='
    })
  })

  it.each([{ failedIds: ['missing'] }, { results: [], failedIds: [] }])(
    'handles an empty or all-unmatched job: %j',
    async (body) => {
      await expect(
        run(
          results,
          { job_id: job },
          vi.fn().mockResolvedValue(response(body, { 'x-total-results': '0' }))
        )
      ).resolves.toMatchObject({
        n_records: 0,
        total_results: 0,
        records: [],
        has_more: false,
        failed_ids: body.failedIds
      })
    }
  )

  it('does not invent totals or one-to-many for repeated identical pairs', async () => {
    const record = { from: 'P04637', to: '7157' }
    await expect(
      run(
        results,
        { job_id: job },
        vi.fn().mockResolvedValue(response({ results: [record, record] }))
      )
    ).resolves.toMatchObject({
      n_records: 2,
      total_results: null,
      one_to_many_in_page: []
    })
  })

  it.each([
    {},
    { results: null },
    { results: {} },
    { results: [{ from: 'P04637' }] },
    { results: [{ from: 'P04637', to: { primaryAccession: 'P04637' } }] },
    { results: [], failedIds: [123] },
    { results: [], messages: ['error'] },
    { jobStatus: 'RUNNING' }
  ])(
    'rejects malformed or pending pages rather than claiming an empty result: %j',
    async (body) => {
      await expect(
        run(results, { job_id: job }, vi.fn().mockResolvedValue(response(body)))
      ).rejects.toThrow()
    }
  )

  it.each([
    'bad link',
    '<https://evil.example/idmapping/results/aQoMsmJlHz?cursor=x>; rel="next"',
    `<${base.replace('https:', 'http:')}?cursor=x>; rel="next"`,
    '<https://rest.uniprot.org/idmapping/results/another?cursor=x>; rel="next"',
    `<${base}?cursor=x#fragment>; rel="next"`,
    `<${base}?cursor=x&cursor=y>; rel="next"`,
    `<${base}>; rel="next"`,
    link('same'),
    `${link()}, ${link('other')}`
  ])('rejects unsafe or unusable pagination: %s', async (next) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response({ results: [{ from: 'P04637', to: '7157' }] }, { link: next }))
    await expect(run(results, { job_id: job, cursor: 'same' }, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each<{ records: { from: string; to: string }[]; headers: Record<string, string> }>([
    { records: [], headers: { link: link() } },
    { records: [{ from: 'a', to: 'b' }], headers: { 'x-total-results': '2' } },
    { records: [{ from: 'a', to: 'b' }], headers: { 'x-total-results': '0' } },
    { records: [{ from: 'a', to: 'b' }], headers: { 'x-total-results': '1', link: link() } },
    { records: [], headers: { 'x-total-results': 'not-a-number' } },
    { records: [], headers: { 'x-total-results': '9007199254740992' } },
    {
      records: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' }
      ],
      headers: {}
    }
  ])('fails closed on inconsistent page metadata: %j', async ({ records, headers }) => {
    await expect(
      run(
        results,
        { job_id: job, page_size: 1 },
        vi.fn().mockResolvedValue(response({ results: records }, headers))
      )
    ).rejects.toThrow()
  })
})

describe('UniProt ID mapping input and engine contracts', () => {
  it.each([
    [submit, { ...submission, ids: [] }],
    [submit, { ...submission, ids: ['P04637,P00533'] }],
    [submit, { ...submission, ids: [' '] }],
    [submit, { ...submission, ids: [7157] }],
    [submit, { ...submission, from_db: '../GeneID' }],
    [submit, { ...submission, to_db: '' }],
    [submit, { ...submission, taxon_id: 9606 }],
    [submit, { ...submission, from_db: 'Gene_Name', taxon_id: '9606' }],
    [submit, { ...submission, from_db: 'Gene_Name', taxon_id: 0 }],
    [submit, { ...submission, extra: true }],
    [status, { job_id: '../job' }],
    [status, { job_id: job, cursor: 'x' }],
    [results, { job_id: job, page_size: 0 }],
    [results, { job_id: job, page_size: 501 }],
    [results, { job_id: job, page_size: 1.5 }],
    [results, { job_id: job, page_size: '1' }],
    [results, { job_id: job, cursor: '' }],
    [results, { job_id: job, cursor: 'bad token' }],
    [results, { job_id: job, url: 'https://evil.example' }]
  ])('rejects %s invalid input in both registry and handler: %j', async (id, args) => {
    const fetchImpl = vi.fn()
    await expect(run(id, args, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts the batch limit and rejects overflow without silently truncating', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ jobId: job }))
    const args = { ...submission, ids: Array.from({ length: 100_000 }, (_, i) => `id${i}`) }
    await expect(run(submit, args, fetchImpl)).resolves.toMatchObject({ n_submitted: 100_000 })
    const overflow = { ...args, ids: [...args.ids, 'extra'] }
    await expect(run(submit, overflow, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation before submitting', async () => {
    const fetchImpl = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await expect(
      new ParserEngine({ fetchImpl }).call(
        GENES_UNIPROT_MAPPING_TOOLS.find((tool) => tool.id === submit)!,
        submission,
        {},
        controller.signal
      )
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
