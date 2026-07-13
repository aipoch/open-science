import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GEO_TOOLS } from './geo'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('geo', () => {
  it('esearch + esummary, includes etiquette', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ esearchresult: { count: '20657', idlist: ['200272072', '200327658'] } })
      )
      .mockResolvedValueOnce(
        jsonRes({
          result: {
            '200272072': {
              accession: 'GSE272072',
              title: 'Effects of dexamethasone and desisobutyryl ciclesonide on gene expression',
              summary: 'Infants born before 30 weeks gestation are at risk of developing BPD.',
              taxon: 'Rattus norvegicus',
              n_samples: 24,
              gdstype: 'Expression profiling by high throughput sequencing'
            },
            '200327658': {
              accession: 'GSE327658',
              title: 'Persistent transcriptomic changes following repeated exposure to wood smoke',
              summary: 'Exposure to wildfire smoke is a significant public health concern.',
              taxon: 'Macaca mulatta',
              n_samples: 8,
              gdstype: 'Methylation profiling by high throughput sequencing'
            }
          }
        })
      )
    const tool = GEO_TOOLS.find((t) => t.id === 'geo_search')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { term: 'asthma', retmax: 2 },
      { ncbiEmail: 'x@y.org' }
    )) as {
      count: number
      records: unknown[]
    }
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(fetchImpl.mock.calls[0][0]).toContain('db=gds')
    expect(out.count).toBe(20657)
    expect(out.records).toEqual([
      {
        accession: 'GSE272072',
        title: 'Effects of dexamethasone and desisobutyryl ciclesonide on gene expression',
        summary: 'Infants born before 30 weeks gestation are at risk of developing BPD.',
        taxon: 'Rattus norvegicus',
        n_samples: 24,
        gdstype: 'Expression profiling by high throughput sequencing'
      },
      {
        accession: 'GSE327658',
        title: 'Persistent transcriptomic changes following repeated exposure to wood smoke',
        summary: 'Exposure to wildfire smoke is a significant public health concern.',
        taxon: 'Macaca mulatta',
        n_samples: 8,
        gdstype: 'Methylation profiling by high throughput sequencing'
      }
    ])
  })
})
