import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import { STRUCTURES_PDB_TOOLS } from './structures-pdb'

const registry = createConnectorRegistry(STRUCTURES_PDB_TOOLS)
const tool = registry.getDescriptor('structures', 'pdb_search_structure_similarity')!
const args = { pdb_id: '1CLL', label_asym_id: 'A', max_rows: 2 }
const hit = (identifier = '1CLL.A', score = 1): object => ({
  identifier,
  score,
  services: [{ service_type: 'structure', nodes: [{ original_score: 0.99 }] }]
})
const body = {
  result_type: 'polymer_instance',
  total_count: 679,
  result_set: [hit(), hit('1CLM.A', 0)]
}
async function call(
  response: Response,
  input: Record<string, unknown> = args
): Promise<{ result: unknown; fetchImpl: Mock<typeof fetch> }> {
  registry.validateToolArguments(tool, input)
  const fetchImpl = vi.fn<typeof fetch>(async () => response)
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, input, {})
  return { result, fetchImpl }
}

describe('pdb_search_structure_similarity', () => {
  it('queries label_asym_id and returns chain-level ranking, self hits and upstream totals', async () => {
    const { result, fetchImpl } = await call(Response.json(body), {
      ...args,
      pdb_id: '1cll',
      label_asym_id: 'a'
    })
    const [url, options] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://search.rcsb.org/rcsbsearch/v2/query')
    expect(options?.method).toBe('POST')
    expect(JSON.parse(String(options?.body))).toEqual({
      query: {
        type: 'terminal',
        service: 'structure',
        parameters: {
          value: { entry_id: '1CLL', asym_id: 'a' },
          target_search_space: 'polymer_entity_instance',
          similarity_type: 'global',
          ptmscore_cutoff: 0.8,
          number_of_candidates: 10_000
        }
      },
      return_type: 'polymer_instance',
      request_options: {
        paginate: { start: 0, rows: 2 },
        results_content_type: ['experimental'],
        results_verbosity: 'verbose'
      }
    })
    expect(result).toMatchObject({
      query: { pdb_id: '1CLL', label_asym_id: 'a' },
      total_count: 679,
      n_returned: 2,
      truncated: true,
      records: [
        {
          identifier: '1CLL.A',
          pdb_id: '1CLL',
          label_asym_id: 'A',
          relevance_score: 1,
          raw_structure_score: 0.99
        },
        { identifier: '1CLM.A', relevance_score: 0, raw_structure_score: 0.99 }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('caps an overlong response without changing total_count', async () => {
    const { result } = await call(Response.json(body), { ...args, max_rows: 1 })
    expect(result).toMatchObject({ total_count: 679, n_returned: 1, truncated: true })
  })
  it('uses the upstream 204 empty-result contract', async () => {
    expect((await call(new Response(null, { status: 204 }))).result).toMatchObject({
      total_count: 0,
      n_returned: 0,
      records: [],
      truncated: false
    })
  })
  it('reports complete small result sets', async () => {
    expect((await call(Response.json({ ...body, total_count: 2 }))).result).toMatchObject({
      n_returned: 2,
      truncated: false
    })
  })
  it.each([
    {},
    { ...args, pdb_id: '0XXX' },
    { ...args, pdb_id: 'pdb_00001cll' },
    { ...args, pdb_id: 'PDB_00001CLL' },
    { ...args, label_asym_id: 'A/B' },
    { ...args, label_asym_id: '' },
    { ...args, max_rows: 0 },
    { ...args, max_rows: 51 },
    { ...args, max_rows: 1.5 },
    { ...args, assembly_id: '1' }
  ])('rejects invalid arguments before transport: %j', (input) => {
    expect(() => registry.validateToolArguments(tool, input)).toThrow()
  })
  it.each([
    null,
    {},
    { ...body, result_type: 'entry' },
    { ...body, total_count: 1 },
    { ...body, result_set: [] },
    { ...body, result_set: [hit(), hit()] },
    { ...body, result_set: [hit('1CLL_1')] },
    { ...body, result_set: [{ identifier: '1CLL.A', score: 1 }] },
    { ...body, result_set: [{ ...hit(), score: '1' }] }
  ])('rejects malformed or inconsistent responses: %j', async (raw) => {
    await expect(call(Response.json(raw))).rejects.toThrow()
  })
  it.each([400, 404, 429, 503])('keeps HTTP %i as an error, not no hits', async (status) => {
    await expect(call(Response.json({ message: 'invalid chain' }, { status }))).rejects.toThrow(
      `HTTP ${status}`
    )
  })
  it('rejects a non-JSON success body and enforces its response budget', async () => {
    await expect(call(new Response('<html>maintenance</html>'))).rejects.toThrow()
    await expect(call(new Response(' '.repeat(tool.maxResponseBytes! + 1)))).rejects.toThrow()
  })
  it('rejects unsupported extended IDs even when invoked without registry validation', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool, { ...args, pdb_id: 'pdb_00001cll' }, {})
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('honors cancellation without making a request', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool, args, {}, controller.signal)
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
