import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import { CHEMISTRY_TOOLS } from './chemistry'
import { CONNECTOR_CATALOG } from './catalog'

const registry = createConnectorRegistry(CHEMISTRY_TOOLS)
const tool = registry.getDescriptor('chemistry', 'lipidmaps_get_compound')!
const args = { id_type: 'lm_id', identifier: 'LMFA01010001' }
// Representative fields observed from the public REST endpoint; no network in unit tests.
const palmitic = {
  input: 'LMFA01010001',
  lm_id: 'LMFA01010001',
  pubchem_cid: '985',
  name: 'Palmitic acid',
  sys_name: 'hexadecanoic acid',
  core: 'Fatty Acyls [FA]',
  main_class: 'Fatty Acids and Conjugates [FA01]',
  sub_class: 'Straight chain fatty acids [FA0101]',
  exactmass: '256.240231',
  formula: 'C16H32O2',
  inchi_key: 'IPCSVZSSVZVIGE-UHFFFAOYSA-N',
  smiles: 'OC(CCCCCCCCCCCCCCC)=O',
  kegg_id: 'C00249',
  hmdb_id: 'HMDB0000220',
  chebi_id: '15756'
}
async function call(
  body: unknown,
  input = args
): Promise<{ result: unknown; fetchImpl: Mock<typeof fetch> }> {
  registry.validateToolArguments(tool, input)
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body))
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, input, {})
  return { result, fetchImpl }
}

describe('chemistry/lipidmaps_get_compound', () => {
  it('uses the existing Chemistry facade and registers a valid example', () => {
    expect(tool).toBeDefined()
    expect(tool.credentialKeys).toEqual([])
    expect(CONNECTOR_CATALOG.find((c) => c.id === 'chemistry')?.sources).toContain('LIPID MAPS')
    expect(CONNECTOR_CATALOG.some((c) => c.id === 'lipidmaps')).toBe(false)
    expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
  })

  it.each([
    {},
    { ...args, id_type: 'name' },
    { ...args, identifier: 'LMFA' },
    { ...args, identifier: 'LMPR010453' },
    { ...args, identifier: 'LMFA01010001/all' },
    { ...args, identifier: 'LMFA01010001,LMST01010001' },
    { ...args, identifier: 'LMXX01010001' },
    { ...args, identifier: ' LMFA01010001' },
    { ...args, identifier: 'lmfa01010001' },
    { id_type: 'pubchem_cid', identifier: 985 },
    { id_type: 'pubchem_cid', identifier: '0' },
    { id_type: 'pubchem_cid', identifier: '0985' },
    { id_type: 'pubchem_cid', identifier: '-1' },
    { id_type: 'pubchem_cid', identifier: '9.85' },
    { id_type: 'pubchem_cid', identifier: '1e3' },
    { id_type: 'pubchem_cid', identifier: '9999999999999999' },
    { ...args, url: 'https://example.org' }
  ])('rejects invalid or broad input: %j', (input) => {
    expect(() => registry.validateToolArguments(tool, input)).toThrow()
  })

  it('also rejects invalid identifiers before transport when called directly', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool, { ...args, identifier: 'LM' }, {})
    ).rejects.toThrow(/exact LIPID MAPS ID/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([args, { id_type: 'pubchem_cid', identifier: '985' }])(
    'looks up an exact identifier and preserves native chemistry fields: %j',
    async (input) => {
      const { result, fetchImpl } = await call(palmitic, input)
      expect(fetchImpl.mock.calls[0]![0]).toBe(
        `https://www.lipidmaps.org/rest/compound/${input.id_type}/${input.identifier}/all`
      )
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({
        source: 'LIPID MAPS',
        license: 'CC BY 4.0',
        ...input,
        license_url: 'https://www.lipidmaps.org/terms-of-use',
        total_matches: 1,
        records_truncated: false,
        records: [
          {
            lm_id: palmitic.lm_id,
            pubchem_cid: '985',
            name: palmitic.name,
            exactmass: '256.240231',
            formula: palmitic.formula,
            sub_class: palmitic.sub_class,
            inchi_key: palmitic.inchi_key,
            smiles: palmitic.smiles,
            chebi_id: '15756',
            record_url: 'https://www.lipidmaps.org/databases/lmsd/LMFA01010001'
          }
        ]
      })
    }
  )

  it('preserves longer LMIDs and fourth-level classification', async () => {
    const row = {
      ...palmitic,
      lm_id: 'LMPR0104530001',
      pubchem_cid: '42608268',
      name: '(+)-Tormesol',
      class_level4: 'Sphenolobane diterpenoids [PR010453]'
    }
    const { result } = await call(row, { ...args, identifier: row.lm_id })
    expect(result).toMatchObject({
      records: [{ lm_id: row.lm_id, class_level4: row.class_level4 }]
    })
  })

  it('accepts alphanumeric suffixes and generic structure IDs without rewriting them', async () => {
    for (const lm_id of ['LMSP0501AA01', 'LMGP01010000']) {
      const { result } = await call({ ...palmitic, lm_id }, { ...args, identifier: lm_id })
      expect(result).toMatchObject({ records: [{ lm_id }] })
    }
  })

  it('retains null and absent fields without inventing names, classification or mappings', async () => {
    const row = {
      lm_id: 'LMFA12000399',
      sys_name: '14-Methylnonadec-(4E)-en-1-yn-3-one',
      core: 'Fatty Acyls [FA]',
      main_class: 'Oxygenated hydrocarbons [FA12]',
      sub_class: null
    }
    const { result } = await call(row, { ...args, identifier: row.lm_id })
    expect(result).toMatchObject({ records: [{ ...row }] })
    const record = (result as { records: Record<string, unknown>[] }).records[0]!
    expect(record).not.toHaveProperty('name')
    expect(record).not.toHaveProperty('pubchem_cid')
    expect(record).not.toHaveProperty('class_level4')
  })

  it('returns a normal empty result for the observed empty-array envelope', async () => {
    expect((await call([])).result).toMatchObject({
      total_matches: 0,
      records_truncated: false,
      records: []
    })
  })

  it('bounds RowN matches without selecting a single preferred structure', async () => {
    // Synthetic shared-CID matches exercise the multi-record envelope observed in discovery probes.
    const rows = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `Row${i + 1}`,
        { ...palmitic, lm_id: `LMFA0101000${i + 1}` }
      ])
    )
    const { result } = await call(rows, { id_type: 'pubchem_cid', identifier: '985' })
    expect(result).toMatchObject({ total_matches: 6, records_truncated: true })
    expect((result as { records: unknown[] }).records).toHaveLength(5)
  })

  it('validates identities even for records beyond the output cap', async () => {
    const rows = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `Row${i + 1}`,
        { ...palmitic, pubchem_cid: i === 5 ? '5997' : '985' }
      ])
    )
    await expect(call(rows, { id_type: 'pubchem_cid', identifier: '985' })).rejects.toThrow(
      /inconsistent/
    )
  })

  it.each([
    null,
    {},
    'upstream error',
    { error: 'invalid query' },
    [palmitic],
    { Row1: palmitic, error: 'partial response' },
    { Row0: palmitic },
    { Row1: null },
    { ...palmitic, lm_id: 'bad-id' },
    { ...palmitic, core: null },
    { ...palmitic, exactmass: 256.24 },
    { ...palmitic, name: ['Palmitic acid'] },
    { ...palmitic, smiles: 'C'.repeat(2001) }
  ])('rejects malformed envelopes and fields instead of reporting no match', async (body) => {
    await expect(call(body)).rejects.toThrow(
      /LIPID MAPS returned (an invalid response|invalid compound data)/
    )
  })

  it.each([
    [{ ...palmitic, lm_id: 'LMST01010001' }, args],
    [
      { ...palmitic, pubchem_cid: '5997' },
      { id_type: 'pubchem_cid', identifier: '985' }
    ],
    [
      { ...palmitic, pubchem_cid: undefined },
      { id_type: 'pubchem_cid', identifier: '985' }
    ]
  ])('rejects mismatched identities', async (body, input) => {
    await expect(call(body, input)).rejects.toThrow(/inconsistent/)
  })

  it('does not expose arbitrary upstream fields or unbounded synonym lists', async () => {
    const { result } = await call({ ...palmitic, synonyms: 'extra', unexpected: { secret: true } })
    expect((result as { records: unknown[] }).records[0]).not.toHaveProperty('synonyms')
    expect((result as { records: unknown[] }).records[0]).not.toHaveProperty('unexpected')
  })

  it.each([404, 429, 500])('propagates HTTP %i instead of calling it no match', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('error', { status }))
    await expect(new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})).rejects.toThrow()
  })

  it('rejects invalid JSON and excessive response bytes through the real engine', async () => {
    for (const text of ['<html>unavailable</html>', ' '.repeat(100_001)]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(text))
      await expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})
      ).rejects.toThrow()
    }
  })

  it('enforces the whole-call deadline', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}))
      const promise = new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})
      const rejected = expect(promise).rejects.toThrow(/deadline|timeout|timed out/i)
      await vi.advanceTimersByTimeAsync(25_001)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
