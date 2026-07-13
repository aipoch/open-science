import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CLINICAL_TRIALS_TOOLS } from './clinical-trials'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CLINICAL_TRIALS_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('clinical_trials / get_study', () => {
  it('parses nct_id, title, status, phase, conditions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        protocolSection: {
          identificationModule: { nctId: 'NCT00000419', briefTitle: 'A Study of Aspirin' },
          statusModule: { overallStatus: 'COMPLETED' },
          designModule: { phases: ['PHASE3'] },
          conditionsModule: { conditions: ['Heart Disease'] }
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('clinicaltrials_get_study'),
      { nct_id: 'NCT00000419' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe('https://clinicaltrials.gov/api/v2/studies/NCT00000419')
    expect(out).toEqual({
      nct_id: 'NCT00000419',
      title: 'A Study of Aspirin',
      status: 'COMPLETED',
      phase: ['PHASE3'],
      conditions: ['Heart Disease']
    })
  })

  it('tolerates missing modules', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ protocolSection: {} }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('clinicaltrials_get_study'),
      { nct_id: 'NCT00000419' },
      {}
    )
    expect(out).toEqual({
      nct_id: undefined,
      title: undefined,
      status: undefined,
      phase: undefined,
      conditions: undefined
    })
  })
})

describe('clinical_trials / search', () => {
  it('builds the query URL and parses a compact study list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT00000001', briefTitle: 'Aspirin Trial' },
              statusModule: { overallStatus: 'RECRUITING' }
            }
          },
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT00000002', briefTitle: 'Aspirin Follow-up' },
              statusModule: { overallStatus: 'COMPLETED' }
            }
          }
        ],
        nextPageToken: 'abc123'
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('clinicaltrials_search'),
      { query: 'aspirin', page_size: 2 },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('https://clinicaltrials.gov/api/v2/studies?query.term=aspirin&pageSize=2')
    expect(out).toEqual({
      studies: [
        { nct_id: 'NCT00000001', title: 'Aspirin Trial', status: 'RECRUITING' },
        { nct_id: 'NCT00000002', title: 'Aspirin Follow-up', status: 'COMPLETED' }
      ],
      nextPageToken: 'abc123'
    })
  })

  it('omits nextPageToken when absent, defaults page_size to 10', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ studies: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('clinicaltrials_search'),
      { query: 'rare disease' },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://clinicaltrials.gov/api/v2/studies?query.term=rare%20disease&pageSize=10'
    )
    expect(out).toEqual({ studies: [] })
  })
})
