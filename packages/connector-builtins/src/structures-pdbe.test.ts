import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import { STRUCTURES_TOOLS } from './structures'

const registry = createConnectorRegistry(STRUCTURES_TOOLS)
const tool = registry.getDescriptor('structures', 'pdbe_get_validation')!
const args = { pdb_id: '1CBS' }
const missing = { message: 'Requested endpoint does not contain any data' }
const entry = { title: 'Experimental structure', experimental_method: ['X-ray diffraction'] }
const quality = {
  geometry_quality: 65.48,
  data_quality: 94.74,
  overall_quality: 74.71,
  experiment_data_available: true
}
const stats = {
  protein_sidechains: { num_checked: 123, num_outliers: 3, percent_outliers: '2.44' },
  rna_suite: { num_checked: 0, num_outliers: 0, percent_outliers: null }
}
function transport(overrides: Record<string, unknown | Response> = {}): Mock<typeof fetch> {
  const values: Record<string, unknown | Response> = {
    summary: { '1cbs': [entry] },
    summary_quality_scores: { '1cbs': quality },
    key_validation_stats: { '1cbs': stats },
    ...overrides
  }
  return vi.fn<typeof fetch>(async (url) => {
    const key = Object.keys(values).find((key) => String(url).includes(`/${key}/`))!
    return values[key] instanceof Response ? (values[key] as Response) : Response.json(values[key])
  })
}
function call(fetchImpl = transport(), input = args): Promise<unknown> {
  registry.validateToolArguments(tool, input)
  return new ParserEngine({ fetchImpl, retries: 0 }).call(tool, input, {})
}

describe('structures/pdbe_get_validation', () => {
  it('normalizes a single ID and returns bounded native metrics through the Structures facade', async () => {
    const fetchImpl = transport()
    expect(await call(fetchImpl)).toMatchObject({
      pdb_id: '1cbs',
      entry_found: true,
      entry,
      quality_scores: quality,
      validation_stats: stats
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        'https://www.ebi.ac.uk/pdbe/api/pdb/entry/summary/1cbs',
        'https://www.ebi.ac.uk/pdbe/api/validation/summary_quality_scores/entry/1cbs',
        'https://www.ebi.ac.uk/pdbe/api/validation/key_validation_stats/entry/1cbs'
      ])
    )
    expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
  })

  it.each(['Solution NMR', 'Electron Microscopy'])(
    'preserves missing quality and unknown availability for %s',
    async (method) => {
      const absentMetrics = { ...quality, data_quality: null, experiment_data_available: 'unknown' }
      expect(
        await call(
          transport({
            summary: { '1cbs': [{ ...entry, experimental_method: [method] }] },
            summary_quality_scores: { '1cbs': absentMetrics }
          })
        )
      ).toMatchObject({ entry: { experimental_method: [method] }, quality_scores: absentMetrics })
    }
  )

  it('distinguishes an absent entry from an existing entry without a report', async () => {
    const fetchImpl = transport({ summary: Response.json(missing, { status: 404 }) })
    expect(await call(fetchImpl)).toMatchObject({
      entry_found: false,
      entry: null,
      quality_scores: null,
      validation_stats: null
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      await call(transport({ summary_quality_scores: Response.json(missing, { status: 404 }) }))
    ).toMatchObject({ entry_found: true, quality_scores: null, validation_stats: stats })
  })

  it.each(['', '0000', '1cbs/other', '1cbs,1d3z', 'pdb_00001cbs'])(
    'rejects invalid or unsupported IDs before transport: %s',
    async (pdb_id) => {
      const fetchImpl = transport()
      expect(() => registry.validateToolArguments(tool, { pdb_id })).toThrow()
      await expect(new ParserEngine({ fetchImpl }).call(tool, { pdb_id }, {})).rejects.toThrow(
        /PDB ID/
      )
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it.each([
    { summary: {} },
    { summary: { '2cbs': [entry] } },
    { summary: { '1cbs': [] } },
    { summary: { '1cbs': [{ ...entry, experimental_method: [] }] } },
    { summary_quality_scores: { '1cbs': { ...quality, data_quality: 101 } } },
    { summary_quality_scores: { '1cbs': { ...quality, experiment_data_available: 'false' } } },
    { key_validation_stats: { '1cbs': {} } },
    {
      key_validation_stats: {
        '1cbs': { bonds: { num_checked: 1, num_outliers: 2, percent_outliers: '200' } }
      }
    }
  ])('rejects invalid data instead of inventing an empty report: %j', async (overrides) => {
    await expect(call(transport(overrides))).rejects.toThrow(/invalid entry data/)
  })

  it('strips unrelated upstream data', async () => {
    const result = await call(
      transport({
        summary: { '1cbs': [{ ...entry, entry_authors: ['unneeded'] }] },
        summary_quality_scores: { '1cbs': { ...quality, extra: 'unneeded' } }
      })
    )
    expect(JSON.stringify(result)).not.toContain('unneeded')
  })

  it.each([429, 500])('propagates HTTP %i', async (status) => {
    await expect(
      call(transport({ summary: Response.json({ error: 'unavailable' }, { status }) }))
    ).rejects.toThrow()
  })

  it('does not hide an unexpected 404 body, invalid JSON or oversized response', async () => {
    for (const response of [
      Response.json({ error: 'wrong route' }, { status: 404 }),
      new Response('<html>error</html>'),
      new Response(' '.repeat(100_001))
    ]) {
      await expect(call(transport({ summary: response }))).rejects.toThrow()
    }
  })

  it('enforces a whole-call deadline across all requests', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}))
      const assertion = expect(call(fetchImpl)).rejects.toThrow(/deadline|timeout|timed out/i)
      await vi.advanceTimersByTimeAsync(25_001)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
