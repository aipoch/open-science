import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { DRUG_REGULATORY_TOOLS } from './drug-regulatory'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => DRUG_REGULATORY_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('drug_regulatory / openfda label', () => {
  it('openfda_search_drug_label builds the search URL and parses compact fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        results: [
          {
            id: '22d94fd9-9488-a812-e063-6394a90a7ffc',
            set_id: '015a6179-bacb-452d-b594-4de628ddc11d',
            openfda: {
              brand_name: ['TYLENOL Extra Strength'],
              generic_name: ['ACETAMINOPHEN'],
              manufacturer_name: ['Kenvue Brands LLC']
            },
            indications_and_usage: ['Uses temporarily relieves minor aches and pains.']
          }
        ]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('openfda_search_drug_label'),
      { query: 'openfda.brand_name:"Tylenol"', limit: 5 },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://api.fda.gov/drug/label.json?search=openfda.brand_name%3A%22Tylenol%22&limit=5'
    )
    expect(out).toEqual([
      {
        id: '22d94fd9-9488-a812-e063-6394a90a7ffc',
        brand_name: 'TYLENOL Extra Strength',
        generic_name: 'ACETAMINOPHEN',
        manufacturer: 'Kenvue Brands LLC',
        indications: 'Uses temporarily relieves minor aches and pains.'
      }
    ])
  })

  it('openfda_search_drug_label defaults limit to 10 and tolerates missing results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({}))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('openfda_search_drug_label'),
      { query: 'aspirin' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.fda.gov/drug/label.json?search=aspirin&limit=10'
    )
    expect(out).toEqual([])
  })

  it('openfda_search_drug_label tolerates a result with no openfda block', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        results: [{ id: 'abc', indications_and_usage: undefined }]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('openfda_search_drug_label'),
      { query: 'abc' },
      {}
    )
    expect(out).toEqual([
      {
        id: 'abc',
        brand_name: undefined,
        generic_name: undefined,
        manufacturer: undefined,
        indications: undefined
      }
    ])
  })
})

describe('drug_regulatory / openfda adverse events', () => {
  it('openfda_search_adverse_events builds the search URL and parses compact fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        results: [
          {
            safetyreportid: '10003304',
            receivedate: '20140312',
            serious: '1',
            patient: {
              reaction: [
                { reactionmeddrapt: 'Drug hypersensitivity' },
                { reactionmeddrapt: 'Nausea' }
              ]
            }
          }
        ]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('openfda_search_adverse_events'),
      { query: 'patient.drug.medicinalproduct:"ASPIRIN"', limit: 3 },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://api.fda.gov/drug/event.json?search=patient.drug.medicinalproduct%3A%22ASPIRIN%22&limit=3'
    )
    expect(out).toEqual([
      {
        safety_report_id: '10003304',
        receive_date: '20140312',
        serious: true,
        reactions: ['Drug hypersensitivity', 'Nausea']
      }
    ])
  })

  it('openfda_search_adverse_events returns an empty array when there are no results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ results: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('openfda_search_adverse_events'),
      { query: 'NOPE' },
      {}
    )
    expect(out).toEqual([])
  })
})
