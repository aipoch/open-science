import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { INTERPROSCAN_TOOLS } from './interproscan'

const [status, results] = INTERPROSCAN_TOOLS
const API = 'https://www.ebi.ac.uk/Tools/services/rest/iprscan5'
const job = 'iprscan5-R20260922-123456-0123-12345678-p1m'
const legacyJob = 'iprscan-S20110708-094729-0726-35857540-pg'
// Documented TSV: 11 mandatory fields plus optional InterPro accession/description, GO and pathways.
const row =
  'query\t0123456789abcdef0123456789abcdef\t18\tPfam\tPF00001\tExample domain\t2\t17\t1.2E-8\tT\t22-09-2026\tIPR000001\tExample family\tGO:0005515\tReactome:R-HSA-1'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
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
