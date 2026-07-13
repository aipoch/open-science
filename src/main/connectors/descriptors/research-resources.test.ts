import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { RESEARCH_RESOURCES_TOOLS } from './research-resources'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => RESEARCH_RESOURCES_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('research_resources / antibody registry', () => {
  it('antibody_search builds the fts-antibodies URL and parses compact hits', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        totalElements: 2,
        items: [
          {
            abId: 3717446,
            abName: 'Tumor Protein P53 Peptide 2',
            abTarget: 'TP53',
            vendorName: 'DSHB',
            clonality: 'recombinant monoclonal'
          },
          {
            abId: 2877664,
            abName: 'Rabbit monoclonal anti-TP53',
            abTarget: 'TP53',
            vendorName: 'DSHB',
            clonality: 'monoclonal'
          }
        ]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('antibody_search'),
      { query: 'TP53' },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('https://www.antibodyregistry.org/api/fts-antibodies?q=TP53&page=1&size=10')
    expect(out).toEqual({
      total_elements: 2,
      items: [
        {
          ab_id: 'AB_3717446',
          name: 'Tumor Protein P53 Peptide 2',
          vendor: 'DSHB',
          target: 'TP53',
          clonality: 'recombinant monoclonal'
        },
        {
          ab_id: 'AB_2877664',
          name: 'Rabbit monoclonal anti-TP53',
          vendor: 'DSHB',
          target: 'TP53',
          clonality: 'monoclonal'
        }
      ]
    })
  })

  it('antibody_search honors page/size overrides', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ totalElements: 0, items: [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('antibody_search'),
      { query: 'p53', page: 2, size: 25 },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('https://www.antibodyregistry.org/api/fts-antibodies?q=p53&page=2&size=25')
  })

  it('antibody_search returns an empty list when there are no items', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ totalElements: 0 }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('antibody_search'),
      { query: 'nonexistent' },
      {}
    )
    expect(out).toEqual({ total_elements: 0, items: [] })
  })

  it('antibody_get accepts a plain numeric id and parses the list response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes([
        {
          abId: 3717446,
          abName: 'Tumor Protein P53 Peptide 2',
          abTarget: 'TP53',
          vendorName: 'DSHB',
          clonality: 'recombinant monoclonal'
        }
      ])
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('antibody_get'),
      { ab_id: '3717446' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.antibodyregistry.org/api/antibodies/3717446'
    )
    expect(out).toEqual([
      {
        ab_id: 'AB_3717446',
        name: 'Tumor Protein P53 Peptide 2',
        vendor: 'DSHB',
        target: 'TP53',
        clonality: 'recombinant monoclonal'
      }
    ])
  })

  it('antibody_get accepts "AB_<id>" and "RRID:AB_<id>" forms', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    await new ParserEngine({ fetchImpl }).call(tool('antibody_get'), { ab_id: 'AB_3717446' }, {})
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.antibodyregistry.org/api/antibodies/3717446'
    )
    await new ParserEngine({ fetchImpl }).call(
      tool('antibody_get'),
      { ab_id: 'RRID:AB_3717446' },
      {}
    )
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://www.antibodyregistry.org/api/antibodies/3717446'
    )
  })

  it('antibody_get returns an empty array for a nonexistent id (upstream 200 + [])', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    const out = await new ParserEngine({ fetchImpl }).call(tool('antibody_get'), { ab_id: '1' }, {})
    expect(out).toEqual([])
  })

  it('antibody_get rejects a malformed id', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('antibody_get'), { ab_id: 'not-an-id' }, {})
    ).rejects.toThrow(/not a valid antibody id/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
