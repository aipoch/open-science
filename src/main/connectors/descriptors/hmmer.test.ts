import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { HMMER_TOOLS } from './hmmer'

const search = HMMER_TOOLS.find((tool) => tool.id === 'search')!
const status = HMMER_TOOLS.find((tool) => tool.id === 'status')!
const results = HMMER_TOOLS.find((tool) => tool.id === 'results')!
const API = 'https://www.ebi.ac.uk/Tools/hmmer/api/v1'
const job = '8ebb1d5f-4457-4da8-808c-f811105c3654'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HMMER reads through the shared engine', () => {
  it('submits the program in the URL and returns the provider job receipt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: job }), { status: 200 }))

    await expect(
      new ParserEngine({ fetchImpl }).call(
        search,
        { program: 'phmmer', database: 'pdb', input: '>query\nMKT' },
        {}
      )
    ).resolves.toEqual({
      job_id: job,
      program: 'phmmer',
      database: 'pdb',
      status: 'SUBMITTED'
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/search/phmmer`)
    const request = fetchImpl.mock.calls[0][1] as RequestInit
    expect(request.method).toBe('POST')
    expect(JSON.parse(request.body as string)).toEqual({ database: 'pdb', input: '>query\nMKT' })
  })

  it('preserves pending provider states without treating them as empty results', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ task: { status: 'RUNNING' } }), { status: 200 })
      )

    await expect(
      new ParserEngine({ fetchImpl }).call(status, { job_id: job }, {})
    ).resolves.toEqual({
      job_id: job,
      status: 'RUNNING',
      ready: false,
      poll_after_seconds: 10
    })
    expect(fetchImpl).toHaveBeenCalledWith(`${API}/search/${job}`, expect.anything())
  })

  it('returns the complete JSON result only after SUCCESS', async () => {
    const payload = {
      status: 'SUCCESS',
      result: { stats: { total: 1 }, hits: [{ target: 'PF00001', score: 42 }] },
      page_count: 1
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { status: 'SUCCESS' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload)))

    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).resolves.toEqual({ job_id: job, status: 'SUCCESS', ready: true, result: payload })
    expect(fetchImpl.mock.calls[1][0]).toBe(
      `${API}/result/${job}?page=1&page_size=50&with_domains=true`
    )
  })

  it('merges paginated hits and accepts jackhmmer iteration arrays', async () => {
    const first = {
      status: 'SUCCESS',
      result: { stats: { total: 2 }, hits: [{ target: 'A' }] },
      page_count: 2
    }
    const second = { status: 'SUCCESS', result: { hits: [{ target: 'B' }] }, page_count: 2 }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { status: 'SUCCESS' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(new Response(JSON.stringify(second)))

    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).resolves.toEqual({
      job_id: job,
      status: 'SUCCESS',
      ready: true,
      result: {
        ...first,
        result: { stats: { total: 2 }, hits: [{ target: 'A' }, { target: 'B' }] }
      }
    })

    const jackFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { status: 'SUCCESS' } })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: job, status: 'SUCCESS', iteration: 1, convergence_stats: null }])
        )
      )
    await expect(
      new ParserEngine({ fetchImpl: jackFetch }).call(results, { job_id: job }, {})
    ).resolves.toEqual({
      job_id: job,
      status: 'SUCCESS',
      ready: true,
      result: [{ id: job, status: 'SUCCESS', iteration: 1, convergence_stats: null }]
    })
  })

  it('fails instead of claiming a non-empty result is complete without page_count', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { status: 'SUCCESS' } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'SUCCESS', result: { hits: [{ target: 'A' }] } }))
      )

    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).rejects.toThrow('page count')
  })

  it('rejects results beyond the page budget before fetching more pages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { status: 'SUCCESS' } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'SUCCESS', result: { hits: [] }, page_count: 101 }))
      )

    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).rejects.toThrow('too many pages')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects an aggregate result larger than the output budget', async () => {
    const largeHit = { target: 'A', annotation: 'x'.repeat(4_300_000) }
    const first = {
      status: 'SUCCESS',
      result: { hits: [largeHit] },
      page_count: 2
    }
    const second = { status: 'SUCCESS', result: { hits: [largeHit] }, page_count: 2 }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { status: 'SUCCESS' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(new Response(JSON.stringify(second)))

    await expect(
      new ParserEngine({ fetchImpl }).call(results, { job_id: job }, {})
    ).rejects.toThrow('8 MiB')
  })

  it('rejects invalid hmmscan databases before making a request', async () => {
    const fetchImpl = vi.fn()

    await expect(
      new ParserEngine({ fetchImpl }).call(
        search,
        { program: 'hmmscan', database: 'uniprot', input: 'MKT' },
        {}
      )
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    { program: 'phmmer', database: 'pdb', input: 'MKT', iterations: 2 },
    { program: 'hmmsearch', database: 'pdb', input: 'HMMER3/f', mx: 'BLOSUM62' },
    { program: 'hmmscan', database: 'pfam', input: 'MKT', popen: 0.02 }
  ])('rejects options that are invalid for the selected program', async (args) => {
    const fetchImpl = vi.fn()

    await expect(new ParserEngine({ fetchImpl }).call(search, args, {})).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts gap and matrix options for jackhmmer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: job }), { status: 200 }))
    await expect(
      new ParserEngine({ fetchImpl }).call(
        search,
        { program: 'jackhmmer', database: 'pdb', input: 'MKT', popen: 0.02, mx: 'BLOSUM62' },
        {}
      )
    ).resolves.toMatchObject({ job_id: job })
  })

  it.each([{ popen: 0.4999995 }, { pextend: 0.9999995 }])(
    'accepts provider boundary values for jackhmmer',
    async (options) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ id: job }), { status: 200 }))
      await expect(
        new ParserEngine({ fetchImpl }).call(
          search,
          { program: 'jackhmmer', database: 'pdb', input: 'MKT', ...options },
          {}
        )
      ).resolves.toMatchObject({ job_id: job })
    }
  )

  it('does not retry an uncertain submission after an upstream failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 503 }))

    await expect(
      new ParserEngine({ fetchImpl, retries: 2 }).call(
        search,
        { program: 'phmmer', database: 'pdb', input: 'MKT' },
        {}
      )
    ).rejects.toThrow('submission outcome is uncertain')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
