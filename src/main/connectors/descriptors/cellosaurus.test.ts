import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { ParserEngine } from '../engine'
import { CELLOSAURUS_TOOLS } from './cellosaurus'

const validators = new Map(
  CELLOSAURUS_TOOLS.map((tool) => [tool.id, new Ajv2020({ strict: true }).compile(tool.input)])
)
function setup(
  payload: unknown,
  status = 200
): {
  fetchImpl: Mock<typeof fetch>
  call: (method: string, args: Record<string, unknown>) => Promise<unknown>
} {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(payload), { status })
  )
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  return {
    fetchImpl,
    call: async (method: string, args: Record<string, unknown>) => {
      if (!validators.get(method)!(args)) throw new Error('invalid_arguments')
      return engine.call(
        CELLOSAURUS_TOOLS.find((tool) => tool.id === method)!,
        args,
        {}
      )
    }
  }
}
const envelope = (rows: unknown[]): { Cellosaurus: { 'cell-line-list': unknown[] } } => ({
  Cellosaurus: { 'cell-line-list': rows }
})
const minimal = {
  'accession-list': [{ type: 'primary', value: 'CVCL_1906' }],
  'name-list': [{ type: 'identifier', value: 'HEp-2' }]
}
// Selected fields match the official CVCL_1906 JSON envelope (release 56).
const problem = {
  ...minimal,
  'name-list': [...minimal['name-list'], { type: 'synonym', value: 'Hep2' }],
  'comment-list': [
    {
      category: 'Problematic cell line',
      value:
        'Contaminated. Shown to be a HeLa derivative (PubMed=4864103). Originally thought to originate from a laryngeal carcinoma.'
    },
    { category: 'Caution', value: 'Review the original characterization.' }
  ],
  'registration-list': [
    {
      registry:
        'International Cell Line Authentication Committee, Register of Misidentified Cell Lines',
      'registration-number': 'ICLAC-00007'
    }
  ],
  'derived-from': [{ database: 'Cellosaurus', accession: 'CVCL_0030', label: 'HeLa' }],
  'derived-from-site-list': [{ site: { 'site-type': 'In situ', value: 'Uterus, cervix' } }],
  'species-list': [{ database: 'NCBI_TaxID', accession: '9606', label: 'Homo sapiens (Human)' }],
  'disease-list': [
    {
      database: 'NCIt',
      accession: 'C27677',
      label: 'Human papillomavirus-related endocervical adenocarcinoma'
    }
  ],
  'xref-list': [
    { database: 'ATCC', accession: 'CCL-23', url: 'https://www.atcc.org/products/CCL-23' }
  ],
  'last-updated': '2025-04-10',
  'entry-version': '43'
}

describe('Cellosaurus search', () => {
  it('quotes names as literal phrases and uses bounded lookahead with stable ordering', async () => {
    const { call, fetchImpl } = setup(envelope([problem, minimal]))
    const result = await call('search_cell_lines', { query: ' HEp-2 ', offset: 10, limit: 1 })
    const url = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(url.origin + url.pathname).toBe('https://api.cellosaurus.org/search/cell-line')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: 'idsy:"HEp-2"',
      start: '10',
      rows: '2',
      sort: 'ac asc',
      format: 'json'
    })
    expect(result).toMatchObject({
      query: 'HEp-2',
      offset: 10,
      limit: 1,
      returned: 1,
      next_offset: 11,
      pagination_limited: false,
      cell_lines: [
        {
          accession: 'CVCL_1906',
          synonyms: ['Hep2'],
          quality: { status: 'problematic_recorded', problems: problem['comment-list'].slice(0, 1) }
        }
      ]
    })
    expect(result).not.toHaveProperty('total')
  })

  it('escapes quotes and backslashes instead of accepting field/operator injection', async () => {
    const { call, fetchImpl } = setup(envelope([]))
    await call('search_cell_lines', { query: 'A" OR *:* \\ B' })
    const q = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('q')
    expect(q).toBe('idsy:"A\\" OR *:* \\\\ B"')
  })

  it.each([
    { rows: [], offset: 0 },
    { rows: [], offset: 1_000_000 },
    { rows: [minimal], offset: 0 }
  ])('stops at empty or final pages at offset $offset', async ({ rows, offset }) => {
    const { call, fetchImpl } = setup(envelope(rows))
    expect(await call('search_cell_lines', { query: 'HEp-2', limit: 1, offset })).toMatchObject({
      offset,
      returned: rows.length,
      next_offset: null,
      pagination_limited: false,
      cell_lines: rows.length ? [expect.objectContaining({ accession: 'CVCL_1906' })] : []
    })
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('start')).toBe(
      String(offset)
    )
  })

  it('reports the offset boundary without generating an invalid continuation', async () => {
    const { call } = setup(envelope([minimal, minimal]))
    expect(
      await call('search_cell_lines', { query: 'HEp-2', offset: 1_000_000, limit: 1 })
    ).toMatchObject({
      next_offset: null,
      pagination_limited: true
    })
  })
})

describe('Cellosaurus identity and annotations', () => {
  it.each(['CVCL_1906', 'rrid:cvcl_1906', ' RRID:CVCL_1906 '])(
    'resolves %s and preserves quality evidence and mappings',
    async (accession) => {
      const { call, fetchImpl } = setup(envelope([problem]))
      expect(await call('get_cell_line', { accession })).toMatchObject({
        accession: 'CVCL_1906',
        rrid: 'RRID:CVCL_1906',
        name: 'HEp-2',
        parent_cell_lines: problem['derived-from'],
        diseases: problem['disease-list'],
        species: problem['species-list'],
        derived_from_sites: problem['derived-from-site-list'],
        cross_references: problem['xref-list'],
        quality: {
          status: 'problematic_recorded',
          cautions: problem['comment-list'].slice(1),
          registrations: problem['registration-list']
        },
        source_url: 'https://www.cellosaurus.org/CVCL_1906',
        last_updated: '2025-04-10',
        entry_version: '43'
      })
      const url = new URL(String(fetchImpl.mock.calls[0][0]))
      expect(url.pathname).toBe('/cell-line/CVCL_1906')
      expect(url.searchParams.get('fields')).toContain('problematic,caution,registration')
      expect(url.searchParams.get('fields')).toContain('cell-type,from,hi,dr')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves the singular cell-type object and establishing laboratory comments', async () => {
    const cellType = {
      value: 'Fibroblast of skin',
      xref: { database: 'CL', accession: 'CL_0002620' }
    }
    const from = { category: 'From', value: 'Royan Institute; Theran; Iran' }
    const { call } = setup(
      envelope([{ ...minimal, 'cell-type': cellType, 'comment-list': [from] }])
    )
    expect(await call('get_cell_line', { accession: 'CVCL_1906' })).toMatchObject({
      cell_type: cellType,
      established_by: [from]
    })
  })

  it('does not interpret absent annotations as proof of sample quality', async () => {
    const { call } = setup(envelope([minimal]))
    expect(await call('get_cell_line', { accession: 'CVCL_1906' })).toMatchObject({
      diseases: [],
      cross_references: [],
      cell_type: null,
      age: null,
      sex: null,
      quality: {
        status: 'no_problem_recorded',
        problems: [],
        cautions: [],
        note: expect.stringContaining('does not establish authentication')
      }
    })
  })

  it.each([
    { rows: [] },
    { rows: [minimal, minimal] },
    { rows: [{ ...minimal, 'accession-list': [{ type: 'primary', value: 'CVCL_0030' }] }] }
  ])('rejects missing, multiple or mismatched identity records', async ({ rows }) => {
    const { call } = setup(envelope(rows))
    await expect(call('get_cell_line', { accession: 'CVCL_1906' })).rejects.toThrow(
      /Invalid Cellosaurus response/
    )
  })
})

describe('Cellosaurus secondary accession resolution', () => {
  // The accession pair is real; optional annotations below are synthetic preservation fixtures.
  const merged = {
    ...minimal,
    'accession-list': [
      { type: 'primary', value: 'CVCL_0014' },
      { type: 'secondary', value: 'CVCL_7353' }
    ],
    'name-list': [{ type: 'identifier', value: 'RPMI-8226' }],
    'comment-list': [{ category: 'Caution', value: 'Synthetic lookup annotation.' }],
    'disease-list': [{ database: 'ExampleDB', accession: 'disease-fixture' }],
    'xref-list': [{ database: 'ExampleDB', accession: 'line-fixture' }]
  }

  it.each(['CVCL_7353', ' rrid:cvcl_7353 '])(
    'resolves the old identifier %s only after a detail 404',
    async (accession) => {
      const { call, fetchImpl } = setup(envelope([merged]))
      fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 404 }))
      expect(await call('get_cell_line', { accession })).toMatchObject({
        accession: 'CVCL_0014',
        rrid: 'RRID:CVCL_0014',
        name: 'RPMI-8226',
        secondary_accessions: ['CVCL_7353'],
        source_url: 'https://www.cellosaurus.org/CVCL_0014',
        diseases: merged['disease-list'],
        cross_references: merged['xref-list'],
        quality: { cautions: merged['comment-list'] }
      })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      const detailUrl = new URL(String(fetchImpl.mock.calls[0][0]))
      const lookupUrl = new URL(String(fetchImpl.mock.calls[1][0]))
      expect(detailUrl.pathname).toBe('/cell-line/CVCL_7353')
      expect(lookupUrl.origin + lookupUrl.pathname).toBe(
        'https://api.cellosaurus.org/search/cell-line'
      )
      expect(Object.fromEntries(lookupUrl.searchParams)).toMatchObject({
        q: 'acas:"CVCL_7353"',
        rows: '2',
        start: '0',
        format: 'json'
      })
      expect(lookupUrl.searchParams.get('fields')).toBe(detailUrl.searchParams.get('fields'))
    }
  )

  it('preserves the original HTTP 404 when no primary or secondary accession matches', async () => {
    const { call, fetchImpl } = setup(envelope([]))
    fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    await expect(call('get_cell_line', { accession: 'CVCL_7353' })).rejects.toMatchObject({
      name: 'ConnectorHttpError',
      status: 404,
      message: expect.stringContaining('/cell-line/CVCL_7353?')
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    { rows: [merged, merged] },
    { rows: [minimal] },
    { rows: [{ ...merged, 'accession-list': [{ type: 'secondary', value: 'CVCL_7353' }] }] }
  ])('rejects ambiguous, mismatched or malformed resolved identities', async ({ rows }) => {
    const { call, fetchImpl } = setup(envelope(rows))
    fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    await expect(call('get_cell_line', { accession: 'CVCL_7353' })).rejects.toThrow(
      /Invalid Cellosaurus response/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([404, 429, 500])(
    'propagates lookup HTTP %i without another identity fallback',
    async (status) => {
      const { call, fetchImpl } = setup({}, status)
      fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 404 }))
      await expect(call('get_cell_line', { accession: 'CVCL_7353' })).rejects.toMatchObject({
        name: 'ConnectorHttpError',
        status,
        message: expect.stringContaining('/search/cell-line?')
      })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
  )

  it('propagates lookup network failures', async () => {
    const { call, fetchImpl } = setup(envelope([]))
    fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    fetchImpl.mockRejectedValueOnce(new Error('lookup network unavailable'))
    await expect(call('get_cell_line', { accession: 'CVCL_7353' })).rejects.toThrow(
      'lookup network unavailable'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('propagates malformed lookup responses', async () => {
    const { call, fetchImpl } = setup({})
    fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    await expect(call('get_cell_line', { accession: 'CVCL_7353' })).rejects.toThrow(
      /Invalid Cellosaurus response/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not fall back after a detail network failure', async () => {
    const { call, fetchImpl } = setup(envelope([merged]))
    fetchImpl.mockRejectedValueOnce(new Error('detail network unavailable'))
    await expect(call('get_cell_line', { accession: 'CVCL_7353' })).rejects.toThrow(
      'detail network unavailable'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not fall back after a malformed successful detail response', async () => {
    const { call, fetchImpl } = setup({})
    await expect(call('get_cell_line', { accession: 'CVCL_7353' })).rejects.toThrow(
      /Invalid Cellosaurus response/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a transient lookup failure without restarting accession resolution', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope([merged]))))
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    const tool = CELLOSAURUS_TOOLS.find((item) => item.id === 'get_cell_line')!

    await expect(engine.call(tool, { accession: 'CVCL_7353' }, {})).resolves.toMatchObject({
      accession: 'CVCL_0014',
      rrid: 'RRID:CVCL_0014'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const urls = fetchImpl.mock.calls.map(([url]) => new URL(String(url)))
    expect(urls.map((url) => url.pathname)).toEqual([
      '/cell-line/CVCL_7353',
      '/search/cell-line',
      '/search/cell-line'
    ])
    expect(urls[1].searchParams.get('q')).toBe('acas:"CVCL_7353"')
    expect(urls[2].href).toBe(urls[1].href)
  })

  it('does not start the lookup when the detail request is cancelled', async () => {
    const cancellation = new AbortController()
    const reason = new Error('Cellosaurus lookup cancelled')
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      cancellation.abort(reason)
      return new Response('{}', { status: 404 })
    })
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    const tool = CELLOSAURUS_TOOLS.find((item) => item.id === 'get_cell_line')!

    await expect(
      engine.call(tool, { accession: 'CVCL_7353' }, {}, cancellation.signal)
    ).rejects.toBe(reason)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new URL(String(fetchImpl.mock.calls[0][0])).pathname).toBe('/cell-line/CVCL_7353')
  })

  it('shares the whole-call deadline between the detail and lookup requests', async () => {
    vi.useFakeTimers()
    try {
      let lookupSignal: AbortSignal | undefined
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(
          async () =>
            new Promise<Response>((resolve) => {
              setTimeout(() => resolve(new Response('{}', { status: 404 })), 40)
            })
        )
        .mockImplementationOnce(
          async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              lookupSignal = init?.signal ?? undefined
              lookupSignal?.addEventListener('abort', () => reject(lookupSignal?.reason), {
                once: true
              })
            })
        )
      const engine = new ParserEngine({ fetchImpl, totalTimeoutMs: 100, timeoutMs: 1_000 })
      const tool = CELLOSAURUS_TOOLS.find((item) => item.id === 'get_cell_line')!
      // Observe rejection immediately so advancing fake timers cannot produce an unhandled error.
      const result = engine
        .call(tool, { accession: 'CVCL_7353' }, {})
        .catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(40)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(lookupSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(59)
      expect(lookupSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(lookupSignal?.aborted).toBe(true)
      await expect(result).resolves.toMatchObject({
        name: 'ConnectorRequestTimeoutError',
        message: expect.stringContaining(
          'exceeded the 100ms total deadline for cellosaurus/get_cell_line'
        )
      })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Cellosaurus input and upstream failures', () => {
  it.each([
    ['search_cell_lines', { query: '' }],
    ['search_cell_lines', { query: '   ' }],
    ['search_cell_lines', { query: 'HeLa', limit: 0 }],
    ['search_cell_lines', { query: 'HeLa', limit: 101 }],
    ['search_cell_lines', { query: 'HeLa', offset: -1 }],
    ['search_cell_lines', { query: 'HeLa', offset: 0.5 }],
    ['search_cell_lines', { query: 'HeLa', limit: '10' }],
    ['search_cell_lines', { query: 'HeLa', url: 'https://example.com' }],
    ['get_cell_line', { accession: 'HeLa' }],
    ['get_cell_line', { accession: 'CVCL_0030/../' }],
    ['get_cell_line', { accession: 'RRID:AB_12345' }]
  ])('rejects invalid %s input before HTTP', async (method, args) => {
    const { call, fetchImpl } = setup(envelope([]))
    await expect(call(method as string, args as Record<string, unknown>)).rejects.toThrow(
      /invalid_arguments/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([400, 401, 403, 429, 500, 503])(
    'propagates HTTP %i without an identity fallback',
    async (status) => {
      const { call, fetchImpl } = setup({ detail: 'upstream failure' }, status)
      await expect(call('get_cell_line', { accession: 'CVCL_1906' })).rejects.toThrow(
        `HTTP ${status}`
      )
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it('propagates network failures', async () => {
    const { call, fetchImpl } = setup(envelope([]))
    fetchImpl.mockRejectedValue(new Error('network unavailable'))
    await expect(call('search_cell_lines', { query: 'HeLa' })).rejects.toThrow(
      'network unavailable'
    )
  })

  it.each([
    {},
    { Cellosaurus: {} },
    envelope([{}]),
    envelope([{ ...minimal, 'comment-list': null }]),
    envelope([{ ...minimal, 'comment-list': [{ category: 'Problematic cell line' }] }]),
    envelope([{ ...minimal, 'registration-list': {} }])
  ])('rejects malformed success responses', async (payload) => {
    const { call } = setup(payload)
    await expect(call('search_cell_lines', { query: 'HeLa' })).rejects.toThrow(
      /Invalid Cellosaurus response/
    )
  })

  it('rejects malformed external mappings instead of silently dropping them', async () => {
    const { call } = setup(envelope([{ ...minimal, 'xref-list': {} }]))
    await expect(call('get_cell_line', { accession: 'CVCL_1906' })).rejects.toThrow(
      /Invalid Cellosaurus response/
    )
  })
})
