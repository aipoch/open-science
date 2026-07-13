import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { STRUCTURES_TOOLS } from './structures'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => STRUCTURES_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('structures / pdb', () => {
  it('pdb_get_entry builds the URL (uppercased id) and parses title/method/resolution', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        rcsb_id: '1TUP',
        struct: { title: 'TUMOR SUPPRESSOR P53 COMPLEXED WITH DNA' },
        exptl: [{ method: 'X-RAY DIFFRACTION' }],
        rcsb_entry_info: { resolution_combined: [2.2] }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('pdb_get_entry'),
      { pdb_id: '1tup' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe('https://data.rcsb.org/rest/v1/core/entry/1TUP')
    expect(out).toEqual({
      pdb_id: '1TUP',
      title: 'TUMOR SUPPRESSOR P53 COMPLEXED WITH DNA',
      method: 'X-RAY DIFFRACTION',
      resolution: 2.2
    })
  })

  it('pdb_get_entry tolerates a missing resolution', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        rcsb_id: '1ABC',
        struct: { title: 'Some entry' },
        exptl: [{ method: 'SOLUTION NMR' }],
        rcsb_entry_info: { resolution_combined: [] }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('pdb_get_entry'),
      { pdb_id: '1ABC' },
      {}
    )
    expect(out).toEqual({
      pdb_id: '1ABC',
      title: 'Some entry',
      method: 'SOLUTION NMR',
      resolution: undefined
    })
  })
})

describe('structures / alphafold', () => {
  it('alphafold_get builds the URL and parses the first model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes([
        {
          uniprotAccession: 'P04637',
          pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.pdb',
          cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.cif',
          globalMetricValue: 75.06
        }
      ])
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('alphafold_get'),
      { uniprot_accession: 'P04637' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe('https://alphafold.ebi.ac.uk/api/prediction/P04637')
    expect(out).toEqual({
      uniprot: 'P04637',
      model_url: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.pdb',
      cif_url: 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v6.cif',
      mean_plddt: 75.06
    })
  })

  it('alphafold_get tolerates an empty prediction list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('alphafold_get'),
      { uniprot_accession: 'Q99999' },
      {}
    )
    expect(out).toEqual({
      uniprot: undefined,
      model_url: undefined,
      cif_url: undefined,
      mean_plddt: undefined
    })
  })
})

describe('structures / intact', () => {
  it('intact_interactions POSTs query params on the URL (no body) and parses interactions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          totalElements: 4424,
          content: [
            {
              ac: 'EBI-6974073',
              binaryInteractionId: 14904189,
              idA: 'Q00987 (uniprotkb)',
              idB: 'P04637 (uniprotkb)',
              moleculeA: 'MDM2',
              moleculeB: 'TP53',
              type: 'physical association',
              typeMIIdentifier: 'MI:0915',
              detectionMethod: 'anti bait coip',
              detectionMethodMIIdentifier: 'MI:0006',
              intactMiscore: 0.56,
              publicationPubmedIdentifier: '12915590'
            }
          ]
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('intact_interactions'),
      { query: 'TP53' },
      {}
    )
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://www.ebi.ac.uk/intact/ws/interaction/findInteractionWithFacet?query=TP53&minMIScore=0&maxMIScore=1&pageSize=25&page=0'
    )
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect(out).toEqual({
      query: 'TP53',
      total_elements: 4424,
      returned: 1,
      interactions: [
        {
          interactor_a: 'Q00987',
          interactor_b: 'P04637',
          molecule_a: 'MDM2',
          molecule_b: 'TP53',
          interaction_type: 'physical association',
          interaction_type_mi: 'MI:0915',
          detection_method: 'anti bait coip',
          detection_method_mi: 'MI:0006',
          mi_score: 0.56,
          pubmed_id: '12915590'
        }
      ]
    })
  })

  it('intact_interactions respects min_mi_score/limit and tolerates an empty result', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ data: { totalElements: 0, content: [] } }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('intact_interactions'),
      { query: 'BRCA2', min_mi_score: 0.5, limit: 10 },
      {}
    )
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://www.ebi.ac.uk/intact/ws/interaction/findInteractionWithFacet?query=BRCA2&minMIScore=0.5&maxMIScore=1&pageSize=10&page=0'
    )
    expect(out).toEqual({ query: 'BRCA2', total_elements: 0, returned: 0, interactions: [] })
  })
})
