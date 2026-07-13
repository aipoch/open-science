import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { REGULATION_TOOLS } from './regulation'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => REGULATION_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('regulation / encode', () => {
  it('encode_search builds the search URL and parses @graph rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        '@graph': [
          {
            accession: 'ENCSR613LSQ',
            assay_title: 'CRISPR RNA-seq',
            biosample_ontology: { term_name: 'K562' },
            target: { label: 'CTCF' },
            status: 'released'
          },
          {
            accession: 'ENCSR356GHP',
            assay_title: 'ChIA-PET',
            biosample_ontology: { term_name: 'HCT116' },
            target: { label: 'CTCF' },
            status: 'released'
          }
        ]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('encode_search'),
      { query: 'CTCF' },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://www.encodeproject.org/search/?searchTerm=CTCF&type=Experiment&format=json&limit=25'
    )
    expect(out).toEqual([
      {
        accession: 'ENCSR613LSQ',
        assay_title: 'CRISPR RNA-seq',
        biosample: 'K562',
        target: 'CTCF',
        status: 'released'
      },
      {
        accession: 'ENCSR356GHP',
        assay_title: 'ChIA-PET',
        biosample: 'HCT116',
        target: 'CTCF',
        status: 'released'
      }
    ])
  })

  it('encode_search honors a custom limit and encodes the query', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ '@graph': [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('encode_search'),
      { query: 'H3K27ac ChIP', limit: 5 },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://www.encodeproject.org/search/?searchTerm=H3K27ac%20ChIP&type=Experiment&format=json&limit=5'
    )
  })

  it('encode_search returns an empty array when @graph is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({}))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('encode_search'),
      { query: 'nothing' },
      {}
    )
    expect(out).toEqual([])
  })

  it('encode_get_experiment builds the accession URL and parses a compact record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        accession: 'ENCSR613LSQ',
        status: 'released',
        assay_title: 'CRISPR RNA-seq',
        assay_term_name: 'CRISPR genome editing followed by RNA-seq',
        biosample_ontology: { term_name: 'K562' },
        target: { label: 'CTCF' },
        description: 'RNA-seq on K562 cells treated with a CRISPR gRNA against CTCF.',
        lab: { title: 'Brenton Graveley, UConn' },
        date_released: '2020-11-30'
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('encode_get_experiment'),
      { accession: 'ENCSR613LSQ' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.encodeproject.org/experiments/ENCSR613LSQ/?format=json'
    )
    expect(out).toEqual({
      accession: 'ENCSR613LSQ',
      status: 'released',
      assay_title: 'CRISPR RNA-seq',
      assay_term_name: 'CRISPR genome editing followed by RNA-seq',
      biosample: 'K562',
      target: 'CTCF',
      description: 'RNA-seq on K562 cells treated with a CRISPR gRNA against CTCF.',
      lab: 'Brenton Graveley, UConn',
      date_released: '2020-11-30'
    })
  })

  it('encode_get_experiment tolerates a bare @id string for target/lab', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        accession: 'ENCSR000AKP',
        status: 'released',
        target: '/targets/no-target/',
        lab: '/labs/some-lab/'
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('encode_get_experiment'),
      { accession: 'ENCSR000AKP' },
      {}
    )
    expect(out).toMatchObject({
      target: '/targets/no-target/',
      lab: '/labs/some-lab/'
    })
  })
})
