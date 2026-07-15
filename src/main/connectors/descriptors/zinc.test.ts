import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZINC_TOOLS } from './zinc'
import type { ToolContext } from '../types'

const byId = ZINC_TOOLS.find((t) => t.id === 'zinc_search_by_id')!
const bySmiles = ZINC_TOOLS.find((t) => t.id === 'zinc_search_by_smiles')!
const bySupplier = ZINC_TOOLS.find((t) => t.id === 'zinc_search_by_supplier')!
const randomSample = ZINC_TOOLS.find((t) => t.id === 'zinc_random_sample')!
const get3d = ZINC_TOOLS.find((t) => t.id === 'zinc_get_3d')!

// None of the ZINC tools may touch the ToolContext transport — they all need a form-encoded POST +
// manual poll the ToolContext can't express, so they use the global fetch directly.
const ctx: ToolContext = {
  credentials: {},
  fetchJson: async () => {
    throw new Error('zinc tools must not use ctx.fetchJson (form-encoded POST needed)')
  },
  fetchText: async () => {
    throw new Error('zinc tools must not use ctx.fetchText')
  },
  fetchJsonWithHeaders: async () => {
    throw new Error('zinc tools must not use ctx.fetchJsonWithHeaders')
  },
  postJson: async () => {
    throw new Error('zinc tools must not use ctx.postJson (JSON body, not form-encoded)')
  }
}

const textRes = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  }) as Response

// Drives a tool through the fake-timer submit->poll flow: each response is returned in order.
async function drive(
  tool: (typeof ZINC_TOOLS)[number],
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: unknown; fetchImpl: ReturnType<typeof vi.fn> }> {
  vi.useFakeTimers()
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  vi.stubGlobal('fetch', fetchImpl)
  const promise = tool.run!(ctx, args)
  await vi.runAllTimersAsync()
  return { out: await promise, fetchImpl }
}

const submitBodyOf = (fetchImpl: ReturnType<typeof vi.fn>): URLSearchParams => {
  const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
  return new URLSearchParams(init.body as string)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('zinc / registration', () => {
  it('exposes all five tools in upstream order, all on the zinc connector', () => {
    expect(ZINC_TOOLS.map((t) => t.id)).toEqual([
      'zinc_search_by_id',
      'zinc_search_by_smiles',
      'zinc_search_by_supplier',
      'zinc_random_sample',
      'zinc_get_3d'
    ])
    expect(ZINC_TOOLS.every((t) => t.connector === 'zinc')).toBe(true)
    expect(ZINC_TOOLS.every((t) => typeof t.run === 'function')).toBe(true)
  })
})

describe('zinc / zinc_search_by_id', () => {
  it('POSTs form-encoded fields to substances.txt, polls to SUCCESS, and returns the bounded shape', async () => {
    const { out, fetchImpl } = await drive(byId, { zinc_ids: ['ZINC000000000012'] }, [
      textRes(200, { task: 'ZTASK-1' }), // submit
      textRes(200, { status: 'PENDING' }), // poll #1
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
      }) // poll #2
    ])

    expect(fetchImpl.mock.calls).toHaveLength(3)
    const [submitUrl, submitInit] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(submitUrl).toBe('https://cartblanche22.docking.org/substances.txt')
    expect(submitInit.method).toBe('POST')
    expect((submitInit.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded'
    )
    const submitBody = submitBodyOf(fetchImpl)
    expect(submitBody.get('zinc_ids')).toBe('ZINC000000000012')
    expect(submitBody.get('output_fields')).toBe('zinc_id,smiles,tranche_name,catalogs')

    const [pollUrl] = fetchImpl.mock.calls[1] as [string, RequestInit]
    expect(pollUrl).toBe('https://cartblanche22.docking.org/search/result/ZTASK-1')

    const o = out as {
      query: unknown
      total_available: number
      returned_count: number
      truncated: boolean
      source_counts: Record<string, number>
      records: Array<Record<string, unknown>>
    }
    expect(o.query).toEqual({ zinc_ids: ['ZINC000000000012'] })
    expect(o.total_available).toBe(1)
    expect(o.returned_count).toBe(1)
    expect(o.truncated).toBe(false)
    expect(o.source_counts).toEqual({ zinc22: 1 })
    // Record carries the standard fields plus the decoded tranche (H13P130 -> 13 heavy atoms, +1.3 logP).
    expect(o.records).toEqual([
      {
        zinc_id: 'ZINC000000000012',
        smiles: 'CC(=O)Oc1ccccc1C(=O)O',
        tranche_name: 'H13P130',
        catalogs: ['vendorA', 'vendorB'],
        source: 'zinc22',
        tranche_properties: { heavy_atoms: 13, logp: 1.3 }
      }
    ])
  })

  it('joins multiple ids with commas and tags per-source counts, zinc22 first', async () => {
    const { out, fetchImpl } = await drive(
      byId,
      { zinc_ids: ['ZINC000000000012', 'ZINC000000000013'] },
      [
        textRes(200, { task: 'ZTASK-2' }),
        textRes(200, {
          status: 'SUCCESS',
          result: {
            zinc20: [{ zinc_id: 'ZINC000000000013', smiles: 'C', tranche_name: 'H10P100' }],
            zinc22: [{ zinc_id: 'ZINC000000000012', smiles: 'CC', tranche_name: 'H11M050' }]
          }
        })
      ]
    )
    expect(submitBodyOf(fetchImpl).get('zinc_ids')).toBe('ZINC000000000012,ZINC000000000013')
    const o = out as {
      source_counts: Record<string, number>
      records: Array<{ source: string; tranche_properties: unknown }>
    }
    expect(o.source_counts).toEqual({ zinc22: 1, zinc20: 1 })
    // zinc22 (current release) is presented first; negative logP bin decodes with the M sign.
    expect(o.records[0].source).toBe('zinc22')
    expect(o.records[0].tranche_properties).toEqual({ heavy_atoms: 11, logp: -0.5 })
  })

  it('rejects a malformed ZINC id without making a network call', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(byId.run!(ctx, { zinc_ids: ['not-a-zinc-id'] })).rejects.toThrow(
      /not a valid ZINC id/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an id list entry containing a delimiter (comma-join injection guard)', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(
      byId.run!(ctx, { zinc_ids: ['ZINC000000000012,ZINC000000000013'] })
    ).rejects.toThrow(/comma or whitespace/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a batch over the 100-id bound', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const ids = Array.from({ length: 101 }, (_, i) => `ZINC${String(i).padStart(12, '0')}`)
    await expect(byId.run!(ctx, { zinc_ids: ids })).rejects.toThrow(
      /exceeds the per-call bound of 100/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires at least one id', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(byId.run!(ctx, { zinc_ids: [] })).rejects.toThrow(/at least one ZINC id/)
  })

  it('surfaces an HTTP 400 submit rejection with the server detail', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(400, { error: 'bad zinc_ids' }))
    vi.stubGlobal('fetch', fetchImpl)
    await expect(byId.run!(ctx, { zinc_ids: ['ZINC000000000012'] })).rejects.toThrow(/HTTP 400/)
  })

  it('surfaces the HTML SPA shell as an actionable error', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><html><body>app</body></html>'
    } as Response)
    vi.stubGlobal('fetch', fetchImpl)
    await expect(byId.run!(ctx, { zinc_ids: ['ZINC000000000012'] })).rejects.toThrow(
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
    const promise = byId.run!(ctx, { zinc_ids: ['ZINC000000000012'] })
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

    const promise = byId.run!(ctx, { zinc_ids: ['ZINC000000000012'], timeout_s: 5 })
    const assertion = expect(promise).rejects.toThrow(/ZTASK-STUCK/)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('bounds returned_count to max_results while reporting the true total', async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      zinc_id: `ZINC${String(i).padStart(12, '0')}`,
      smiles: 'C',
      tranche_name: 'H10P100',
      catalogs: []
    }))
    const { out } = await drive(byId, { zinc_ids: ['ZINC000000000000'], max_results: 2 }, [
      textRes(200, { task: 'ZTASK-4' }),
      textRes(200, { status: 'SUCCESS', result: { zinc22: records } })
    ])
    const o = out as { total_available: number; returned_count: number; truncated: boolean }
    expect(o.total_available).toBe(5)
    expect(o.returned_count).toBe(2)
    expect(o.truncated).toBe(true)
  })
})

describe('zinc / zinc_search_by_smiles', () => {
  it('POSTs smiles/dist/adist to smiles.txt and echoes the resolved query', async () => {
    const { out, fetchImpl } = await drive(
      bySmiles,
      { smiles: '  CC(=O)Oc1ccccc1C(=O)O ', dist: 2 },
      [
        textRes(200, { task: 'ZTASK-S' }),
        textRes(200, {
          status: 'SUCCESS',
          result: { zinc22: [{ zinc_id: 'ZINC1', smiles: 'CC', tranche_name: 'H12P080' }] }
        })
      ]
    )
    const [submitUrl] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(submitUrl).toBe('https://cartblanche22.docking.org/smiles.txt')
    const body = submitBodyOf(fetchImpl)
    expect(body.get('smiles')).toBe('CC(=O)Oc1ccccc1C(=O)O') // trimmed
    expect(body.get('dist')).toBe('2')
    expect(body.get('adist')).toBe('2') // defaults to dist
    expect(body.get('output_fields')).toBe('zinc_id,smiles,tranche_name,catalogs')
    const o = out as { query: unknown }
    expect(o.query).toEqual({ smiles: 'CC(=O)Oc1ccccc1C(=O)O', dist: 2, adist: 2 })
  })

  it('defaults dist to 0 (exact match) and honors an explicit adist', async () => {
    const { fetchImpl } = await drive(bySmiles, { smiles: 'C', adist: 5 }, [
      textRes(200, { task: 'ZTASK-S2' }),
      textRes(200, { status: 'SUCCESS', result: { zinc22: [] } })
    ])
    const body = submitBodyOf(fetchImpl)
    expect(body.get('dist')).toBe('0')
    expect(body.get('adist')).toBe('5')
  })

  it('rejects an empty SMILES without a network call', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(bySmiles.run!(ctx, { smiles: '   ' })).rejects.toThrow(/non-empty SMILES/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a dist outside 0-10 without a network call', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(bySmiles.run!(ctx, { smiles: 'C', dist: 11 })).rejects.toThrow(/dist must be 0-10/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('zinc / zinc_search_by_supplier', () => {
  it('resolves supplier codes to catitems.txt and surfaces supplier_code on records', async () => {
    const { out, fetchImpl } = await drive(bySupplier, { supplier_codes: ['MCULE-2311834287'] }, [
      textRes(200, { task: 'ZTASK-SUP' }),
      textRes(200, {
        status: 'SUCCESS',
        result: {
          zinc22: [
            {
              zinc_id: 'ZINC000000000012',
              smiles: 'CC',
              supplier_code: 'MCULE-2311834287',
              catalogs: ['mcule'],
              tranche_name: 'H12P080'
            }
          ]
        }
      })
    ])
    const [submitUrl] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(submitUrl).toBe('https://cartblanche22.docking.org/catitems.txt')
    const body = submitBodyOf(fetchImpl)
    expect(body.get('supplier_codes')).toBe('MCULE-2311834287')
    expect(body.get('output_fields')).toBe('zinc_id,smiles,supplier_code,catalogs,tranche_name')

    const o = out as { query: unknown; records: Array<Record<string, unknown>> }
    expect(o.query).toEqual({ supplier_codes: ['MCULE-2311834287'] })
    expect(o.records[0]).toEqual({
      zinc_id: 'ZINC000000000012',
      smiles: 'CC',
      tranche_name: 'H12P080',
      catalogs: ['mcule'],
      source: 'zinc22',
      supplier_code: 'MCULE-2311834287',
      tranche_properties: { heavy_atoms: 12, logp: 0.8 }
    })
  })

  it('requires at least one supplier code', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(bySupplier.run!(ctx, { supplier_codes: [] })).rejects.toThrow(
      /at least one supplier code/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('zinc / zinc_random_sample', () => {
  it('POSTs count (as max_results) + subset to substance/random.txt', async () => {
    const { out, fetchImpl } = await drive(randomSample, { count: 3, subset: 'lead-like' }, [
      textRes(200, { task: 'ZTASK-R' }),
      textRes(200, {
        status: 'SUCCESS',
        result: {
          zinc22: Array.from({ length: 5 }, (_, i) => ({
            zinc_id: `ZINC${String(i).padStart(12, '0')}`,
            smiles: 'C',
            tranche_name: 'H10P100'
          }))
        }
      })
    ])
    const [submitUrl] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(submitUrl).toBe('https://cartblanche22.docking.org/substance/random.txt')
    const body = submitBodyOf(fetchImpl)
    expect(body.get('count')).toBe('3')
    expect(body.get('subset')).toBe('lead-like')

    // count doubles as the response bound: 5 upstream rows, capped to 3.
    const o = out as {
      query: Record<string, unknown>
      total_available: number
      returned_count: number
      truncated: boolean
    }
    expect(o.total_available).toBe(5)
    expect(o.returned_count).toBe(3)
    expect(o.truncated).toBe(true)
    expect(o.query.count).toBe(3)
    expect(o.query.subset).toBe('lead-like')
    expect(o.query.known_subsets).toEqual(['fragment', 'lead-like', 'drug-like', 'lugs'])
  })

  it('omits the subset form field when no subset is given', async () => {
    const { out, fetchImpl } = await drive(randomSample, {}, [
      textRes(200, { task: 'ZTASK-R2' }),
      textRes(200, { status: 'SUCCESS', result: { zinc22: [] } })
    ])
    expect(submitBodyOf(fetchImpl).has('subset')).toBe(false)
    const o = out as { query: Record<string, unknown> }
    expect(o.query.subset).toBeNull()
  })
})

describe('zinc / zinc_get_3d', () => {
  it('resolves each id to its tranche repository directory + formats, normalizing short ids', async () => {
    const { out, fetchImpl } = await drive(get3d, { zinc_ids: ['ZINC12', 'ZINC000000000099'] }, [
      textRes(200, { task: 'ZTASK-3D' }),
      textRes(200, {
        status: 'SUCCESS',
        result: {
          zinc22: [
            {
              zinc_id: 'ZINC000000000012',
              smiles: 'CC(=O)O',
              tranche_name: 'H13P130'
            }
          ]
        }
      })
    ])
    // Short form is zero-padded to 12 digits before the submit.
    const [submitUrl] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(submitUrl).toBe('https://cartblanche22.docking.org/substances.txt')
    expect(submitBodyOf(fetchImpl).get('zinc_ids')).toBe('ZINC000000000012,ZINC000000000099')

    const o = out as {
      query: unknown
      returned_count: number
      structures: Array<Record<string, unknown>>
      repository_note: string
    }
    expect(o.query).toEqual({ zinc_ids: ['ZINC12', 'ZINC000000000099'] })
    expect(o.returned_count).toBe(2)

    const first = o.structures[0]
    expect(first.found).toBe(true)
    expect(first.zinc_id).toBe('ZINC000000000012')
    expect(first.tranche_name).toBe('H13P130')
    expect(first.tranche_properties).toEqual({ heavy_atoms: 13, logp: 1.3 })
    expect(first.download).toEqual({
      repository: 'https://files.docking.org/zinc22/',
      tranche_path_pattern: 'zinc-22*/H13/H13P130/',
      formats: {
        'db2.gz': 'DOCK 3.x/6 multi-conformer database',
        'mol2.gz': 'Tripos MOL2 with 3D coordinates',
        'sdf.gz': 'SDF with 3D coordinates',
        smi: 'SMILES (no 3D; for bookkeeping)'
      }
    })

    // The unmatched id gets a plain found:false with no download block.
    expect(o.structures[1]).toEqual({ zinc_id: 'ZINC000000000099', found: false })
    expect(o.repository_note).toMatch(/zinc-22a/)
  })

  it('rejects a batch over the 50-id 3D bound', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const ids = Array.from({ length: 51 }, (_, i) => `ZINC${String(i).padStart(12, '0')}`)
    await expect(get3d.run!(ctx, { zinc_ids: ids })).rejects.toThrow(
      /exceeds the per-call bound of 50/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
