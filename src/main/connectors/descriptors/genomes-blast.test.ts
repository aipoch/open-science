import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolContext } from '../types'
import { GENOMES_BLAST_TOOLS } from './genomes-blast'

const [submit, status, results] = GENOMES_BLAST_TOOLS
const credentials = { ncbiEmail: 'tests+blast@example.org', ncbiApiKey: 'PRIVATE_KEY' }
const unused = async (): Promise<never> => {
  throw new Error('unexpected transport')
}
const ctx: ToolContext = {
  credentials,
  fetchJson: unused,
  fetchText: unused,
  fetchJsonWithHeaders: unused,
  postJson: unused,
  postForm: unused
}
const args = { sequence: '>query\nATGCATGC', molecule_type: 'nucleotide', database: 'nt' }
const receipt = 'QBlastInfoBegin\n RID = RID123\n RTOE = 12\nQBlastInfoEnd'
const report = JSON.stringify({ BlastOutput2: [{ report: { results: { search: { hits: [] } } } }] })
const realTabularReport = `<p><!--
QBlastInfoBegin
\tStatus=READY
QBlastInfoEnd
--><p>
<PRE>
# blastp
# Iteration: 0
# Query: public_P69905_HBA_HUMAN Status=WAITING
# RID: AYZN08MF016
# Database: swissprot
# Fields: query acc.ver, subject acc.ver, % identity, alignment length, mismatches, gap opens, q. start, q. end, s. start, s. end, evalue, bit score, % positives
# 5 hits found
public_P69905_HBA_HUMAN\tP69905.2\t100.000\t142\t0\t0\t1\t142\t1\t142\t1.99e-100\t286\t100.00
public_P69905_HBA_HUMAN\tP01923.1\t99.291\t141\t1\t0\t2\t142\t1\t141\t1.07e-98\t282\t100.00
public_P69905_HBA_HUMAN\tQ9TS35.2\t98.592\t142\t2\t0\t1\t142\t1\t142\t2.38e-98\t281\t99.30
public_P69905_HBA_HUMAN\tP06635.2\t97.887\t142\t3\t0\t1\t142\t1\t142\t3.58e-98\t281\t98.59
public_P69905_HBA_HUMAN\tP01924.1\t97.872\t141\t3\t0\t2\t142\t1\t141\t3.00e-97\t278\t98.58
</PRE>
`
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('BLAST submission receipt and lifecycle', () => {
  it('submits once with form encoding, retains the RID and sends email/tool but no API key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(receipt))
    vi.stubGlobal('fetch', fetchImpl)
    await expect(submit.run!(ctx, args)).resolves.toMatchObject({
      rid: 'RID123',
      rtoe_seconds: 12,
      poll_after_seconds: 60,
      program: 'blastn',
      requested_database: 'nt'
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [, init] = fetchImpl.mock.calls[0]
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const body = new URLSearchParams(init!.body as string)
    expect(body.get('QUERY')).toBe('>query\nATGCATGC')
    expect(body.get('email')).toBe(credentials.ncbiEmail)
    expect(body.get('tool')).toBe('open_science')
    expect(body.toString()).not.toContain(credentials.ncbiApiKey)
  })

  it.each(['network', 'http', 'missing-receipt', 'oversized'])(
    'reports uncertain %s without retry or echoed credentials',
    async (failure) => {
      const echo = `email=${credentials.ncbiEmail}&api_key=${credentials.ncbiApiKey}&QUERY=PRIVATE_SEQUENCE`
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (failure === 'network') throw new Error(echo)
        if (failure === 'http') return new Response(echo, { status: 503 })
        if (failure === 'oversized') return new Response('x'.repeat(256 * 1024 + 1))
        return new Response(`<html>${echo}</html>`)
      })
      vi.stubGlobal('fetch', fetchImpl)
      const error = await submit.run!(ctx, args).catch((e: Error) => e)
      expect(error).toMatchObject({
        name: 'BlastSubmissionUnknownError',
        code: 'blast_submission_unknown'
      })
      expect((error as Error).message).toContain('Do not automatically resubmit')
      expect((error as Error).message).not.toMatch(/PRIVATE_|tests/)
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  )

  it('times out a stalled response stream with uncertain submission and cancels its reader', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })))
    )
    const pending = new ParserEngine().call(submit, args, credentials).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toMatchObject({ code: 'blast_submission_unknown' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not dispatch an already cancelled request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchImpl)
    const signal = AbortSignal.abort()
    await expect(submit.run!({ ...ctx, signal }, args)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves caller cancellation during an in-flight submission', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      controller.abort()
      throw init!.signal!.reason
    })
    vi.stubGlobal('fetch', fetchImpl)
    await expect(submit.run!({ ...ctx, signal: controller.signal }, args)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects incompatible molecules before submission', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>())
    await expect(submit.run!(ctx, { ...args, molecule_type: 'protein' })).rejects.toThrow(
      'incompatible'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('documents remote expiry and local persistence limitations', () => {
    expect(submit.description).toContain('36 hours')
    expect(submit.description).toContain('not a deletion guarantee')
    expect(submit.description).toContain('uninstall')
    expect(submit.description).toContain('persistence may retain inputs and outputs')
  })
})

describe('BLAST GET through the engine', () => {
  it.each(['WAITING', 'READY', 'FAILED', 'UNKNOWN'])(
    'returns %s from one SearchInfo request',
    async (state) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`Status=${state}\n`))
      const out = await new ParserEngine({ fetchImpl }).call(status, { rid: 'RID123' }, credentials)
      expect(out).toMatchObject({ rid: 'RID123', status: state, ready: state === 'READY' })
      if (state === 'WAITING') expect(out).toHaveProperty('retry_after_seconds', 60)
      expect(fetchImpl).toHaveBeenCalledOnce()
      const url = new URL(String(fetchImpl.mock.calls[0][0]))
      expect(url.searchParams.get('FORMAT_OBJECT')).toBe('SearchInfo')
      expect(url.searchParams.get('email')).toBe(credentials.ncbiEmail)
      expect(url.searchParams.has('api_key')).toBe(false)
    }
  )

  it.each([status, results])(
    '$id does not retry a 503 and preserves Retry-After guidance without credentials',
    async (tool) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('', { status: 503, headers: { 'retry-after': '120' } }))
      const error = await new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
        .call(tool, { rid: 'RID123' }, credentials)
        .catch((e: Error) => e)
      expect((error as Error).message).toContain('120s')
      expect((error as Error).message).not.toContain(credentials.ncbiEmail)
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  )

  it('redacts raw and encoded credentials from network errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(
          `${credentials.ncbiEmail} ${encodeURIComponent(credentials.ncbiEmail)} ${credentials.ncbiApiKey}`
        )
      )
    const error = await new ParserEngine({ fetchImpl })
      .call(status, { rid: 'RID123' }, credentials)
      .catch((e: Error) => e)
    expect((error as Error).message).not.toMatch(/tests|PRIVATE_KEY/)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not echo an unrecognized status response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(`ERROR=${credentials.ncbiEmail}`))
    const error = await new ParserEngine({ fetchImpl })
      .call(status, { rid: 'RID123' }, credentials)
      .catch((e: Error) => e)
    expect((error as Error).message).toContain('no recognizable status')
    expect((error as Error).message).not.toContain(credentials.ncbiEmail)
  })

  it('uses the engine byte cap for results', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
    await expect(
      new ParserEngine({ fetchImpl }).call(results, { rid: 'RID123' }, credentials)
    ).rejects.toThrow('byte limit')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('cancels a GET using the engine signal without submitting a replacement', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      controller.abort()
      throw init!.signal!.reason
    })
    await expect(
      new ParserEngine({ fetchImpl }).call(
        status,
        { rid: 'RID123' },
        credentials,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('BLAST results format contract', () => {
  it.each(['WAITING', 'FAILED', 'UNKNOWN'])('keeps %s distinct from a report', async (state) => {
    const fetchText = vi.fn().mockResolvedValue(`Status=${state}`)
    expect(await results.run!({ ...ctx, fetchText }, { rid: 'RID123' })).toMatchObject({
      status: state,
      ready: false
    })
    expect(fetchText).toHaveBeenCalledWith(expect.any(String), undefined, { retry: false })
  })

  it.each([
    ['json2', 'JSON2_S', report],
    ['xml2', 'XML2_S', '<?xml version="1.0"?><BlastXML2><BlastOutput2/></BlastXML2>'],
    ['text', 'Text', '<!-- Status=READY --><PRE>BLASTN 2.17.0+\nNo hits found</PRE>'],
    [
      'tabular',
      'Text',
      '<!-- QBlastInfoBegin\nStatus=READY\nQBlastInfoEnd --><PRE># blastn\n# Fields: query, subject\n# 1 hit found\nquery\tsubject</PRE>'
    ],
    [
      'tabular',
      'Text',
      '<html><body><!-- QBlastInfoBegin\nStatus=READY\nQBlastInfoEnd --><PRE># blastn\n# Query: Status=WAITING\n# Fields: query, subject\n# 0 hits found\n</PRE></body></html>'
    ]
  ])(
    'preserves %s report bytes and selects the documented upstream format',
    async (format, expected, payload) => {
      const fetchText = vi.fn().mockResolvedValue(payload)
      expect(await results.run!({ ...ctx, fetchText }, { rid: 'RID123', format })).toEqual({
        rid: 'RID123',
        status: 'READY',
        ready: true,
        format,
        results: payload
      })
      const url = new URL(fetchText.mock.calls[0][0])
      expect(url.searchParams.get('FORMAT_TYPE')).toBe(expected)
      if (format === 'tabular') expect(url.searchParams.get('ALIGNMENT_VIEW')).toBe('Tabular')
    }
  )

  it.each(['WAITING', 'FAILED', 'UNKNOWN'])(
    'preserves reports containing Status=%s in titles',
    async (state) => {
      const title = `sample Status=${state}`
      const reports = [
        [
          'json2',
          JSON.stringify({
            BlastOutput2: [{ report: { results: { search: { query_title: title, hits: [] } } } }]
          })
        ],
        [
          'xml2',
          `<?xml version="1.0"?><BlastXML2><BlastOutput2><query-title>${title}</query-title></BlastOutput2></BlastXML2>`
        ],
        ['text', `BLASTN 2.17.0+\nQuery= ${title}\nNo hits found`],
        [
          'tabular',
          `<!-- QBlastInfoBegin\nStatus=READY\nQBlastInfoEnd --><PRE># blastn\n# Query: ${title}\n# Fields: query, subject\n# 0 hits found\n</PRE>`
        ]
      ]
      for (const [format, payload] of reports) {
        const fetchText = vi.fn().mockResolvedValue(payload)
        await expect(
          results.run!({ ...ctx, fetchText }, { rid: 'RID123', format })
        ).resolves.toMatchObject({
          status: 'READY',
          ready: true,
          results: payload
        })
      }
    }
  )

  it('accepts the real NCBI tabular report with a program-only header', async () => {
    const fetchText = vi.fn().mockResolvedValue(realTabularReport)
    await expect(
      results.run!({ ...ctx, fetchText }, { rid: 'AYZN08MF016', format: 'tabular' })
    ).resolves.toEqual({
      rid: 'AYZN08MF016',
      status: 'READY',
      ready: true,
      format: 'tabular',
      results: realTabularReport
    })
  })

  it('rejects a READY tabular envelope without fields or tabular structure', async () => {
    const fetchText = vi
      .fn()
      .mockResolvedValue(
        '<!-- QBlastInfoBegin\nStatus=READY\nQBlastInfoEnd --><PRE># blastp\n# 0 hits found</PRE>'
      )
    await expect(
      results.run!({ ...ctx, fetchText }, { rid: 'RID123', format: 'tabular' })
    ).rejects.toThrow('invalid result report')
  })

  it.each(['WAITING', 'FAILED', 'UNKNOWN'])(
    'reads %s only from the protocol block in HTML',
    async (state) => {
      const payload = `<html><body><!-- QBlastInfoBegin\n    Status=${state}\nQBlastInfoEnd --></body></html>`
      const fetchText = vi.fn().mockResolvedValue(payload)
      await expect(results.run!({ ...ctx, fetchText }, { rid: 'RID123' })).resolves.toMatchObject({
        status: state,
        ready: false
      })
      await expect(status.run!({ ...ctx, fetchText }, { rid: 'RID123' })).resolves.toMatchObject({
        status: state,
        ready: false
      })
    }
  )

  it('rejects status-looking text outside protocol metadata', async () => {
    const fetchText = vi.fn().mockResolvedValue('<html>Query: sample Status=WAITING</html>')
    await expect(results.run!({ ...ctx, fetchText }, { rid: 'RID123' })).rejects.toThrow(
      'invalid result report'
    )
    await expect(status.run!({ ...ctx, fetchText }, { rid: 'RID123' })).rejects.toThrow(
      'no recognizable status'
    )
  })

  it.each([
    '',
    '<html>email=PRIVATE</html>',
    '{"error":"PRIVATE"}',
    '{"BlastOutput2":[]}',
    '<!-- Status=READY -->'
  ])('does not classify malformed JSON results as READY', async (payload) => {
    const fetchText = vi.fn().mockResolvedValue(payload)
    const error = await results.run!({ ...ctx, fetchText }, { rid: 'RID123' }).catch(
      (e: Error) => e
    )
    expect((error as Error).message).toContain('invalid result report')
    expect((error as Error).message).not.toContain('PRIVATE')
  })

  it('fetches the same RID again instead of caching WAITING', async () => {
    const fetchText = vi.fn().mockResolvedValueOnce('Status=WAITING').mockResolvedValueOnce(report)
    expect(await results.run!({ ...ctx, fetchText }, { rid: 'RID123' })).toHaveProperty(
      'status',
      'WAITING'
    )
    expect(await results.run!({ ...ctx, fetchText }, { rid: 'RID123' })).toHaveProperty(
      'status',
      'READY'
    )
    expect(fetchText).toHaveBeenCalledTimes(2)
    expect(results.description).toContain('not pure TSV or CSV')
  })
})
