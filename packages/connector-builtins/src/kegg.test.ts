import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine, type ToolContext } from '@aipoch/connector-core'
import { KEGG_TOOLS } from './kegg'
import { CONNECTOR_CATALOG } from './catalog'
import { getConnectorTools } from './registry.test-helper'
const registry = createConnectorRegistry(KEGG_TOOLS)
afterEach(() => vi.useRealTimers())
async function call(
  index: number,
  raw: string,
  args: Record<string, unknown>,
  status = 200
): Promise<{ result: unknown; fetchImpl: Mock<typeof fetch> }> {
  registry.validateToolArguments(KEGG_TOOLS[index]!, args)
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(raw, { status }))
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(
    KEGG_TOOLS[index]!,
    args,
    {}
  )
  return { result, fetchImpl }
}
describe('KEGG', () => {
  it('is default off and documents eligibility in every tool', () => {
    expect(CONNECTOR_CATALOG.find((x) => x.id === 'kegg')).toMatchObject({
      defaultEnabled: false,
      termsUrl: expect.stringContaining('legal')
    })
    expect(getConnectorTools('kegg')).toHaveLength(3)
    for (const tool of KEGG_TOOLS) {
      expect(tool.description).toContain('academic')
      expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
      expect(() =>
        registry.validateToolArguments(tool, { ...tool.exampleArgs, url: 'http://localhost' })
      ).toThrow()
    }
  })
  it('caps search output, retains counts and encodes user queries', async () => {
    const { result, fetchImpl } = await call(0, 'map00010\tGlycolysis\nmap00020\tCitrate cycle\n', {
      database: 'pathway',
      query: 'a/b?x=1',
      limit: 1
    })
    expect(result).toMatchObject({
      records: [{ id: 'map00010', name: 'Glycolysis' }],
      matched: 2,
      truncated: true
    })
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('a%2Fb%3Fx%3D1')
    expect((await call(0, '', { database: 'ko', query: 'missing' })).result).toMatchObject({
      records: [],
      matched: 0,
      truncated: false
    })
  })
  it('rejects malformed or wrong-database search rows', async () => {
    await expect(call(0, '<html>error</html>', { database: 'ko', query: 'HK' })).rejects.toThrow(
      /malformed/
    )
    await expect(call(0, 'cpd:C00031\tGlucose\n', { database: 'ko', query: 'HK' })).rejects.toThrow(
      /identifier/
    )
  })
  it('parses selected fields and continuation lines without exposing bulk genes', async () => {
    const { result } = await call(
      1,
      'ENTRY       K00844                      KO\nNAME        hexokinase\nPATHWAY     map00010 Glycolysis\n            map00051 Fructose\nGENES       many genes\n            more genes\n///\n',
      { id: 'K00844' }
    )
    expect(result).toMatchObject({
      id: 'K00844',
      fields: { NAME: ['hexokinase'], PATHWAY: ['map00010 Glycolysis', 'map00051 Fructose'] },
      truncated: false,
      selected_fields_only: true
    })
    expect((result as { fields: object }).fields).not.toHaveProperty('GENES')
  })
  it('flags field truncation', async () => {
    const raw =
      'ENTRY       K00844 KO\nNAME        ' +
      'x'.repeat(600) +
      '\n' +
      Array.from({ length: 35 }, () => '            extra\n').join('') +
      '///\n'
    const { result } = await call(1, raw, { id: 'K00844' })
    const value = result as { fields: Record<string, string[]>; truncated: boolean }
    expect(value.truncated).toBe(true)
    expect(value.fields.NAME).toHaveLength(30)
    expect(value.fields.NAME![0]).toHaveLength(500)
  })
  it.each(['ENTRY       K00001 KO\n///\n', 'ENTRY       K00844 KO\n', '<html>challenge</html>'])(
    'rejects wrong or incomplete flatfiles',
    async (raw) => {
      await expect(call(1, raw, { id: 'K00844' })).rejects.toThrow()
    }
  )
  it('preserves one-to-many mappings, checks source identity and propagates 404', async () => {
    expect(
      (
        await call(2, 'hsa:7157\tup:P04637\nhsa:7157\tup:K7PPA8\n', {
          gene: 'hsa:7157',
          target: 'uniprot'
        })
      ).result
    ).toMatchObject({
      mappings: [
        { from: 'hsa:7157', to: 'up:P04637' },
        { from: 'hsa:7157', to: 'up:K7PPA8' }
      ],
      truncated: false
    })
    await expect(
      call(2, 'hsa:1\tpath:hsa00010\n', { gene: 'hsa:7157', target: 'pathway' })
    ).rejects.toThrow(/identities/)
    await expect(call(1, '', { id: 'K99999' }, 404)).rejects.toThrow()
  })
  it('paces concurrent requests and prevents transport retries bypassing the limiter', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_000)
    const times: number[] = []
    const fetchText = vi.fn(async () => {
      times.push(Date.now())
      return 'map00010\tGlycolysis\n'
    })
    const ctx = { fetchText, credentials: {} } as unknown as ToolContext
    const calls = Array.from({ length: 3 }, () =>
      KEGG_TOOLS[0]!.run!(ctx, { database: 'pathway', query: 'glycolysis' })
    )
    await vi.runAllTimersAsync()
    await Promise.all(calls)
    expect(times.slice(1).map((t, i) => t - times[i]!)).toEqual([400, 400])
    expect(fetchText).toHaveBeenCalledWith(expect.any(String), 'text/plain', { retry: false })
    const controller = new AbortController()
    controller.abort()
    await expect(
      KEGG_TOOLS[0]!.run!(
        { ...ctx, signal: controller.signal },
        { database: 'pathway', query: 'x' }
      )
    ).rejects.toThrow()
    expect(fetchText).toHaveBeenCalledTimes(3)
  })
  it.each([
    [1, { id: 'K00844/../x' }],
    [2, { gene: 'hsa:7157?x', target: 'uniprot' }],
    [0, { database: 'genes', query: 'all' }]
  ] as const)('rejects unsupported scope and path injection', (index, args) => {
    expect(() => registry.validateToolArguments(KEGG_TOOLS[index]!, args)).toThrow()
  })
})
