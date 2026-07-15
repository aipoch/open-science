import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { STRUCTURES_INTACT_TOOLS } from './structures-intact'
import type { ToolDescriptor } from '../types'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

const tool = (id: string): ToolDescriptor => {
  const t = STRUCTURES_INTACT_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }).call(
    tool(id),
    args,
    {}
  )

// A raw IntAct search record (as the wire returns it — participant ids carry the ' (db)' suffix).
const rawRecord = (
  ac: string,
  bid: number,
  idA: string,
  idB: string,
  score: number | null,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  ac,
  binaryInteractionId: bid,
  acA: `EBI-A-${ac}`,
  acB: `EBI-B-${ac}`,
  idA: `${idA} (uniprotkb)`,
  idB: `${idB} (uniprotkb)`,
  moleculeA: idA,
  moleculeB: idB,
  speciesA: 'Homo sapiens',
  speciesB: 'Homo sapiens',
  taxIdA: 9606,
  taxIdB: 9606,
  type: 'physical association',
  typeMIIdentifier: 'MI:0915',
  detectionMethod: 'pull down',
  detectionMethodMIIdentifier: 'MI:0096',
  intactMiscore: score,
  publicationPubmedIdentifier: '12345678',
  firstAuthor: 'Doe et al.',
  sourceDatabase: 'intact',
  ...extra
})

const searchPage = (
  totalElements: number,
  content: Array<Record<string, unknown>>,
  last: boolean
): Response => jsonRes({ data: { totalElements, content, last } })

describe('intact_fetch_interactions', () => {
  it('runs a complete count-verified sweep, applies filters, sorts by descending MI, reports truth', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('page=1')) {
        // Second (final) page carries the last record; totalElements stays 3.
        return Promise.resolve(searchPage(3, [rawRecord('EBI-3', 3, 'P04637', 'Q3', null)], true))
      }
      // First page: two records, more to come.
      return Promise.resolve(
        searchPage(
          3,
          [rawRecord('EBI-1', 1, 'P04637', 'Q1', 0.4), rawRecord('EBI-2', 2, 'P04637', 'Q2', 0.9)],
          false
        )
      )
    })
    const out = (await run(
      'intact_fetch_interactions',
      {
        query: 'P04637',
        min_mi_score: 0.45,
        max_mi_score: 0.99,
        interactor_species: ['Homo sapiens'],
        max_records_returned: 500
      },
      fetchImpl
    )) as {
      query: string
      min_mi_score: number
      max_mi_score: number
      total_elements: number
      n_records: number
      records_truncated: boolean
      n_records_returned: number
      records: Array<Record<string, unknown>>
    }

    // Two pages requested; params ride on the URL of a POST with no body.
    const [url0, init0] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(init0.method).toBe('POST')
    expect(init0.body).toBeUndefined()
    expect(url0).toContain('query=P04637')
    expect(url0).toContain('minMIScore=0.45')
    expect(url0).toContain('maxMIScore=0.99')
    expect(url0).toContain('pageSize=500')
    expect(url0).toContain('interactorSpeciesFilter=Homo+sapiens')
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // Count-verified: n_records == total_elements, nothing truncated.
    expect(out.total_elements).toBe(3)
    expect(out.n_records).toBe(3)
    expect(out.records_truncated).toBe(false)
    expect(out.n_records_returned).toBe(3)
    // Descending MI score, null score sorts last.
    expect(out.records.map((r) => r.mi_score)).toEqual([0.9, 0.4, null])
    // Participant ids are stripped of their ' (db)' suffix, database captured separately.
    expect(out.records[0].id_a).toBe('P04637')
    expect(out.records[0].id_b).toBe('Q2')
    expect(out.records[0].id_a_database).toBe('uniprotkb')
  })

  it('caps records at max_records_returned but reports the true total (records_truncated)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        searchPage(
          2,
          [rawRecord('EBI-1', 1, 'P04637', 'Q1', 0.8), rawRecord('EBI-2', 2, 'P04637', 'Q2', 0.7)],
          true
        )
      )
    const out = (await run(
      'intact_fetch_interactions',
      { query: 'P04637', max_records_returned: 1 },
      fetchImpl
    )) as {
      total_elements: number
      n_records: number
      records_truncated: boolean
      n_records_returned: number
      records: unknown[]
    }
    expect(out.total_elements).toBe(2)
    expect(out.n_records).toBe(2)
    expect(out.records_truncated).toBe(true)
    expect(out.n_records_returned).toBe(1)
    expect(out.records).toHaveLength(1)
  })

  it('fails loudly when the collected count disagrees with totalElements', async () => {
    // Server claims 5 but only hands back 1 record on a last page — silent truncation must throw.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(searchPage(5, [rawRecord('EBI-1', 1, 'P04637', 'Q1', 0.8)], true))
    await expect(run('intact_fetch_interactions', { query: 'P04637' }, fetchImpl)).rejects.toThrow(
      /collected 1 records but server reported totalElements=5/
    )
  })

  it('returns an empty record set without throwing when nothing matches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(searchPage(0, [], true))
    const out = (await run('intact_fetch_interactions', { query: 'ZZZ' }, fetchImpl)) as {
      total_elements: number
      n_records: number
      records: unknown[]
      records_truncated: boolean
    }
    expect(out).toMatchObject({ total_elements: 0, n_records: 0, records_truncated: false })
    expect(out.records).toEqual([])
  })
})

describe('intact_get_interactor', () => {
  const interactorRaw = (ac: string, count: number): Record<string, unknown> => ({
    interactorAc: ac,
    interactorPreferredIdentifier: 'P04637 (uniprotkb)',
    interactorName: 'TP53',
    interactorSpecies: 'Homo sapiens',
    interactorTaxId: 9606,
    interactorType: 'protein',
    interactionCount: count
  })

  it('returns ALL matches (paginated), sorted by ac, with n_matches and interaction_count', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('page=1')) {
        return Promise.resolve(
          jsonRes({ content: [interactorRaw('EBI-100', 5)], last: true, totalElements: 3 })
        )
      }
      return Promise.resolve(
        jsonRes({
          content: [interactorRaw('EBI-366083', 1757), interactorRaw('EBI-200', 2)],
          last: false,
          totalElements: 3
        })
      )
    })
    const out = (await run('intact_get_interactor', { query: 'P04637' }, fetchImpl)) as {
      query: string
      n_matches: number
      interactors: Array<Record<string, unknown>>
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.n_matches).toBe(3)
    // Sorted by interactor_ac ascending.
    expect(out.interactors.map((i) => i.interactor_ac)).toEqual([
      'EBI-100',
      'EBI-200',
      'EBI-366083'
    ])
    expect(out.interactors[2]).toEqual({
      interactor_ac: 'EBI-366083',
      preferred_identifier: 'P04637',
      name: 'TP53',
      species: 'Homo sapiens',
      taxid: 9606,
      interactor_type: 'protein',
      interaction_count: 1757
    })
  })

  it('returns n_matches 0 and empty interactors when nothing resolves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ content: [], last: true }))
    const out = (await run('intact_get_interactor', { query: 'nope' }, fetchImpl)) as {
      n_matches: number
      interactors: unknown[]
    }
    expect(out.n_matches).toBe(0)
    expect(out.interactors).toEqual([])
  })
})

describe('intact_get_interaction_details', () => {
  const detailRaw = {
    interactionAc: 'EBI-15635490',
    shortLabel: 'ins-1',
    type: { shortName: 'direct interaction', identifier: 'MI:0407' },
    detectionMethod: { shortName: 'x-ray crystallography', identifier: 'MI:0114' },
    hostOrganism: { scientificName: 'Homo sapiens', taxId: 9606 },
    negative: false,
    publication: {
      pubmedId: '10490823',
      title: 'Insulin structure',
      journal: 'J. Mol. Biol.',
      publicationDate: '1999-01-01',
      authors: ['Smith J.']
    },
    xrefs: [
      {
        database: { shortName: 'imex', identifier: 'MI:0670' },
        identifier: 'IM-1',
        qualifier: null
      },
      {
        database: { shortName: 'complex portal', identifier: 'MI:2279' },
        identifier: 'CPX-1',
        qualifier: null
      }
    ],
    annotations: [{ topic: { shortName: 'comment', identifier: 'MI:0612' }, description: 'note' }],
    parameters: [],
    confidences: []
  }

  const participantRaw = (ac: string, id: string): Record<string, unknown> => ({
    participantAc: ac,
    shortLabel: `${id}_human`,
    participantId: { identifier: id, database: { shortName: 'uniprotkb', identifier: 'MI:0486' } },
    description: 'Insulin',
    type: { shortName: 'protein', identifier: 'MI:0326' },
    species: { scientificName: 'Homo sapiens', taxId: 9606 },
    biologicalRole: { shortName: 'unspecified role', identifier: 'MI:0499' },
    experimentalRole: { shortName: 'bait', identifier: 'MI:0496' },
    detectionMethod: [{ shortName: 'predetermined', identifier: 'MI:0396' }]
  })

  it('parses full detail by AC and includes sorted participants when requested', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/graph/interaction/details/'))
        return Promise.resolve(textRes(JSON.stringify(detailRaw)))
      // participants route
      return Promise.resolve(
        jsonRes({
          content: [participantRaw('EBI-2', 'P01308'), participantRaw('EBI-1', 'P01344')],
          last: true,
          totalElements: 2
        })
      )
    })
    const out = (await run(
      'intact_get_interaction_details',
      { interaction_ac: 'EBI-15635490', include_participants: true },
      fetchImpl
    )) as Record<string, unknown>

    expect(out.interaction_ac).toBe('EBI-15635490')
    expect(out.type).toEqual({ name: 'direct interaction', mi: 'MI:0407' })
    expect(out.detection_method).toEqual({ name: 'x-ray crystallography', mi: 'MI:0114' })
    expect(out.publication).toEqual({
      pubmed_id: '10490823',
      title: 'Insulin structure',
      journal: 'J. Mol. Biol.',
      publication_date: '1999-01-01',
      authors: ['Smith J.']
    })
    // xrefs sorted by database name: 'complex portal' before 'imex'.
    expect((out.xrefs as Array<Record<string, unknown>>).map((x) => x.database)).toEqual([
      'complex portal',
      'imex'
    ])
    expect(out.annotations).toEqual([
      { topic: 'comment', topic_mi: 'MI:0612', description: 'note' }
    ])
    const participants = out.participants as Array<Record<string, unknown>>
    expect(out.n_participants).toBe(2)
    // Participants sorted by participant_ac.
    expect(participants.map((p) => p.participant_ac)).toEqual(['EBI-1', 'EBI-2'])
    expect(participants[1]).toEqual({
      participant_ac: 'EBI-2',
      short_label: 'P01308_human',
      identifier: 'P01308',
      identifier_database: 'uniprotkb',
      description: 'Insulin',
      type: { name: 'protein', mi: 'MI:0326' },
      species: 'Homo sapiens',
      taxid: 9606,
      biological_role: { name: 'unspecified role', mi: 'MI:0499' },
      experimental_role: { name: 'bait', mi: 'MI:0496' },
      detection_methods: [{ name: 'predetermined', mi: 'MI:0396' }]
    })
  })

  it('omits participants (no participants request) when include_participants=false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes(JSON.stringify(detailRaw)))
    const out = (await run(
      'intact_get_interaction_details',
      { interaction_ac: 'EBI-15635490', include_participants: false },
      fetchImpl
    )) as Record<string, unknown>
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(out).not.toHaveProperty('participants')
    expect(out).not.toHaveProperty('n_participants')
  })

  it('maps an unknown AC (empty 200 body) to a not_found record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes(''))
    const out = (await run(
      'intact_get_interaction_details',
      { interaction_ac: 'EBI-NOPE' },
      fetchImpl
    )) as Record<string, unknown>
    expect(out).toEqual({ interaction_ac: 'EBI-NOPE', error: 'not_found' })
  })
})

describe('intact_build_network', () => {
  it('sweeps seeds, expands partners depth-1, and reports the expansion cap', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('query=P04637')) {
        // Seed sweep: two seed edges -> partners Q00987 and Q13.
        return Promise.resolve(
          searchPage(
            2,
            [
              rawRecord('EBI-e1', 1, 'P04637', 'Q00987', 0.9),
              rawRecord('EBI-e2', 2, 'P04637', 'Q13', 0.6)
            ],
            true
          )
        )
      }
      if (url.includes('query=Q00987')) {
        // Partner expansion: an in-network edge (both endpoints are nodes) + an out-of-network edge.
        return Promise.resolve(
          searchPage(
            2,
            [
              rawRecord('EBI-e3', 3, 'Q00987', 'Q13', 0.7),
              rawRecord('EBI-e4', 4, 'Q00987', 'X999', 0.8)
            ],
            true
          )
        )
      }
      // Q13 would be the un-expanded partner; must never be queried under the cap.
      throw new Error(`unexpected query url: ${url}`)
    })
    const out = (await run(
      'intact_build_network',
      { seed_accessions: ['P04637'], min_mi_score: 0.45, max_interactors_expanded: 1 },
      fetchImpl
    )) as {
      seeds: string[]
      n_nodes: number
      nodes: string[]
      n_edges: number
      edges: Array<Record<string, unknown>>
      seed_sweeps: Record<string, unknown>
      expansion: {
        max_interactors_expanded: number
        n_partners: number
        expanded: string[]
        not_expanded: string[]
        complete: boolean
      }
    }

    // Node set = seed + both partners.
    expect(out.nodes).toEqual(['P04637', 'Q00987', 'Q13'])
    expect(out.n_nodes).toBe(3)
    // Edges: two seed edges + the one in-network partner-partner edge (X999 edge dropped).
    expect(out.n_edges).toBe(3)
    const edgeIds = out.edges.map((e) => e.interaction_ac)
    expect(edgeIds).toContain('EBI-e3')
    expect(edgeIds).not.toContain('EBI-e4')
    // Edge origin bookkeeping.
    const e3 = out.edges.find((e) => e.interaction_ac === 'EBI-e3')!
    expect(e3.origin).toBe('partner_expansion')
    // Only the most-connected partner within the cap was expanded; Q13 was not -> complete=false.
    expect(out.expansion.expanded).toEqual(['Q00987'])
    expect(out.expansion.not_expanded).toEqual(['Q13'])
    expect(out.expansion.n_partners).toBe(2)
    expect(out.expansion.complete).toBe(false)
    expect(out.seed_sweeps).toHaveProperty('P04637')
  })

  it('reports expansion.complete=true when every partner fits under the cap', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('query=P04637')) {
        return Promise.resolve(
          searchPage(1, [rawRecord('EBI-e1', 1, 'P04637', 'Q00987', 0.9)], true)
        )
      }
      // Single partner expansion, no in-network partner-partner edges.
      return Promise.resolve(searchPage(0, [], true))
    })
    const out = (await run(
      'intact_build_network',
      { seed_accessions: ['P04637'], max_interactors_expanded: 25 },
      fetchImpl
    )) as { expansion: { complete: boolean; expanded: string[]; not_expanded: string[] } }
    expect(out.expansion.expanded).toEqual(['Q00987'])
    expect(out.expansion.not_expanded).toEqual([])
    expect(out.expansion.complete).toBe(true)
  })
})
