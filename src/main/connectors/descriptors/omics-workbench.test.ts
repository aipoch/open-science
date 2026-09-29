import { describe, expect, it, vi, type Mock } from 'vitest'
import { ParserEngine } from '../engine'
import { WORKBENCH_OMICS_TOOLS } from './omics-workbench'

const BASE = 'https://www.metabolomicsworkbench.org/rest'
const study = {
  study_id: 'ST000001',
  study_title: 'Fatb Induction Experiment',
  species: 'Arabidopsis thaliana'
}
const compound = { regno: '11', name: 'Dideoxymycobactin', smiles: 'CC', pubchem_cid: '136029221' }
// Representative rows from compound/formula/C6H12O6/all; values remain upstream strings.
const formulaRows = {
  Row1: {
    formula: 'C6H12O6',
    regno: '38325',
    exactmass: '180.063388',
    inchi_key: 'BJHIKXHVCXFQLS-PQLUHFTBSA-N',
    name: 'D-Tagatose',
    pubchem_cid: '92092',
    hmdb_id: 'HMDB0003418',
    kegg_id: 'C00795',
    chebi_id: '47693',
    smiles: 'C([C@H]([C@@H]([C@@H](C(=O)CO)O)O)O)O'
  },
  Row2: {
    formula: 'C6H12O6',
    regno: '37084',
    exactmass: '180.063390',
    inchi_key: 'WQZGKKKJIJFFOK-GASJEMHNSA-N',
    name: 'D-Glucose',
    pubchem_cid: '5793',
    hmdb_id: 'HMDB0304632',
    kegg_id: 'C00031',
    chebi_id: '4167',
    smiles: 'C([C@@H]1[C@H]([C@@H]([C@H](C(O)O1)O)O)O)O'
  }
}

function setup(
  payload: unknown,
  status = 200
): {
  call: (id: string, args: Record<string, unknown>) => Promise<unknown>
  fetchImpl: Mock<typeof fetch>
} {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(payload), { status })
  )
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  const call = async (id: string, args: Record<string, unknown>): Promise<unknown> => {
    const descriptor = WORKBENCH_OMICS_TOOLS.find((tool) => tool.id === id)!
    return engine.call(descriptor, args, {})
  }
  return { call, fetchImpl }
}

describe('Metabolomics Workbench', () => {
  it.each([
    ['regno', '37084'],
    ['inchi_key', 'WQZGKKKJIJFFOK-GASJEMHNSA-N'],
    ['pubchem_cid', '5793'],
    ['hmdb_id', 'HMDB0304632'],
    ['kegg_id', 'C00031'],
    ['chebi_id', '4167']
  ])(
    'maps compound field %s and preserves structures and cross-references',
    async (field, query) => {
      const row = formulaRows.Row2
      const { call, fetchImpl } = setup(row)
      expect(await call('workbench_search_compounds', { field, query })).toMatchObject({
        records: [row],
        returned: 1,
        total_received: 1,
        truncated: false
      })
      expect(String(fetchImpl.mock.calls[0][0])).toBe(`${BASE}/compound/${field}/${query}/all`)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ['lm_id', 'LMFA03010001', '2371', '6-keto-PGF1alpha'],
    ['metacyc_id', 'CPD-7836', '36', 'Myristic acid']
  ])('maps the %s cross-reference to its Workbench record', async (field, query, regno, name) => {
    const row = { regno, name, [field]: query }
    const { call, fetchImpl } = setup(row)
    expect(await call('workbench_search_compounds', { field, query })).toMatchObject({
      records: [row]
    })
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${BASE}/compound/${field}/${query}/all`)
  })

  it('normalizes real Row-prefixed compound results without losing structures or cross-references', async () => {
    const { call, fetchImpl } = setup(formulaRows)
    expect(
      await call('workbench_search_compounds', { field: 'formula', query: 'C6H12O6' })
    ).toEqual({
      source: 'Metabolomics Workbench',
      source_url: `${BASE}/compound/formula/C6H12O6/all`,
      records: [formulaRows.Row1, formulaRows.Row2],
      returned: 2,
      total_received: 2,
      truncated: false
    })
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${BASE}/compound/formula/C6H12O6/all`)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('caps Row-prefixed compounds locally while retaining the received count', async () => {
    const { call } = setup(formulaRows)
    expect(
      await call('workbench_search_compounds', { field: 'formula', query: 'C6H12O6', limit: 1 })
    ).toMatchObject({
      records: [formulaRows.Row1],
      returned: 1,
      total_received: 2,
      truncated: true
    })
  })

  it.each([null, { name: 'missing regno' }, { regno: 37084 }, { regno: '' }])(
    'rejects a malformed compound even beyond the output limit: %j',
    async (invalidRow) => {
      const { call } = setup({ Row1: formulaRows.Row1, Row2: invalidRow })
      await expect(
        call('workbench_search_compounds', {
          field: 'formula',
          query: 'C6H12O6',
          limit: 1
        })
      ).rejects.toThrow(/malformed record/)
    }
  )

  it.each([
    { Row1: compound, error: 'upstream failure' },
    { unexpected: compound },
    { Row0: compound },
    { RowX: compound }
  ])('rejects unrecognized compound envelopes: %j', async (payload) => {
    const { call } = setup(payload)
    await expect(
      call('workbench_search_compounds', {
        field: 'formula',
        query: 'C6H12O6'
      })
    ).rejects.toThrow(/unexpected response/)
  })

  it('keeps Row-prefixed envelopes restricted to compound responses', async () => {
    const { call } = setup({ Row1: study })
    await expect(call('workbench_get_study', { study_id: 'ST000001' })).rejects.toThrow(
      /unexpected response/
    )
  })

  it('preserves upstream study links and documents how to trace and retrieve studies', async () => {
    const row = {
      ...study,
      study_url: 'https://www.metabolomicsworkbench.org/data/DRCCMetadata.php?StudyID=FATB'
    }
    const { call } = setup(row)
    expect(await call('workbench_search_studies', { query: 'Fatb' })).toMatchObject({
      records: [row],
      source_url: `${BASE}/study/study_title/Fatb/summary`
    })
    for (const id of ['workbench_search_studies', 'workbench_get_study']) {
      expect(WORKBENCH_OMICS_TOOLS.find((tool) => tool.id === id)!.returns).toContain(
        'preserved without correction'
      )
      expect(WORKBENCH_OMICS_TOOLS.find((tool) => tool.id === id)!.returns).toContain(
        'study_id with workbench_get_study'
      )
    }
  })

  it.each(['study_title', 'institute'])(
    'maps study search field %s and encodes query text',
    async (field) => {
      const { call, fetchImpl } = setup([study])
      await call('workbench_search_studies', { field, query: '  A & B?#  ' })
      expect(String(fetchImpl.mock.calls[0][0])).toBe(
        `${BASE}/study/${field}/A%20%26%20B%3F%23/summary`
      )
    }
  )

  it('rejects unsupported author searches before HTTP instead of reporting false empty results', async () => {
    const { call, fetchImpl } = setup([])
    await expect(
      call('workbench_search_studies', { field: 'last_name', query: 'Kind' })
    ).rejects.toThrow(/field must be one of/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('defaults to study title search and normalizes singleton responses', async () => {
    const { call, fetchImpl } = setup(study)
    expect(await call('workbench_search_studies', { query: 'Fatb' })).toMatchObject({
      records: [study]
    })
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${BASE}/study/study_title/Fatb/summary`)
  })

  it.each(['summary', 'factors', 'analysis', 'metabolites'])(
    'fetches %s without the broken /json suffix',
    async (section) => {
      const row = {
        ...study,
        local_sample_id: 'LabF_115904',
        factors: 'Treatment:Control | Genotype:fatb-ko',
        analysis_id: 'AN000001',
        refmet_name: 'Glucose'
      }
      const { call, fetchImpl } = setup({ '1': row })
      expect(await call('workbench_get_study', { study_id: 'ST000001', section })).toMatchObject({
        study_id: 'ST000001',
        section,
        records: [row]
      })
      expect(String(fetchImpl.mock.calls[0][0])).toBe(`${BASE}/study/study_id/ST000001/${section}`)
    }
  )

  it('caps numbered records locally and reports truncation without claiming a database total', async () => {
    const second = { ...study, study_id: 'ST000002' }
    const { call, fetchImpl } = setup({ '1': study, '2': second })
    expect(await call('workbench_search_studies', { query: 'Fatb', limit: 1 })).toMatchObject({
      records: [study],
      returned: 1,
      total_received: 2,
      truncated: true
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([[], {}])('preserves empty results: %j', async (payload) => {
    const { call } = setup(payload)
    expect(await call('workbench_get_study', { study_id: 'ST999999' })).toMatchObject({
      section: 'summary',
      records: [],
      returned: 0,
      total_received: 0,
      truncated: false
    })
  })

  it.each([
    null,
    'No records found',
    { error: 'unavailable' },
    { '1': null },
    { '1': { name: 'missing ID' } },
    [study, null],
    { study_id: 1 }
  ])('rejects unexpected payloads rather than returning an empty success: %j', async (payload) => {
    const { call } = setup(payload)
    await expect(call('workbench_get_study', { study_id: 'ST000001' })).rejects.toThrow(/Workbench/)
  })

  it('rejects non-JSON upstream content', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('study_id\tST000001'))
    const engine = new ParserEngine({ fetchImpl, retries: 0 })
    await expect(
      engine.call(
        WORKBENCH_OMICS_TOOLS.find((tool) => tool.id === 'workbench_get_study')!,
        {
          study_id: 'ST000001'
        },
        {}
      )
    ).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('enforces the response byte budget through the shared engine', async () => {
    const { call } = setup({ ...study, notes: 'x'.repeat(5 * 1024 * 1024) })
    await expect(call('workbench_get_study', { study_id: 'ST000001' })).rejects.toThrow(
      /response exceeded/i
    )
  })

  it.each([400, 404, 429, 500])('propagates upstream HTTP %s errors', async (status) => {
    const { call } = setup({ error: 'upstream failure' }, status)
    await expect(call('workbench_get_study', { study_id: 'ST000001' })).rejects.toThrow(
      `HTTP ${status}`
    )
  })

  it.each([
    ['workbench_search_studies', { query: '   ' }],
    ['workbench_search_studies', { query: '..' }],
    ['workbench_search_studies', { query: 'foo/bar' }],
    ['workbench_search_studies', { query: 'x\ny' }]
  ])('rejects invalid %s inputs before HTTP: %j', async (id, args) => {
    const { call, fetchImpl } = setup([])
    await expect(call(id as string, args as Record<string, unknown>)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
