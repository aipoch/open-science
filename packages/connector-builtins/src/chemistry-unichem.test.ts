import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import { CHEMISTRY_TOOLS } from './chemistry'

const registry = createConnectorRegistry(CHEMISTRY_TOOLS)
const tool = registry.getDescriptor('chemistry', 'unichem_map_compound')!
const key = 'RMUCZJUITONUFY-UHFFFAOYSA-N'
const args = { id_type: 'chembl', identifier: 'CHEMBL1089' }
// Representative identity and mapping fields from the live UniChem response.
const row = {
  uci: 211306,
  standardInchiKey: key,
  sources: [
    { id: 1, compoundId: 'CHEMBL1089' },
    { id: 7, compoundId: 'CHEBI:8060' },
    { id: 22, compoundId: '3675' },
    { id: 2, compoundId: 'DB00780' }
  ]
}
const envelope = (
  rows = [row]
): { response: string; totalCompounds: string; compounds: (typeof row)[] } => ({
  response: 'Success',
  totalCompounds: String(rows.length),
  compounds: rows
})
async function call(
  body: unknown = envelope(),
  input = args
): Promise<{ result: unknown; fetchImpl: Mock<typeof fetch> }> {
  registry.validateToolArguments(tool, input)
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body))
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, input, {})
  return { result, fetchImpl }
}

describe('chemistry/unichem_map_compound', () => {
  it.each([args, { id_type: 'inchikey', identifier: key }])(
    'posts an exact query and projects only the three target databases: %j',
    async (input) => {
      const { result, fetchImpl } = await call(envelope(), input)
      const [url, init] = fetchImpl.mock.calls[0]!
      expect(url).toBe('https://www.ebi.ac.uk/unichem/api/v1/compounds')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual(
        input.id_type === 'inchikey'
          ? { compound: key, type: 'inchikey' }
          : { compound: 'CHEMBL1089', sourceID: 1, type: 'sourceID' }
      )
      expect(result).toMatchObject({
        total_matches: 1,
        records_truncated: false,
        records: [
          {
            uci: row.uci,
            standard_inchi_key: key,
            total_mappings: 4,
            filtered_out_mappings: 1,
            matching_mappings: 3,
            mappings_truncated: false,
            mappings: [
              {
                source: 'ChEMBL',
                identifier: 'CHEMBL1089',
                url: 'https://www.ebi.ac.uk/chembl/compound_report_card/CHEMBL1089'
              },
              {
                source: 'ChEBI',
                identifier: 'CHEBI:8060',
                url: 'https://www.ebi.ac.uk/chebi/CHEBI:8060'
              },
              {
                source: 'PubChem',
                identifier: '3675',
                url: 'https://pubchem.ncbi.nlm.nih.gov/compound/3675'
              }
            ]
          }
        ]
      })
      expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
    }
  )

  it.each([
    {},
    { id_type: 'name', identifier: 'aspirin' },
    { ...args, identifier: 'CHEMBL0' },
    { ...args, identifier: 'CHEMBL1089,25' },
    { ...args, identifier: 'chembl1089' },
    { id_type: 'inchikey', identifier: 'RMUCZJUITONUFY' },
    { id_type: 'inchikey', identifier: key.toLowerCase() }
  ])('rejects broad or invalid queries: %j', async (input) => {
    expect(() => registry.validateToolArguments(tool, input)).toThrow()
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(new ParserEngine({ fetchImpl }).call(tool, input, {})).rejects.toThrow(
      /exact full|missing required arg/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns empty records only for an explicit no-match envelope', async () => {
    expect((await call({ compounds: [], response: 'Not found' })).result).toMatchObject({
      total_matches: 0,
      records: [],
      records_truncated: false
    })
  })

  it('preserves structure matches, caps output and validates rows beyond the cap', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ ...row, uci: i + 1 }))
    const { result } = await call(envelope(rows))
    expect(result).toMatchObject({ total_matches: 6, records_truncated: true })
    expect((result as { records: unknown[] }).records).toHaveLength(5)
    rows[5] = { ...rows[5], sources: [{ id: 1, compoundId: 'CHEMBL25' }] }
    await expect(call(envelope(rows))).rejects.toThrow(/inconsistent with/)
  })

  it('distinguishes source filtering from truncation without trusting upstream URLs', async () => {
    const sources = [
      row.sources[0],
      ...Array.from({ length: 25 }, (_, i) => ({
        id: 22,
        compoundId: String(i + 1),
        url: 'https://untrusted.invalid/'
      })),
      ...Array.from({ length: 1000 }, (_, i) => ({ id: 50, compoundId: `trial${i}` }))
    ]
    const { result } = await call(envelope([{ ...row, sources }]))
    expect(result).toMatchObject({
      records: [
        {
          total_mappings: 1026,
          filtered_out_mappings: 1000,
          matching_mappings: 26,
          mappings_truncated: true
        }
      ]
    })
    expect((result as { records: { mappings: unknown[] }[] }).records[0].mappings).toHaveLength(20)
    expect(JSON.stringify(result)).not.toContain('untrusted')
    expect(JSON.stringify(result)).not.toContain('trial')
    expect(JSON.stringify(result).length).toBeLessThan(5000)
  })

  it('does not confuse no target mappings with no compound match', async () => {
    expect(
      (
        await call(envelope([{ ...row, sources: [{ id: 2, compoundId: 'DB00780' }] }]), {
          id_type: 'inchikey',
          identifier: key
        })
      ).result
    ).toMatchObject({
      total_matches: 1,
      records: [{ mappings: [], matching_mappings: 0, filtered_out_mappings: 1 }]
    })
  })

  it.each([
    null,
    {},
    { response: 'Success', compounds: [] },
    { ...envelope(), totalCompounds: 2 },
    { ...envelope(), response: 'Not found' },
    envelope([{ ...row, sources: [{ id: 1, compoundId: 'CHEMBL25' }] }]),
    envelope([{ ...row, sources: [...row.sources, { id: 22, compoundId: '../escape' }] }]),
    envelope([{ ...row, standardInchiKey: 'bad' }])
  ])('rejects invalid or inconsistent data: %j', async (body) => {
    await expect(call(body)).rejects.toThrow(/UniChem returned/)
  })

  it('rejects a mismatched full InChIKey', async () => {
    await expect(
      call(envelope(), { id_type: 'inchikey', identifier: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N' })
    ).rejects.toThrow(/inconsistent with/)
  })

  it.each([404, 429, 500])('propagates HTTP %i instead of reporting no match', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: 'failure' }, { status })
    )
    await expect(new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})).rejects.toThrow()
  })

  it('rejects malformed JSON and excessive downloads through the engine', async () => {
    for (const text of ['<html>error</html>', ' '.repeat(1_000_001)]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(text))
      await expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})
      ).rejects.toThrow()
    }
  })

  it('enforces the call deadline', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}))
      const assertion = expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})
      ).rejects.toThrow(/deadline|timeout|timed out/i)
      await vi.advanceTimersByTimeAsync(25_001)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
