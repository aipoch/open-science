import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { INTERPROSCAN_TOOLS } from './interproscan'

const [submit, status, results] = INTERPROSCAN_TOOLS
const API = 'https://www.ebi.ac.uk/Tools/services/rest/iprscan5'
const job = 'iprscan5-R20260922-123456-0123-12345678-p1m'
const legacyJob = 'iprscan-S20110708-094729-0726-35857540-pg'
const credentials = { ncbiEmail: 'tests+interpro@example.org' }
// Documented TSV: 11 mandatory fields plus optional InterPro accession/description, GO and pathways.
const row =
  'query\t0123456789abcdef0123456789abcdef\t18\tPfam\tPF00001\tExample domain\t2\t17\t1.2E-8\tT\t22-09-2026\tIPR000001\tExample family\tGO:0005515\tReactome:R-HSA-1'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const submissionEngine = (fetchImpl: typeof fetch): ParserEngine => {
  vi.stubGlobal('fetch', fetchImpl)
  return new ParserEngine({ fetchImpl, retries: 2 })
}

describe('InterProScan submission', () => {
  it('submits normalized FASTA once and returns the exact resumable job id without polling', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${job}\n`))
    await expect(
      submissionEngine(fetchImpl).call(
        submit,
        { sequence: '  >query\r\nm k t\r\n >second\r\na a a', title: 'test protein' },
        { ...credentials, ncbiApiKey: 'PRIVATE_KEY' }
      )
    ).resolves.toEqual({
      job_id: job,
      status: 'SUBMITTED',
      ready: false,
      sequence_count: 2,
      poll_after_seconds: 10
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/run`)
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { accept: 'text/plain', 'content-type': 'application/x-www-form-urlencoded' }
    })
    const body = new URLSearchParams(init!.body as string)
    expect(Object.fromEntries(body)).toEqual({
      email: credentials.ncbiEmail,
      sequence: '>query\nMKT\n>second\nAAA',
      stype: 'p',
      goterms: 'true',
      pathways: 'true',
      title: 'test protein'
    })
    expect(body.toString()).not.toContain('PRIVATE_KEY')
  })

  it.each([
    [{}, 'contact_email_required'],
    [{ ncbiEmail: 'invalid-address' }, 'contact_email_invalid']
  ])('requires a valid contact email before dispatch (%j)', async (auth, message) => {
    const fetchImpl = vi.fn<typeof fetch>()
    const pending = submissionEngine(fetchImpl).call(submit, { sequence: 'MKT' }, auth)
    await expect(pending).rejects.toThrow(message)
    for (const guidance of [
      'Settings → Credentials → Literature access',
      'This email is sent to EMBL-EBI when submitting a job.'
    ]) {
      await expect(pending).rejects.toThrow(guidance)
      expect(submit.description).toContain(guidance)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['an oversized sequence', 'M'.repeat(10_001), '10000-residue'],
    [
      'an oversized batch',
      Array.from({ length: 1_001 }, (_, i) => `>p${i}\nM`).join('\n'),
      '1000-sequence'
    ],
    ['digits', 'MK1', 'invalid protein'],
    ['gaps', 'MK-T', 'invalid protein'],
    ['dots', 'MK.T', 'invalid protein'],
    ['stops', 'MKT*', 'invalid protein'],
    ['non-ASCII residues', 'MKß', 'invalid protein'],
    ['empty input', '  ', 'non-empty'],
    ['empty record', '>p1\n>p2\nM', 'no residues'],
    ['empty header', '>\nM', 'non-empty header'],
    ['duplicate IDs', '>p description\nM\n>p other\nM', 'unique'],
    ['missing first header', 'M\n>p\nM', 'start with a header'],
    ['oversized input', 'M'.repeat(4 * 1024 * 1024 + 1), 'Too big']
  ])('rejects %s before submission', async (_label, sequence, message) => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      submissionEngine(fetchImpl).call(submit, { sequence }, credentials)
    ).rejects.toThrow(message)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['m'.repeat(10_000), 1, `>query\n${'M'.repeat(10_000)}`],
    [Array.from({ length: 1_000 }, (_, i) => `>p${i}\nM`).join('\n'), 1_000, undefined]
  ])('accepts sequence and batch limits', async (sequence, count, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(job))
    await expect(
      submissionEngine(fetchImpl).call(submit, { sequence }, credentials)
    ).resolves.toMatchObject({ sequence_count: count })
    const body = new URLSearchParams(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.get('sequence')).toBe(expected ?? sequence)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('caps the encoded form including FASTA headers, email and title', async () => {
    const sequence = Array.from({ length: 419 }, (_, i) => `>p${i}\n${'M'.repeat(10_000)}`).join(
      '\n'
    )
    expect(new TextEncoder().encode(sequence).byteLength).toBeLessThan(4 * 1024 * 1024)
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      submissionEngine(fetchImpl).call(submit, { sequence, title: '测'.repeat(200) }, credentials)
    ).rejects.toThrow('encoded submission exceeds')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    '',
    'ERROR',
    'ERROR invalid sequence',
    `${job} extra`,
    `${job}\n${job}`,
    '<html>failure</html>',
    'clustalo-wrong-service',
    'iprscan5-'
  ])('rejects malformed receipts without retrying (%s)', async (receipt) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(receipt))
    await expect(
      submissionEngine(fetchImpl).call(submit, { sequence: 'MKT' }, credentials)
    ).rejects.toThrow('submission outcome is uncertain')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([400, 413, 422, 429, 503, 307, 308])(
    'does not retry HTTP %i or expose upstream bodies',
    async (code) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('private protein and email', { status: code }))
      await expect(
        submissionEngine(fetchImpl).call(submit, { sequence: 'MKT' }, credentials)
      ).rejects.toThrow(
        [400, 413, 422].includes(code)
          ? `submission rejected (HTTP ${code})`
          : 'submission outcome is uncertain'
      )
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('error')
    }
  )

  it('does not retry or expose transport errors after a lost receipt', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(credentials.ncbiEmail))
    const pending = submissionEngine(fetchImpl).call(submit, { sequence: 'MKT' }, credentials)
    await expect(pending).rejects.toThrow('Do not resubmit automatically')
    await expect(pending).rejects.not.toThrow(credentials.ncbiEmail)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('cancels an oversized receipt stream without returning a truncated success', async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${job}\n${'x'.repeat(16 * 1024)}`))
        },
        cancel
      })
    )
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(
      submissionEngine(fetchImpl).call(submit, { sequence: 'MKT' }, credentials)
    ).rejects.toThrow('submission outcome is uncertain')
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each(['headers', 'body'])(
    'times out stalled %s before the engine deadline, without retrying',
    async (phase) => {
      vi.useFakeTimers()
      const cancel = vi.fn()
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        if (phase === 'body') return new Response(new ReadableStream({ cancel }))
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          })
        })
      })
      const rejected = expect(
        submissionEngine(fetchImpl).call(submit, { sequence: 'MKT' }, credentials)
      ).rejects.toThrow('submission outcome is uncertain')
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true)
      if (phase === 'body') expect(cancel).toHaveBeenCalledOnce()
    }
  )

  it('does not dispatch when already cancelled and aborts an in-flight local request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          })
        })
    )
    const engine = submissionEngine(fetchImpl)
    const controller = new AbortController()
    const rejected = expect(
      engine.call(submit, { sequence: 'MKT' }, credentials, controller.signal)
    ).rejects.toThrow('cancelled')
    controller.abort(new Error('cancelled'))
    await rejected
    expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true)
    await expect(
      engine.call(submit, { sequence: 'MKT' }, credentials, controller.signal)
    ).rejects.toThrow('cancelled')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(submit.description).toContain('stop local requests only')
  })

  it('hands the returned receipt to explicit status and results calls', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(job))
      .mockResolvedValueOnce(new Response('RUNNING'))
      .mockResolvedValueOnce(new Response('FINISHED'))
      .mockResolvedValueOnce(new Response(row))
    const engine = submissionEngine(fetchImpl)
    const receipt = (await engine.call(submit, { sequence: 'MKT' }, credentials)) as {
      job_id: string
    }
    expect(fetchImpl).toHaveBeenCalledOnce()
    await expect(engine.call(status, { job_id: receipt.job_id }, {})).resolves.toMatchObject({
      status: 'RUNNING'
    })
    await expect(engine.call(results, { job_id: receipt.job_id }, {})).resolves.toMatchObject({
      ready: true,
      data: row
    })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${API}/run`,
      `${API}/status/${job}`,
      `${API}/status/${job}`,
      `${API}/result/${job}/tsv`
    ])
  })
})

describe('InterProScan reads through the shared engine', () => {
  it.each(['PENDING', 'QUEUED', 'RUNNING', 'FINISHED', 'ERROR', 'FAILURE', 'NOT_FOUND'])(
    'preserves %s and never polls',
    async (state) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(`${state}\n`))
      await expect(
        new ParserEngine({ fetchImpl }).call(status, { job_id: job }, {})
      ).resolves.toMatchObject({
        job_id: job,
        status: state,
        ready: state === 'FINISHED',
        poll_after_seconds: ['PENDING', 'QUEUED', 'RUNNING'].includes(state) ? 10 : null
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/status/${job}`)
    }
  )

  it('accepts provider job receipts without requiring the current prefix', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('NOT_FOUND'))
    await expect(
      new ParserEngine({ fetchImpl }).call(status, { job_id: legacyJob }, {})
    ).resolves.toMatchObject({ job_id: legacyJob, status: 'NOT_FOUND', ready: false })
    expect(fetchImpl).toHaveBeenCalledWith(`${API}/status/${legacyJob}`, expect.anything())
  })

  it.each([status, results])('rejects path injection before fetching $id', async (tool) => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool, { job_id: 'iprscan5-../x' }, {})
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['QUEUED', 'RUNNING', 'ERROR', 'FAILURE', 'NOT_FOUND'])(
    'does not confuse %s with zero matches or fetch a report',
    async (state) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(state))
      await expect(
        new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
      ).resolves.toEqual({ job_id: job, status: state, ready: false })
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  )

  it('preserves all TSV columns and rows, with inclusive coordinates and original scores', async () => {
    const data = `${row}\n${row}\n`
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('FINISHED'))
      .mockResolvedValueOnce(new Response(data))
    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).resolves.toEqual({
      job_id: job,
      status: 'FINISHED',
      ready: true,
      format: 'tsv',
      n_matches: 2,
      data
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][0]).toBe(`${API}/result/${job}/tsv`)
  })

  it('accepts a finished zero-match result', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('FINISHED'))
      .mockResolvedValueOnce(new Response(''))
    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).resolves.toMatchObject({ ready: true, n_matches: 0, data: '' })
  })

  it.each([
    '<html>failure</html>',
    'RUNNING',
    row.replace('\t2\t17\t', '\t18\t19\t'),
    row.replace('\tT\t', '\tF\t')
  ])('rejects malformed result bodies', async (data) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('FINISHED'))
      .mockResolvedValueOnce(new Response(data))
    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).rejects.toThrow('invalid TSV report')
  })

  it('rejects unknown status replies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>proxy error</html>'))
    await expect(new ParserEngine({ fetchImpl }).call(status, { job_id: job }, {})).rejects.toThrow(
      'unrecognized job status'
    )
  })

  it.each([status, results])('does not retry transient GET errors for $id', async (tool) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    await expect(new ParserEngine({ fetchImpl }).call(tool, { job_id: job }, {})).rejects.toThrow(
      'HTTP 503'
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('fails oversized results without returning a truncated success or retrying', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('FINISHED'))
      .mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).rejects.toThrow('byte limit')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
