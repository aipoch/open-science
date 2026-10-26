import { describe, expect, it, vi } from 'vitest'
import { bibliographicRecordSchema } from '@aipoch/literature-citations/contracts'
import { LiteraturePublicationChecker } from '../src/publication-check.js'
import {
  literaturePublicationCheckRequestSchema,
  literaturePublicationCheckSnapshotSchema,
  type LiteraturePublicationCheckSnapshot
} from '../src/publication-check-contracts.js'
import type { DiscoveryReference } from '../src/contracts.js'

const DOI = '10.1021/am300292v'
const request = { mode: 'check' as const, itemId: 'item', expectedMetadataRevision: 1 }
// Field projection of https://api.crossref.org/works/10.1021/am300292v,
// independently observed on 2026-10-26. update-to is absent on the original work.
const retraction = {
  DOI: '10.1021/acsami.9b11759',
  type: 'retraction',
  source: 'retraction-watch',
  updated: { 'date-parts': [[2019, 7, 26]] }
}
const wire = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'ok',
  'message-type': 'work',
  message: { DOI, ...extra }
})
const previous = (): LiteraturePublicationCheckSnapshot => ({
  doi: DOI,
  checkedAt: 100,
  notices: [{ doi: retraction.DOI, type: 'retraction', source: 'retraction-watch' }]
})
function fixture(initial?: LiteraturePublicationCheckSnapshot): {
  checker: LiteraturePublicationChecker
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>
  catalog: {
    get: ReturnType<typeof vi.fn<() => Promise<DiscoveryReference | undefined>>>
    sources: ReturnType<
      typeof vi.fn<
        () => Promise<{ provider: string; rawMetadata: LiteraturePublicationCheckSnapshot }[]>
      >
    >
    savePublicationCheck: ReturnType<
      typeof vi.fn<(input: { snapshot: LiteraturePublicationCheckSnapshot }) => Promise<void>>
    >
  }
  change(next: DiscoveryReference | undefined): void
  item(): DiscoveryReference
  saved(): LiteraturePublicationCheckSnapshot | undefined
} {
  let item: DiscoveryReference | undefined = {
    id: 'item',
    metadataRevision: 1,
    attachments: [],
    item: bibliographicRecordSchema.parse({
      itemType: 'journalArticle',
      title: 'Fixture paper',
      identifiers: [{ scheme: 'doi', isPrimary: false, value: DOI }]
    })
  }
  let saved = initial
  const sources = vi.fn(async () =>
    saved ? [{ provider: 'crossref-publication-check', rawMetadata: saved }] : []
  )
  const savePublicationCheck = vi.fn(
    async (input: { snapshot: LiteraturePublicationCheckSnapshot }) => {
      saved = JSON.parse(JSON.stringify(input.snapshot))
    }
  )
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(wire()))
  const catalog = { get: vi.fn(async () => item), sources, savePublicationCheck }
  const checker = new LiteraturePublicationChecker({ catalog, fetch })
  return {
    checker,
    fetch,
    catalog,
    change: (next: DiscoveryReference | undefined) => {
      item = next
    },
    item: () => item!,
    saved: () => saved
  }
}

describe('publication check', () => {
  it('loads saved results without network requests or writes', async () => {
    const f = fixture(previous())
    expect(await f.checker.run({ ...request, mode: 'get' })).toEqual({
      itemId: 'item',
      metadataRevision: 1,
      snapshot: previous()
    })
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.catalog.savePublicationCheck).not.toHaveBeenCalled()
  })

  it('queries only the exact normalized DOI and reads updated-by on the original paper', async () => {
    const f = fixture()
    f.change({
      ...f.item(),
      item: {
        ...f.item().item,
        identifiers: [
          { scheme: 'doi', isPrimary: false, value: `https://doi.org/${DOI.toUpperCase()}` }
        ]
      }
    })
    f.fetch.mockResolvedValueOnce(Response.json(wire({ 'updated-by': [retraction] })))
    const result = await f.checker.run(request)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.fetch).toHaveBeenCalledWith(
      `https://api.crossref.org/works/${encodeURIComponent(DOI)}`,
      expect.objectContaining({
        redirect: 'error',
        credentials: 'omit',
        signal: expect.any(AbortSignal)
      })
    )
    expect(result.issue).toBeUndefined()
    expect(result.snapshot?.notices).toEqual([
      {
        doi: retraction.DOI,
        type: 'retraction',
        source: 'retraction-watch',
        date: '2019-07-26'
      }
    ])
    expect(result.snapshot?.checkedAt).toBeGreaterThan(100)
    expect(f.catalog.savePublicationCheck).toHaveBeenCalledWith(
      { itemId: 'item', expectedMetadataRevision: 1, snapshot: result.snapshot },
      expect.any(AbortSignal)
    )
  })

  it('does not mistake update-to targets for notices about the current work', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(Response.json(wire({ 'update-to': [retraction], relation: {} })))
    expect((await f.checker.run(request)).snapshot?.notices).toEqual([])
    expect(f.saved()?.notices).toEqual([])
  })

  it('preserves self updates and notices sharing DOI but differing in type, date or source', async () => {
    const f = fixture()
    const concern = {
      DOI,
      type: 'expression_of_concern',
      source: 'publisher',
      updated: { 'date-parts': [[2021, 8, 30]] }
    }
    f.fetch.mockResolvedValueOnce(
      Response.json(
        wire({
          'updated-by': [
            concern,
            { ...concern, updated: { 'date-parts': [[2022, 2, 15]] } },
            retraction,
            { ...retraction, source: 'publisher' },
            { ...retraction, type: 'correction' },
            // Synthetic recovery/unknown cases: do not infer a final integrity verdict.
            { ...retraction, type: 'reinstatement' },
            { ...retraction, type: 'future-update-type' }
          ]
        })
      )
    )
    const result = await f.checker.run(request)
    expect(result.snapshot?.notices).toHaveLength(7)
    expect(result.snapshot?.notices.map((n) => n.type)).toContain('future-update-type')
    expect(result.snapshot?.notices[0].doi).toBe(DOI)
    expect(result.snapshot?.notices[1].date).toBe('2022-02-15')
  })

  it('preserves provider record multiplicity and tolerates absent source and partial dates', async () => {
    const f = fixture()
    const notice = { DOI: retraction.DOI, type: 'correction', updated: { 'date-parts': [[2020]] } }
    f.fetch.mockResolvedValueOnce(Response.json(wire({ 'updated-by': [notice, notice] })))
    expect((await f.checker.run(request)).snapshot?.notices).toEqual([
      { doi: retraction.DOI, type: 'correction', source: 'crossref', date: undefined },
      { doi: retraction.DOI, type: 'correction', source: 'crossref', date: undefined }
    ])
  })

  it('preserves distinct notices when partial dates have the same display projection', async () => {
    const f = fixture()
    const notice = { DOI: retraction.DOI, type: 'correction', source: 'publisher' }
    f.fetch.mockResolvedValueOnce(
      Response.json(
        wire({
          'updated-by': [
            { ...notice, updated: { 'date-parts': [[2020]] } },
            { ...notice, updated: { 'date-parts': [[2021]] } }
          ]
        })
      )
    )
    const result = await f.checker.run(request)
    expect(result.issue).toBeUndefined()
    expect(result.snapshot?.notices).toHaveLength(2)
    expect(f.saved()?.notices).toHaveLength(2)
  })

  it.each([
    { identifiers: undefined },
    { identifiers: [] },
    { identifiers: [{ value: 'not-a-doi' }] },
    { identifiers: [{ value: DOI }, { value: '10.1234/other' }] }
  ])('rejects missing, invalid or ambiguous DOI identities: %j', async ({ identifiers }) => {
    const f = fixture()
    f.change({
      ...f.item(),
      item: {
        ...f.item().item,
        identifiers:
          identifiers?.map(({ value }) => ({ scheme: 'doi' as const, isPrimary: false, value })) ??
          []
      }
    })
    expect((await f.checker.run(request)).issue).toBe('doi-required')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each([404, 429, 503])('preserves the saved result on HTTP %i', async (status) => {
    const f = fixture(previous())
    f.fetch.mockResolvedValueOnce(new Response('', { status }))
    const result = await f.checker.run(request)
    expect(result.snapshot).toEqual(previous())
    expect(result.issue).toBe(
      status === 404 ? 'not-found' : status === 429 ? 'rate-limited' : 'unavailable'
    )
    expect(f.catalog.savePublicationCheck).not.toHaveBeenCalled()
    expect(f.saved()).toEqual(previous())
  })

  it('retains rate-limit cooldown and permits a new attempt after it expires', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.fetch.mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '1' } })
      )
      expect((await f.checker.run(request)).issue).toBe('rate-limited')
      expect((await f.checker.run(request)).issue).toBe('rate-limited')
      expect(f.fetch).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1001)
      expect((await f.checker.run(request)).issue).toBeUndefined()
      expect(f.fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { message: { DOI: '10.1234/wrong' } },
    wire({ DOI: '10.1234/wrong' }),
    wire({ 'updated-by': [{ ...retraction, DOI: 'javascript:alert(1)' }] }),
    wire({ 'updated-by': 'not-an-array' }),
    wire({ 'updated-by': Array.from({ length: 101 }, () => retraction) }),
    wire({ 'updated-by': [{ ...retraction, source: 'unrecognized-source' }] })
  ])(
    'rejects malformed, mismatched or truncated responses without replacing saved results',
    async (body) => {
      const f = fixture(previous())
      f.fetch.mockResolvedValueOnce(Response.json(body))
      expect((await f.checker.run(request)).issue).toBe('response-invalid')
      expect(f.catalog.savePublicationCheck).not.toHaveBeenCalled()
      expect(f.saved()).toEqual(previous())
    }
  )

  it('bounds the streamed response and cancels oversized bodies', async () => {
    const f = fixture(previous())
    const cancel = vi.fn()
    f.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
          },
          cancel
        })
      )
    )
    expect((await f.checker.run(request)).issue).toBe('response-invalid')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(f.catalog.savePublicationCheck).not.toHaveBeenCalled()
  })

  it('rejects an otherwise valid oversized JSON response before saving an empty result', async () => {
    const f = fixture(previous())
    f.fetch.mockResolvedValueOnce(Response.json(wire({ title: ['x'.repeat(2 * 1024 * 1024)] })))
    const result = await f.checker.run(request)
    expect(result.issue).toBe('response-invalid')
    expect(result.snapshot).toEqual(previous())
    expect(f.catalog.savePublicationCheck).not.toHaveBeenCalled()
  })

  it('rejects a stale revision, removed item and merged identity before networking', async () => {
    for (const variant of ['stale', 'removed', 'merged'] as const) {
      const f = fixture()
      f.change(
        variant === 'removed'
          ? undefined
          : {
              ...f.item(),
              ...(variant === 'stale' ? { metadataRevision: 2 } : { id: 'merge-target' })
            }
      )
      expect((await f.checker.run(request)).issue).toBe(
        variant === 'stale' ? 'reference-changed' : 'reference-unavailable'
      )
      expect(f.fetch).not.toHaveBeenCalled()
    }
  })

  it('does not show a saved check for a previous DOI', async () => {
    const f = fixture({ ...previous(), doi: '10.1234/old' })
    expect((await f.checker.run({ ...request, mode: 'get' })).snapshot).toBeUndefined()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('rechecks identity after loading saved results', async () => {
    const f = fixture(previous())
    f.catalog.sources.mockImplementationOnce(async () => {
      f.change({ ...f.item(), metadataRevision: 2 })
      return [{ provider: 'crossref-publication-check', rawMetadata: previous() }]
    })
    const result = await f.checker.run({ ...request, mode: 'get' })
    expect(result.issue).toBe('reference-changed')
    expect(result.snapshot).toBeUndefined()
  })

  it('does not save a cancelled response even if the transport resolves after cancellation', async () => {
    const f = fixture(previous())
    const abort = new AbortController()
    f.fetch.mockImplementationOnce(async () => {
      abort.abort()
      return Response.json(wire())
    })
    expect((await f.checker.run(request, abort.signal)).issue).toBe('unavailable')
    expect(f.catalog.savePublicationCheck).not.toHaveBeenCalled()
    expect(f.saved()).toEqual(previous())
  })

  it('rejects a DOI change during the request and clears the obsolete response snapshot', async () => {
    const f = fixture(previous())
    f.fetch.mockImplementationOnce(async () => {
      f.change({
        ...f.item(),
        item: {
          ...f.item().item,
          identifiers: [{ scheme: 'doi', isPrimary: false, value: '10.1234/new' }]
        }
      })
      return Response.json(wire())
    })
    const result = await f.checker.run(request)
    expect(result.issue).toBe('reference-changed')
    expect(result.snapshot).toBeUndefined()
    expect(f.catalog.savePublicationCheck).not.toHaveBeenCalled()
    expect(f.saved()).toEqual(previous())
  })

  it('reports corrupt saved data but permits an explicit fresh check to repair it', async () => {
    const f = fixture()
    f.catalog.sources.mockResolvedValue([
      {
        provider: 'crossref-publication-check',
        rawMetadata: { corrupt: true } as unknown as LiteraturePublicationCheckSnapshot
      }
    ])
    expect((await f.checker.run({ ...request, mode: 'get' })).issue).toBe('response-invalid')
    expect(f.fetch).not.toHaveBeenCalled()
    expect((await f.checker.run(request)).snapshot?.notices).toEqual([])
    expect(f.catalog.savePublicationCheck).toHaveBeenCalledTimes(1)
  })

  it('prevents concurrent duplicate checks and releases the lock after failure', async () => {
    const f = fixture()
    let reject!: (reason: Error) => void
    f.fetch.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const first = f.checker.run(request)
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1))
    expect((await f.checker.run(request)).issue).toBe('unavailable')
    reject(new Error('network unavailable'))
    expect((await first).issue).toBe('unavailable')
    expect((await f.checker.run(request)).issue).toBeUndefined()
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('validates transport and persisted snapshots without accepting a safety verdict', () => {
    expect(
      literaturePublicationCheckRequestSchema.safeParse({ ...request, doi: DOI }).success
    ).toBe(false)
    expect(
      literaturePublicationCheckSnapshotSchema.safeParse({ ...previous(), status: 'safe' }).success
    ).toBe(false)
    expect(
      literaturePublicationCheckSnapshotSchema.safeParse({ ...previous(), checkedAt: -1 }).success
    ).toBe(false)
  })

  it.each(['doi', 'revision', 'removed', 'merged'] as const)(
    'clears stale results when identity changes while waiting for the save transaction: %s',
    async (change) => {
      const f = fixture(previous())
      f.catalog.savePublicationCheck.mockImplementationOnce(async () => {
        f.change(
          change === 'removed'
            ? undefined
            : {
                ...f.item(),
                ...(change === 'revision' ? { metadataRevision: 2 } : {}),
                ...(change === 'merged' ? { id: 'survivor' } : {}),
                ...(change === 'doi'
                  ? {
                      item: {
                        ...f.item().item,
                        identifiers: [{ scheme: 'doi', isPrimary: false, value: '10.1234/new' }]
                      }
                    }
                  : {})
              }
        )
        throw new Error('Transaction identity conflict')
      })
      const result = await f.checker.run(request)
      expect(result.issue).toBe(
        change === 'removed' || change === 'merged' ? 'reference-unavailable' : 'reference-changed'
      )
      expect(result.snapshot).toBeUndefined()
      expect(f.saved()).toEqual(previous())
    }
  )

  it('retains the saved result when persistence fails with the same identity', async () => {
    const f = fixture(previous())
    f.catalog.savePublicationCheck.mockRejectedValueOnce(new Error('Database unavailable'))
    const result = await f.checker.run(request)
    expect(result.issue).toBe('unavailable')
    expect(result.snapshot).toEqual(previous())
    expect(f.saved()).toEqual(previous())
  })

  it.each(['doi', 'revision', 'removed', 'merged'] as const)(
    'revalidates identity on network failure paths: %s',
    async (change) => {
      const f = fixture(previous())
      f.fetch.mockImplementationOnce(async () => {
        f.change(
          change === 'removed'
            ? undefined
            : {
                ...f.item(),
                ...(change === 'revision' ? { metadataRevision: 2 } : {}),
                ...(change === 'merged' ? { id: 'survivor' } : {}),
                ...(change === 'doi'
                  ? {
                      item: {
                        ...f.item().item,
                        identifiers: [{ scheme: 'doi', isPrimary: false, value: '10.1234/new' }]
                      }
                    }
                  : {})
              }
        )
        return new Response('', { status: 503 })
      })
      const result = await f.checker.run(request)
      expect(result.issue).toBe(
        change === 'removed' || change === 'merged' ? 'reference-unavailable' : 'reference-changed'
      )
      expect(result.snapshot).toBeUndefined()
      expect(f.saved()).toEqual(previous())
      expect(f.catalog.savePublicationCheck).not.toHaveBeenCalled()
    }
  )
})
