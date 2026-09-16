import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENES_REACTOME_TOOLS } from './genes-reactome'
import type { ToolContext } from '../types'

const tool = GENES_REACTOME_TOOLS.find((t) => t.id === 'map_reactome_pathways')!

// map_reactome_pathways talks to the API via the global fetch (text/plain body ctx can't express),
// so ctx must never be touched — any use is a bug.
const ctx: ToolContext = {
  credentials: {},
  fetchJson: async () => {
    throw new Error('map_reactome_pathways must not use ctx.fetchJson')
  },
  fetchText: async () => {
    throw new Error('map_reactome_pathways must not use ctx.fetchText')
  },
  postForm: async () => {
    throw new Error('unused multipart transport')
  },
  postJson: async () => {
    throw new Error('map_reactome_pathways must not use ctx.postJson (text/plain body, not JSON)')
  },
  fetchJsonWithHeaders: async () => {
    throw new Error('map_reactome_pathways must not use ctx.fetchJsonWithHeaders')
  }
}

// A fake Response usable for both res.json() (analysis/notFound) and res.text() (version).
const res = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  }) as Response

// Per-identifier analysis responses (a mix of low-level and non-low-level pathways).
const tp53Resp = {
  identifiersNotFound: 0,
  pathwaysFound: 2,
  summary: { token: 'TP53TOKEN' },
  pathways: [
    {
      stId: 'R-HSA-2',
      name: 'Generic Transcription Pathway',
      species: { name: 'Homo sapiens' },
      llp: false,
      inDisease: false,
      entities: { total: 100, found: 1, ratio: 0.5, pValue: 0.05, fdr: 0.1 },
      reactions: { total: 50, found: 2, ratio: 0.2 }
    },
    {
      stId: 'R-HSA-1',
      name: 'Regulation of TP53 Expression',
      species: { name: 'Homo sapiens' },
      llp: true,
      inDisease: false,
      entities: { total: 4, found: 2, ratio: 0.001, pValue: 0.0001, fdr: 0.01 },
      reactions: { total: 5, found: 5, ratio: 0.02 }
    }
  ]
}
const egfrResp = {
  identifiersNotFound: 0,
  pathwaysFound: 1,
  summary: { token: 'EGFRTOKEN' },
  pathways: [
    {
      stId: 'R-HSA-3',
      name: 'EGFR signaling',
      species: { name: 'Homo sapiens' },
      llp: true,
      inDisease: false,
      entities: { total: 20, found: 1, ratio: 0.1, pValue: 0.01, fdr: 0.02 },
      reactions: { total: 10, found: 3, ratio: 0.05 }
    }
  ]
}
const batchResp = {
  identifiersNotFound: 1,
  pathwaysFound: 3,
  summary: { token: 'BATCHTOKEN%3D' },
  pathways: []
}

// URL/method/body-dispatching fetch mock covering version, the batch POST, notFound and the
// per-identifier POSTs (keyed by the text/plain body).
const makeFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('/database/version')) return res('97')
    if (u.includes('/token/') && u.includes('/notFound')) return res([{ id: 'NOSUCH', exp: [] }])
    if (new URL(u).pathname === '/AnalysisService/identifiers/' && method === 'POST') {
      const body = String(init?.body ?? '')
      if (body.includes('\n')) return res(batchResp)
      if (body === 'TP53') return res(tp53Resp)
      if (body === 'EGFR') return res(egfrResp)
      return res({
        identifiersNotFound: 1,
        pathwaysFound: 0,
        summary: { token: 'X' },
        pathways: []
      })
    }
    throw new Error(`unexpected fetch: ${method} ${u}`)
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('genes / map_reactome_pathways', () => {
  it('aborts its direct Reactome request when the tool context is cancelled', async () => {
    let observedSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_, reject) => {
          observedSignal = init?.signal ?? undefined
          observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), {
            once: true
          })
        })
    )
    vi.stubGlobal('fetch', fetchImpl)
    const cancellation = new AbortController()

    const pending = tool.run!(
      { ...ctx, signal: cancellation.signal },
      {
        identifiers: ['TP53'],
        id_type: 'symbol'
      }
    )
    await vi.waitFor(() => expect(observedSignal).toBeInstanceOf(AbortSignal))
    cancellation.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('POSTs a newline-joined text/plain body with species/resource/includeDisease params', async () => {
    const fetchImpl = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)

    await tool.run!(ctx, { identifiers: ['TP53', 'EGFR', 'NOSUCH'], id_type: 'symbol' })

    const batchCall = fetchImpl.mock.calls.find(
      (c) =>
        (c[1] as RequestInit)?.method === 'POST' &&
        String((c[1] as RequestInit).body).includes('\n')
    )!
    const [batchUrl, batchInit] = batchCall as [string, RequestInit]
    expect(batchInit.body).toBe('TP53\nEGFR\nNOSUCH')
    expect((batchInit.headers as Record<string, string>)['content-type']).toBe('text/plain')
    expect(new URL(batchUrl).pathname).toBe('/AnalysisService/identifiers/')
    expect(batchUrl).toContain('species=Homo%20sapiens')
    expect(batchUrl).toContain('resource=TOTAL')
    expect(batchUrl).toContain('includeDisease=true')

    // notFound is resolved via the batch token (percent-encoded, used verbatim in the path).
    const notFoundCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/notFound'))!
    expect(String(notFoundCall[0])).toContain('/token/BATCHTOKEN%3D/notFound')
  })

  it('groups per identifier, filters to low-level pathways, and reports reactome_version (compact)', async () => {
    const fetchImpl = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)

    const out = (await tool.run!(ctx, {
      identifiers: ['TP53', 'EGFR', 'NOSUCH'],
      id_type: 'symbol'
    })) as {
      tool: string
      reactome_version: string
      id_type: string
      species: string
      n_input: number
      genes: Record<string, { found: boolean; n_lowlevel_pathways: number; pathways: unknown[] }>
    }

    expect(out.tool).toBe('map_reactome_pathways')
    expect(out.reactome_version).toBe('97')
    expect(out.id_type).toBe('symbol')
    expect(out.species).toBe('Homo sapiens')
    expect(out.n_input).toBe(3)

    // TP53: only the low-level pathway kept, compact {stId,name,species}.
    expect(out.genes.TP53.found).toBe(true)
    expect(out.genes.TP53.n_lowlevel_pathways).toBe(1)
    expect(out.genes.TP53.pathways).toEqual([
      { stId: 'R-HSA-1', name: 'Regulation of TP53 Expression', species: 'Homo sapiens' }
    ])
    expect(out.genes.EGFR.found).toBe(true)
    expect(out.genes.EGFR.n_lowlevel_pathways).toBe(1)

    // NOSUCH is in the batch notFound set: marked not-found, never submitted individually.
    expect(out.genes.NOSUCH).toEqual({ found: false, n_lowlevel_pathways: 0, pathways: [] })
    const submittedNoSuch = fetchImpl.mock.calls.some(
      (c) => (c[1] as RequestInit)?.method === 'POST' && (c[1] as RequestInit).body === 'NOSUCH'
    )
    expect(submittedNoSuch).toBe(false)

    // Compact result carries no batch_summary.
    expect((out as Record<string, unknown>).batch_summary).toBeUndefined()
  })

  it('full mode returns per-pathway statistics and a batch_summary with identifiers_not_found', async () => {
    const fetchImpl = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)

    const out = (await tool.run!(ctx, {
      identifiers: ['TP53', 'EGFR', 'NOSUCH'],
      id_type: 'symbol',
      compact: false
    })) as {
      genes: Record<string, { n_pathways?: number; pathways: Array<Record<string, unknown>> }>
      batch_summary: {
        n_input: number
        n_found: number
        n_not_found: number
        identifiers_not_found: string[]
        distinct_lowlevel_pathways: number
        batch_pathways_found: number
      }
    }

    // TP53 full pathways: both pathways, most-significant-first, with entity/reaction stats.
    expect(out.genes.TP53.n_pathways).toBe(2)
    expect(out.genes.TP53.pathways.map((p) => p.stId)).toEqual(['R-HSA-1', 'R-HSA-2'])
    expect(out.genes.TP53.pathways[0]).toEqual({
      stId: 'R-HSA-1',
      name: 'Regulation of TP53 Expression',
      species: 'Homo sapiens',
      low_level: true,
      in_disease: false,
      entities: { total: 4, found: 2, ratio: 0.001, p_value: 0.0001, fdr: 0.01 },
      reactions: { total: 5, found: 5, ratio: 0.02 }
    })

    expect(out.batch_summary.n_input).toBe(3)
    expect(out.batch_summary.n_found).toBe(2)
    expect(out.batch_summary.n_not_found).toBe(1)
    expect(out.batch_summary.identifiers_not_found).toEqual(['NOSUCH'])
    expect(out.batch_summary.distinct_lowlevel_pathways).toBe(2)
    expect(out.batch_summary.batch_pathways_found).toBe(3)
  })

  it('passes resource=UNIPROT and includeDisease=false through to every analysis request', async () => {
    const fetchImpl = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)

    await tool.run!(ctx, {
      identifiers: ['P04637'],
      id_type: 'uniprot',
      resource: 'UNIPROT',
      include_disease: false
    })

    const postUrls = fetchImpl.mock.calls
      .filter((c) => (c[1] as RequestInit)?.method === 'POST')
      .map((c) => String(c[0]))
    expect(postUrls.length).toBeGreaterThan(0)
    for (const u of postUrls) {
      expect(u).toContain('resource=UNIPROT')
      expect(u).toContain('includeDisease=false')
    }
  })

  it.each([true, false])(
    'keeps mouse pathways in compact=%s without human projection',
    async (compact) => {
      const mousePathway = {
        ...tp53Resp.pathways[1],
        stId: 'R-MMU-6804754',
        species: { name: 'Mus musculus' }
      }
      const postBodies: string[] = []
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(String(url))
        if (u.pathname.endsWith('/database/version')) return res('97')
        if (u.pathname.endsWith('/notFound')) return res([])
        expect(init?.method).toBe('POST')
        expect(u.pathname).toBe('/AnalysisService/identifiers/')
        expect(u.searchParams.get('species')).toBe('Mus musculus')
        expect(u.searchParams.get('resource')).toBe('UNIPROT')
        expect(u.searchParams.get('includeDisease')).toBe('false')
        postBodies.push(String(init?.body))
        return res({
          summary: { token: 'MOUSETOKEN', projection: false },
          identifiersNotFound: 0,
          pathwaysFound: 1,
          pathways: [mousePathway]
        })
      })
      vi.stubGlobal('fetch', fetchImpl)

      const out = (await tool.run!(ctx, {
        identifiers: ['P02340', 'Q01279'],
        id_type: 'uniprot',
        species: 'Mus musculus',
        resource: 'UNIPROT',
        include_disease: false,
        compact
      })) as {
        species: string
        genes: Record<string, { found: boolean; pathways: Array<Record<string, unknown>> }>
        batch_summary?: { n_found: number; batch_pathways_found: number }
      }

      // Both the batch and each identifier must use the requested-species analysis.
      expect(postBodies).toEqual(['P02340\nQ01279', 'P02340', 'Q01279'])
      expect(out.species).toBe('Mus musculus')
      for (const gene of Object.values(out.genes)) {
        expect(gene.found).toBe(true)
        expect(gene.pathways).toHaveLength(1)
        expect(gene.pathways[0]).toMatchObject({
          stId: 'R-MMU-6804754',
          species: 'Mus musculus'
        })
      }
      if (!compact) {
        expect(out.batch_summary).toMatchObject({ n_found: 2, batch_pathways_found: 1 })
      }
    }
  )

  it.each(['NotASpecies', '', '   ', 'mouse', 'Mus musclus'])(
    'rejects unsupported species %j before networking',
    async (species) => {
      const fetchImpl = makeFetch()
      vi.stubGlobal('fetch', fetchImpl)
      await expect(
        tool.run!(ctx, { identifiers: ['P02340'], id_type: 'uniprot', species })
      ).rejects.toThrow(/Unsupported Reactome species/)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('trims species before querying and reporting it', async () => {
    const fetchImpl = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)
    const out = await tool.run!(ctx, {
      identifiers: ['TP53'],
      id_type: 'symbol',
      species: '  Homo sapiens  '
    })
    expect(out).toMatchObject({ species: 'Homo sapiens' })
    for (const [url, init] of fetchImpl.mock.calls) {
      if (init?.method === 'POST')
        expect(new URL(String(url)).searchParams.get('species')).toBe('Homo sapiens')
    }
  })

  it.each([
    ['batch', 'Homo sapiens'],
    ['single', 'Homo sapiens'],
    ['batch', undefined],
    ['single', undefined]
  ])(
    'rejects wrong or missing species in %s responses (%s), even outside low-level pathways',
    async (stage, name) => {
      let posts = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).endsWith('/database/version')) return res('97')
          if (String(url).endsWith('/notFound')) return res([])
          expect(init?.method).toBe('POST')
          posts++
          const bad = stage === 'batch' || posts === 2
          return res({
            summary: { token: 'TEST' },
            identifiersNotFound: 0,
            pathways: [
              {
                ...tp53Resp.pathways[0],
                species:
                  name === undefined && bad ? undefined : { name: bad ? name : 'Mus musculus' }
              }
            ]
          })
        })
      )
      await expect(
        tool.run!(ctx, {
          identifiers: ['P02340'],
          id_type: 'uniprot',
          species: 'Mus musculus',
          compact: true
        })
      ).rejects.toThrow(/Reactome species mismatch/)
      expect(posts).toBe(stage === 'batch' ? 1 : 2)
    }
  )

  it.each([true, false])(
    'preserves identifier recognition when the requested species has no pathways (compact=%s)',
    async (compact) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).endsWith('/database/version')) return res('97')
          if (String(url).endsWith('/notFound')) return res([])
          return res({
            summary: { token: 'TEST' },
            identifiersNotFound: 0,
            pathwaysFound: 0,
            pathways: []
          })
        })
      )
      const out = await tool.run!(ctx, {
        identifiers: ['P02340'],
        id_type: 'uniprot',
        species: 'Homo sapiens',
        compact
      })
      expect(out).toMatchObject({
        genes: { P02340: { found: true, n_lowlevel_pathways: 0, pathways: [] } }
      })
      if (!compact)
        expect(out).toMatchObject({
          genes: { P02340: { n_pathways: 0 } },
          batch_summary: { n_found: 1, n_not_found: 0 }
        })
    }
  )

  it('rejects duplicate identifiers without any network call', async () => {
    const fetchImpl = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(
      tool.run!(ctx, { identifiers: ['TP53', 'TP53'], id_type: 'symbol' })
    ).rejects.toThrow(/duplicate/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an invalid id_type', async () => {
    const fetchImpl = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(tool.run!(ctx, { identifiers: ['TP53'], id_type: 'ensembl' })).rejects.toThrow(
      /id_type must be/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
