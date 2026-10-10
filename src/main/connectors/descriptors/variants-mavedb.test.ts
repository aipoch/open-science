import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { VARIANTS_MAVEDB_TOOLS } from './variants-mavedb'
import type { ToolDescriptor } from '../../connector-core/types'

const SCORE_SET = 'urn:mavedb:00000003-a-1'
const EXPERIMENT = 'urn:mavedb:00000003-a'
const BASE = 'https://api.mavedb.org/api/v1'
const path = `${BASE}/score-sets/${encodeURIComponent(SCORE_SET)}`
const tool = (id: string): ToolDescriptor =>
  VARIANTS_MAVEDB_TOOLS.find((descriptor) => descriptor.id === `mavedb_${id}`)!
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('MaveDB public variant effect data', () => {
  it('POSTs public search pagination in the JSON body without credentials', async () => {
    const row = { urn: SCORE_SET, numVariants: 2, targetGenes: [{ name: 'BRCA1' }] }
    const fetchImpl = vi.fn().mockResolvedValue(json({ scoreSets: [row], numScoreSets: 62 }))
    const result = await new ParserEngine({ fetchImpl }).call(
      tool('search_score_sets'),
      { text: ' BRCA1 ', offset: 20, limit: 1 },
      {}
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BASE}/score-sets/search`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ text: 'BRCA1', published: true, offset: 20, limit: 1 })
    expect(new Headers(init.headers).has('x-api-key')).toBe(false)
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    expect(result).toEqual({
      text: 'BRCA1',
      offset: 20,
      limit: 1,
      total: 62,
      next_offset: 21,
      score_sets: [row]
    })
  })

  it.each([
    [{ scoreSets: [], numScoreSets: 0 }, 0, 0],
    [{ scoreSets: [], numScoreSets: 20 }, 20, null],
    [{ scoreSets: [], numScoreSets: 1 }, 20, null],
    [{ scoreSets: [{ urn: SCORE_SET }], numScoreSets: 1 }, 0, 1],
    [{ scoreSets: [{ urn: SCORE_SET }], numScoreSets: 21 }, 20, 21]
  ])('handles empty, past-end and final search pages', async (body, offset, total) => {
    const fetchImpl = vi.fn().mockResolvedValue(json(body))
    const result = await new ParserEngine({ fetchImpl }).call(
      tool('search_score_sets'),
      { text: 'BRCA1', offset },
      {}
    )
    expect(result).toMatchObject({ total, next_offset: null, score_sets: body.scoreSets })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    [],
    {},
    { scoreSets: [], numScoreSets: '0' },
    { scoreSets: [], numScoreSets: -1 },
    { scoreSets: [], numScoreSets: 2 },
    { scoreSets: [null], numScoreSets: 1 },
    { scoreSets: [{ title: 'missing urn' }], numScoreSets: 1 },
    { scoreSets: [{ urn: SCORE_SET }], numScoreSets: 0 }
  ])('does not mistake malformed search responses for no matches', async (body) => {
    const fetchImpl = vi.fn().mockResolvedValue(json(body))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('search_score_sets'), { text: 'BRCA1' }, {})
    ).rejects.toThrow(/MaveDB/)
  })

  it('preserves metadata, license and complete download links', async () => {
    const scoreSet = {
      urn: SCORE_SET,
      license: { shortName: 'CC BY 4.0' },
      numVariants: 123,
      experiment: { urn: EXPERIMENT },
      targetGenes: [{ name: 'BRCA1' }]
    }
    const fetchImpl = vi.fn().mockResolvedValue(json(scoreSet))
    expect(
      await new ParserEngine({ fetchImpl }).call(tool('get_score_set'), { urn: SCORE_SET }, {})
    ).toEqual({
      urn: SCORE_SET,
      score_set: scoreSet,
      scores_download_url: `${path}/scores`,
      mapped_variants_download_url: `${path}/mapped-variants`
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(path)
  })

  it('keeps CSV precision, NA, extra columns, quoting and line endings unchanged', async () => {
    const content =
      'accession,hgvs_nt,hgvs_pro,score,SE,note\r\nurn:mavedb:00000003-a-1#1,c.1A>G,p.Met1Val,-0.123456789012345,NA,"one,\r\ntwo"\r\n'
    const fetchImpl = vi.fn().mockResolvedValue(new Response(content))
    const result = await new ParserEngine({ fetchImpl }).call(
      tool('download_scores'),
      { urn: SCORE_SET, start: 100, limit: 2 },
      {}
    )
    expect(result).toEqual({
      urn: SCORE_SET,
      start: 100,
      limit: 2,
      format: 'csv',
      content,
      url: `${path}/scores?start=100&limit=2`,
      download_url: `${path}/scores`
    })
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get('accept')).toBe('text/csv')
  })

  it('bounds score downloads by default and accepts an empty CSV page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('accession,hgvs_nt,score\r\n'))
    await new ParserEngine({ fetchImpl }).call(tool('download_scores'), { urn: SCORE_SET }, {})
    expect(fetchImpl.mock.calls[0][0]).toBe(`${path}/scores?start=0&limit=1000`)
  })

  it.each(['', '<html>unavailable</html>', '{"detail":"unavailable"}'])(
    'rejects non-CSV score bodies',
    async (body) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(body))
      await expect(
        new ParserEngine({ fetchImpl }).call(tool('download_scores'), { urn: SCORE_SET }, {})
      ).rejects.toThrow('invalid scores CSV')
    }
  )

  it('preserves VRS versions, reference sequences, null mappings and mapping errors', async () => {
    const mappings = [
      {
        variantUrn: `${SCORE_SET}#1`,
        vrsVersion: '2.0',
        preMapped: { type: 'Allele' },
        postMapped: {
          location: { sequenceReference: { refgetAccession: 'SQ.test' }, start: 1, end: 2 }
        },
        current: true
      },
      {
        variantUrn: `${SCORE_SET}#2`,
        postMapped: null,
        errorMessage: 'No alignment',
        current: false
      }
    ]
    const fetchImpl = vi.fn().mockResolvedValue(json(mappings))
    expect(
      await new ParserEngine({ fetchImpl }).call(
        tool('get_mapped_variants'),
        { urn: SCORE_SET },
        {}
      )
    ).toEqual({
      urn: SCORE_SET,
      download_url: `${path}/mapped-variants`,
      mapped_variants: mappings
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(`${path}/mapped-variants`)
  })

  it('keeps an empty mapping list distinct from HTTP failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json([]))
    expect(
      await new ParserEngine({ fetchImpl }).call(
        tool('get_mapped_variants'),
        { urn: SCORE_SET },
        {}
      )
    ).toMatchObject({ mapped_variants: [] })
  })

  it('retrieves experiments and their score sets through distinct routes', async () => {
    const experiment = { urn: EXPERIMENT, scoreSetUrns: [SCORE_SET], methodText: 'Assay protocol' }
    const scoreSets = [{ urn: SCORE_SET, numVariants: 123 }]
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(experiment))
      .mockResolvedValueOnce(json(scoreSets))
    const engine = new ParserEngine({ fetchImpl })
    expect(await engine.call(tool('get_experiment'), { urn: EXPERIMENT }, {})).toEqual({
      urn: EXPERIMENT,
      experiment
    })
    expect(await engine.call(tool('get_experiment_score_sets'), { urn: EXPERIMENT }, {})).toEqual({
      urn: EXPERIMENT,
      score_sets: scoreSets
    })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/experiments/${encodeURIComponent(EXPERIMENT)}`,
      `${BASE}/experiments/${encodeURIComponent(EXPERIMENT)}/score-sets`
    ])
  })

  it.each(['urn:mavedb:00000662-0-1', 'urn:mavedb:00000003-aa-12'])(
    'accepts published meta-analysis and multi-letter URNs',
    async (id) => {
      const fetchImpl = vi.fn().mockResolvedValue(json({ urn: id }))
      await new ParserEngine({ fetchImpl }).call(tool('get_score_set'), { urn: id }, {})
      expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/score-sets/${encodeURIComponent(id)}`)
    }
  )

  it.each([
    ['get_score_set', { urn: EXPERIMENT }],
    ['get_experiment', { urn: SCORE_SET }],
    ['get_score_set', { urn: `${SCORE_SET}/../../users/me` }],
    ['get_score_set', { urn: `${SCORE_SET}?secret=1` }],
    ['get_score_set', { urn: `tmp:446191af-c1f8-4891-9f67-de152e9d328b` }],
    ['search_score_sets', { text: ' ' }],
    ['search_score_sets', { text: 'x'.repeat(1001) }],
    ['search_score_sets', { text: 'BRCA1', limit: 101 }],
    ['search_score_sets', { text: 'BRCA1', offset: -1 }],
    ['search_score_sets', { text: 'BRCA1', offset: 0.5 }],
    ['download_scores', { urn: SCORE_SET, limit: '2' }],
    ['download_scores', { urn: SCORE_SET, limit: 10001 }],
    ['download_scores', { urn: SCORE_SET, start: -1 }]
  ])('rejects invalid %s arguments before fetching', async (id, args) => {
    const fetchImpl = vi.fn()
    await expect(new ParserEngine({ fetchImpl }).call(tool(id), args, {})).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([403, 404, 422, 429, 500])(
    'propagates HTTP %s rather than empty data',
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockImplementation(() => Promise.resolve(json({ detail: 'upstream error' }, status)))
      await expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(
          tool('get_mapped_variants'),
          { urn: SCORE_SET },
          {}
        )
      ).rejects.toThrow(String(status))
    }
  )

  it.each([
    [
      'get_mapped_variants',
      SCORE_SET,
      `No mapped variant associated with score set URN ${SCORE_SET} was found`
    ],
    ['get_experiment_score_sets', EXPERIMENT, 'no associated score sets'],
    ['get_experiment_score_sets', EXPERIMENT, `experiment with URN '${EXPERIMENT}' not found`]
  ])('preserves %s upstream absence as an HTTP error', async (id, urn, detail) => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(json({ detail }, 404)))
    await expect(new ParserEngine({ fetchImpl }).call(tool(id), { urn }, {})).rejects.toMatchObject(
      { name: 'ConnectorHttpError', status: 404 }
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['get_score_set', { urn: 'unexpected' }, SCORE_SET],
    ['get_experiment', {}, EXPERIMENT],
    ['get_experiment_score_sets', { detail: 'not a list' }, EXPERIMENT],
    ['get_mapped_variants', [{ postMapped: null }], SCORE_SET]
  ])('rejects malformed %s payloads', async (id, body, urn) => {
    const fetchImpl = vi.fn().mockResolvedValue(json(body))
    await expect(new ParserEngine({ fetchImpl }).call(tool(id), { urn }, {})).rejects.toThrow(
      /MaveDB/
    )
  })

  it('honors cancellation without issuing a request', async () => {
    const fetchImpl = vi.fn()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      new ParserEngine({ fetchImpl }).call(
        tool('download_scores'),
        { urn: SCORE_SET },
        {},
        controller.signal
      )
    ).rejects.toThrow('cancelled')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
