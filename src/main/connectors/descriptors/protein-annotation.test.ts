import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { PROTEIN_ANNOTATION_TOOLS } from './protein-annotation'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => PROTEIN_ANNOTATION_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('protein_annotation / string-db', () => {
  it('string_interaction_partners builds the URL and parses partners + scores', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes([
        {
          stringId_A: '9606.ENSP00000269305',
          stringId_B: '9606.ENSP00000340989',
          preferredName_A: 'TP53',
          preferredName_B: 'SFN',
          ncbiTaxonId: 9606,
          score: 0.999
        },
        {
          stringId_A: '9606.ENSP00000269305',
          stringId_B: '9606.ENSP00000263253',
          preferredName_A: 'TP53',
          preferredName_B: 'EP300',
          ncbiTaxonId: 9606,
          score: 0.999
        }
      ])
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('string_interaction_partners'),
      { gene: 'TP53', limit: 2 },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://string-db.org/api/json/interaction_partners?identifiers=TP53&species=9606&limit=2'
    )
    expect(out).toEqual([
      { partner: 'SFN', score: 0.999 },
      { partner: 'EP300', score: 0.999 }
    ])
  })

  it('string_interaction_partners defaults limit to 10 when omitted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    await new ParserEngine({ fetchImpl }).call(
      tool('string_interaction_partners'),
      { gene: 'TP53' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://string-db.org/api/json/interaction_partners?identifiers=TP53&species=9606&limit=10'
    )
  })

  it('string_network builds the URL and parses edges', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes([
        {
          stringId_A: '9606.ENSP00000258149',
          stringId_B: '9606.ENSP00000269305',
          preferredName_A: 'MDM2',
          preferredName_B: 'TP53',
          ncbiTaxonId: '9606',
          score: 0.999
        }
      ])
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('string_network'),
      { genes: ['TP53', 'MDM2'] },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://string-db.org/api/json/network?identifiers=TP53%2CMDM2&species=9606'
    )
    expect(out).toEqual([{ a: 'MDM2', b: 'TP53', score: 0.999 }])
  })
})
