import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import { STRUCTURES_TOOLS } from './structures'
import { STRUCTURES_OMNIPATH_TOOLS } from './structures-omnipath'
import { CONNECTOR_CATALOG } from './catalog'

const tool = STRUCTURES_OMNIPATH_TOOLS[0]!
const registry = createConnectorRegistry(STRUCTURES_TOOLS)
const args = { accession: 'P00533', direction: 'upstream', limit: 2 }
const row = {
  source: 'P22681',
  target: 'P00533',
  source_genesymbol: 'CBL',
  target_genesymbol: 'EGFR',
  is_directed: true,
  is_stimulation: true,
  is_inhibition: true,
  consensus_direction: true,
  consensus_stimulation: true,
  consensus_inhibition: false,
  sources: ['SIGNOR', 'IntAct'],
  references: 'SIGNOR:20332299;IntAct:23799367'
}
async function call(
  body: unknown,
  input: Record<string, unknown> = args
): Promise<{ result: unknown; fetchImpl: Mock<typeof fetch> }> {
  registry.validateToolArguments(tool, input)
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body))
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, input, {})
  return { result, fetchImpl }
}

describe('structures/omnipath_query_regulation', () => {
  it('uses the existing category and public structures facade', () => {
    expect(registry.getDescriptor('structures', tool.id)).toBe(tool)
    expect(CONNECTOR_CATALOG.find((c) => c.id === 'structures')?.sources).toContain('OmniPath')
    expect(CONNECTOR_CATALOG.some((c) => c.id === 'omnipath')).toBe(false)
    expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
  })
  it.each([
    {},
    { accession: 'EGFR', direction: 'upstream' },
    { ...args, accession: 'P00533-1' },
    { ...args, accession: 'P00533,P04637' },
    { ...args, direction: 'both' },
    { ...args, limit: 0 },
    { ...args, limit: 51 },
    { ...args, limit: 1.5 },
    { ...args, limit: '5' },
    { ...args, url: 'https://example.org' },
    { ...args, organism: 10090 }
  ])('rejects invalid input before transport: %j', (input) => {
    expect(() => registry.validateToolArguments(tool, input)).toThrow()
  })
  it.each(['upstream', 'downstream'])(
    'maps %s to the correct queried endpoint',
    async (direction) => {
      const edge =
        direction === 'upstream'
          ? row
          : {
              ...row,
              source: 'P00533',
              target: 'P22681',
              source_genesymbol: 'EGFR',
              target_genesymbol: 'CBL'
            }
      const { result, fetchImpl } = await call([edge], { ...args, direction })
      const url = new URL(String(fetchImpl.mock.calls[0]![0]))
      expect(url.origin + url.pathname).toBe('https://omnipathdb.org/interactions/')
      expect(url.searchParams.get(direction === 'upstream' ? 'targets' : 'sources')).toBe('P00533')
      expect(url.searchParams.has(direction === 'upstream' ? 'sources' : 'targets')).toBe(false)
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        limit: '3',
        organisms: '9606',
        datasets: 'omnipath',
        directed: '1',
        signed: '1',
        license: 'commercial',
        fields: 'sources,references'
      })
      expect(result).toMatchObject({
        direction,
        organism: 9606,
        returned: 1,
        records_truncated: false,
        records: [
          {
            ...edge,
            references: ['SIGNOR:20332299', 'IntAct:23799367'],
            source_count: 2,
            reference_count: 2,
            evidence_truncated: false
          }
        ]
      })
    }
  )
  it('retains simultaneous stimulation/inhibition and separate consensus without guessing', async () => {
    const { result } = await call([row])
    expect(result).toMatchObject({
      records: [
        {
          is_stimulation: true,
          is_inhibition: true,
          consensus_stimulation: true,
          consensus_inhibition: false
        }
      ]
    })
  })
  it.each(['upstream', 'downstream'])(
    'preserves native complex nodes for %s instead of inventing component edges',
    async (direction) => {
      const complex = 'COMPLEX:P67775_Q15172_Q15257'
      const edge =
        direction === 'upstream'
          ? { ...row, source: complex, source_genesymbol: 'PPP2CA_PPP2R5A_PTPA' }
          : {
              ...row,
              source: 'P00533',
              target: complex,
              source_genesymbol: 'EGFR',
              target_genesymbol: 'PPP2CA_PPP2R5A_PTPA'
            }
      const { result } = await call([edge], { ...args, direction })
      expect(result).toMatchObject({
        returned: 1,
        records: [expect.objectContaining({ source: edge.source, target: edge.target })]
      })
    }
  )
  it('handles a true empty result and uses the bounded default', async () => {
    const { result, fetchImpl } = await call([], { accession: 'P00533', direction: 'upstream' })
    expect(result).toMatchObject({ records: [], returned: 0, records_truncated: false })
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get('limit')).toBe('11')
  })
  it('uses one extra record for truncation and bounds evidence with explicit counts', async () => {
    const sources = Array.from({ length: 12 }, (_, i) => `Source${i}`)
    const references = Array.from({ length: 15 }, (_, i) => `Source${i}:${1000 + i}`)
    const edge = {
      ...row,
      sources,
      references: references.join(';'),
      extra_attrs: 'unselected content'
    }
    const { result } = await call([edge, row, row])
    expect(result).toMatchObject({
      returned: 2,
      records_truncated: true,
      records: [
        {
          sources: sources.slice(0, 10),
          references: references.slice(0, 10),
          source_count: 12,
          reference_count: 15,
          evidence_truncated: true
        },
        expect.anything()
      ]
    })
    expect(JSON.stringify(result)).not.toContain('unselected content')
    expect(result).not.toHaveProperty('total')
  })
  it.each([
    [['Unknown argument']],
    { error: 'upstream failure' },
    null,
    [null],
    [{ ...row, source: 'EGFR' }],
    [{ ...row, source: 'COMPLEX:garbage_P00533' }],
    [{ ...row, is_directed: false }],
    [{ ...row, is_stimulation: 'true' }],
    [{ ...row, sources: 'SIGNOR' }],
    [{ ...row, references: null }],
    [{ ...row, consensus_direction: undefined }],
    [row, row, row, row]
  ])('rejects malformed/error-shaped responses and ignored response limits: %j', async (body) => {
    await expect(call(body)).rejects.toThrow(/OmniPath returned an error or invalid/)
  })
  it.each([
    { ...row, target: 'P04637' },
    { ...row, is_stimulation: false, is_inhibition: false }
  ])('rejects ignored endpoint/sign filters: %j', async (edge) => {
    await expect(call([edge])).rejects.toThrow(/inconsistent with the requested filters/)
  })
  it('rejects reversed downstream matches', async () => {
    await expect(call([row], { ...args, direction: 'downstream' })).rejects.toThrow(/inconsistent/)
  })
  it('preserves absent citations without inventing evidence', async () => {
    expect((await call([{ ...row, sources: [], references: '' }])).result).toMatchObject({
      records: [{ sources: [], references: [], reference_count: 0 }]
    })
  })
  it('rejects oversized reference identifiers', async () => {
    await expect(call([{ ...row, references: 'x'.repeat(201) }])).rejects.toThrow(
      /invalid reference/
    )
  })
  it.each([429, 500])('preserves HTTP %i errors', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('failure', { status }))
    await expect(new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})).rejects.toThrow(
      `HTTP ${status}`
    )
  })
  it('rejects malformed JSON and oversized raw responses', async () => {
    for (const body of ['not JSON', 'x'.repeat(2_000_001)]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body))
      await expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})
      ).rejects.toThrow()
    }
  })
  it('propagates cancellation to the real transport boundary', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      controller.abort(new Error('cancelled by caller'))
      init!.signal!.throwIfAborted()
      return Response.json([])
    })
    await expect(
      new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {}, controller.signal)
    ).rejects.toThrow('cancelled by caller')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('enforces the engine request deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          })
        })
    )
    await expect(
      new ParserEngine({ fetchImpl, retries: 0, timeoutMs: 10 }).call(tool, args, {})
    ).rejects.toThrow(/timed out/)
  })
})
