import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZINC_TOOLS } from './zinc'
import type { ToolContext } from '../types'

const tool = ZINC_TOOLS.find((t) => t.id === 'zinc_search_by_id')!

const ctx: ToolContext = {
  credentials: {},
  fetchJson: async () => {
    throw new Error('zinc_search_by_id must not use ctx.fetchJson (form-encoded POST needed)')
  },
  fetchText: async () => {
    throw new Error('zinc_search_by_id must not use ctx.fetchText')
  },
  postJson: async () => {
    throw new Error('zinc_search_by_id must not use ctx.postJson (JSON body, not form-encoded)')
  }
}

const textRes = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  }) as Response

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('zinc / zinc_search_by_id', () => {
  it('POSTs form-encoded fields to substances.txt, polls to SUCCESS, and returns a compact shape', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes(200, { task: 'ZTASK-1' })) // submit
      .mockResolvedValueOnce(textRes(200, { status: 'PENDING' })) // poll #1
      .mockResolvedValueOnce(
        textRes(200, {
          status: 'SUCCESS',
          result: {
            zinc22: [
              {
                zinc_id: 'ZINC000000000012',
                smiles: 'CC(=O)Oc1ccccc1C(=O)O',
                tranche_name: 'H13P130',
                catalogs: ['vendorA', 'vendorB']
              }
            ]
          }
        })
      ) // poll #2
    vi.stubGlobal('fetch', fetchImpl)

    const promise = tool.run!(ctx, { zinc_ids: ['ZINC000000000012'] })
    await vi.runAllTimersAsync()
    const out = (await promise) as {
      query: unknown
      total_available: number
      returned_count: number
      truncated: boolean
      records: Array<Record<string, unknown>>
    }

    expect(fetchImpl.mock.calls).toHaveLength(3)
    const [submitUrl, submitInit] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(submitUrl).toBe('https://cartblanche22.docking.org/substances.txt')
    expect(submitInit.method).toBe('POST')
    expect((submitInit.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded'
    )
    const submitBody = new URLSearchParams(submitInit.body as string)
    expect(submitBody.get('zinc_ids')).toBe('ZINC000000000012')
    expect(submitBody.get('output_fields')).toBe('zinc_id,smiles,tranche_name,catalogs')

    const [pollUrl] = fetchImpl.mock.calls[1] as [string, RequestInit]
    expect(pollUrl).toBe('https://cartblanche22.docking.org/search/result/ZTASK-1')
    const [pollUrl2] = fetchImpl.mock.calls[2] as [string, RequestInit]
    expect(pollUrl2).toBe('https://cartblanche22.docking.org/search/result/ZTASK-1')

    expect(out.query).toEqual({ zinc_ids: ['ZINC000000000012'] })
    expect(out.total_available).toBe(1)
    expect(out.returned_count).toBe(1)
    expect(out.truncated).toBe(false)
    expect(out.records).toEqual([
      {
        zinc_id: 'ZINC000000000012',
        smiles: 'CC(=O)Oc1ccccc1C(=O)O',
        tranche_name: 'H13P130',
        catalogs: ['vendorA', 'vendorB'],
        source: 'zinc22'
      }
    ])
  })

  it('joins multiple ids with commas in one submission', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes(200, { task: 'ZTASK-2' }))
      .mockResolvedValueOnce(textRes(200, { status: 'SUCCESS', result: { zinc22: [] } }))
    vi.stubGlobal('fetch', fetchImpl)

    const promise = tool.run!(ctx, { zinc_ids: ['ZINC000000000012', 'ZINC000000000013'] })
    await vi.runAllTimersAsync()
    await promise

    const [, submitInit] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const submitBody = new URLSearchParams(submitInit.body as string)
    expect(submitBody.get('zinc_ids')).toBe('ZINC000000000012,ZINC000000000013')
  })

  it('rejects a malformed ZINC id without making a network call', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(tool.run!(ctx, { zinc_ids: ['not-a-zinc-id'] })).rejects.toThrow(
      /not a valid ZINC id/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an id list entry containing a delimiter (comma-join injection guard)', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(
      tool.run!(ctx, { zinc_ids: ['ZINC000000000012,ZINC000000000013'] })
    ).rejects.toThrow(/comma or whitespace/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a batch over the 100-id bound', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const ids = Array.from({ length: 101 }, (_, i) => `ZINC${String(i).padStart(12, '0')}`)
    await expect(tool.run!(ctx, { zinc_ids: ids })).rejects.toThrow(
      /exceeds the per-call bound of 100/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires at least one id', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(tool.run!(ctx, { zinc_ids: [] })).rejects.toThrow(/at least one ZINC id/)
  })

  it('surfaces an HTTP 400 submit rejection with the server detail', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(400, { error: 'bad zinc_ids' }))
    vi.stubGlobal('fetch', fetchImpl)
    await expect(tool.run!(ctx, { zinc_ids: ['ZINC000000000012'] })).rejects.toThrow(/HTTP 400/)
  })

  it('surfaces the HTML SPA shell as an actionable error', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><html><body>app</body></html>'
    } as Response)
    vi.stubGlobal('fetch', fetchImpl)
    await expect(tool.run!(ctx, { zinc_ids: ['ZINC000000000012'] })).rejects.toThrow(
      /HTML app shell/
    )
  })

  it('surfaces a server-side FAILURE status', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes(200, { task: 'ZTASK-3' }))
      .mockResolvedValueOnce(textRes(200, { status: 'FAILURE' }))
    vi.stubGlobal('fetch', fetchImpl)
    const promise = tool.run!(ctx, { zinc_ids: ['ZINC000000000012'] })
    const assertion = expect(promise).rejects.toThrow(/failed server-side/)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('reports a task timeout naming the task uuid once the deadline passes', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes(200, { task: 'ZTASK-STUCK' }))
      .mockResolvedValue(textRes(200, { status: 'PENDING' }))
    vi.stubGlobal('fetch', fetchImpl)

    const promise = tool.run!(ctx, { zinc_ids: ['ZINC000000000012'], timeout_s: 5 })
    const assertion = expect(promise).rejects.toThrow(/ZTASK-STUCK/)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('bounds returned_count to max_results while reporting the true total', async () => {
    vi.useFakeTimers()
    const records = Array.from({ length: 5 }, (_, i) => ({
      zinc_id: `ZINC${String(i).padStart(12, '0')}`,
      smiles: 'C',
      tranche_name: 'H10P100',
      catalogs: []
    }))
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes(200, { task: 'ZTASK-4' }))
      .mockResolvedValueOnce(textRes(200, { status: 'SUCCESS', result: { zinc22: records } }))
    vi.stubGlobal('fetch', fetchImpl)

    const promise = tool.run!(ctx, { zinc_ids: ['ZINC000000000000'], max_results: 2 })
    await vi.runAllTimersAsync()
    const out = (await promise) as {
      total_available: number
      returned_count: number
      truncated: boolean
    }
    expect(out.total_available).toBe(5)
    expect(out.returned_count).toBe(2)
    expect(out.truncated).toBe(true)
  })
})
