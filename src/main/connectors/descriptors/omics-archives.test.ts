import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { OMICS_ARCHIVES_TOOLS } from './omics-archives'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => OMICS_ARCHIVES_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('omics_archives / arrayexpress_search', () => {
  it('builds the search URL and parses hits to a compact shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        page: 1,
        pageSize: 2,
        totalHits: 15546,
        isTotalHitsExact: true,
        hits: [
          {
            accession: 'E-MTAB-17244',
            type: 'study',
            title: 'Single-nucleus RNA sequencing of human fetal lung from 4 anatomic regions',
            author: 'Xiangning Dong',
            links: 1,
            files: 42,
            release_date: '2026-07-12',
            views: 0,
            isPublic: true
          }
        ]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('arrayexpress_search'),
      { query: 'cancer', pageSize: 2 },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://www.ebi.ac.uk/biostudies/api/v1/arrayexpress/search?query=cancer&pageSize=2&sortBy=release_date&sortOrder=descending'
    )
    expect(out).toEqual([
      {
        accession: 'E-MTAB-17244',
        title: 'Single-nucleus RNA sequencing of human fetal lung from 4 anatomic regions',
        type: 'study',
        release_date: '2026-07-12'
      }
    ])
  })

  it('defaults pageSize when not provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ hits: [] }))
    await new ParserEngine({ fetchImpl }).call(tool('arrayexpress_search'), { query: 'liver' }, {})
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toContain('pageSize=20')
  })

  it('returns an empty array when there are no hits', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ hits: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('arrayexpress_search'),
      { query: 'nope-nothing-here' },
      {}
    )
    expect(out).toEqual([])
  })
})

describe('omics_archives / arrayexpress_get_study', () => {
  it('builds the study URL and parses attributes from top-level + section', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        accno: 'E-MTAB-17244',
        attributes: [
          {
            name: 'Title',
            value: 'Single-nucleus RNA sequencing of human fetal lung from 4 anatomic regions'
          },
          { name: 'ReleaseDate', value: '2026-07-12' },
          { name: 'RootPath', value: 'E-MTAB-17244' }
        ],
        section: {
          accno: 's-E-MTAB-17244',
          type: 'Study',
          attributes: [
            {
              name: 'Title',
              value: 'Single-nucleus RNA sequencing of human fetal lung from 4 anatomic regions'
            },
            { name: 'Study type', value: 'single nucleus RNA sequencing' },
            { name: 'Organism', value: 'Homo sapiens' },
            { name: 'Description', value: 'We performed micro-dissections of developing lungs.' }
          ]
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('arrayexpress_get_study'),
      { accession: 'E-MTAB-17244' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.ebi.ac.uk/biostudies/api/v1/studies/E-MTAB-17244'
    )
    expect(out).toEqual({
      accession: 'E-MTAB-17244',
      title: 'Single-nucleus RNA sequencing of human fetal lung from 4 anatomic regions',
      release_date: '2026-07-12',
      organism: 'Homo sapiens',
      study_type: 'single nucleus RNA sequencing',
      description: 'We performed micro-dissections of developing lungs.'
    })
  })

  it('tolerates a missing section', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        accno: 'E-MTAB-1',
        attributes: [{ name: 'Title', value: 'Old study' }]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('arrayexpress_get_study'),
      { accession: 'E-MTAB-1' },
      {}
    )
    expect(out).toEqual({
      accession: 'E-MTAB-1',
      title: 'Old study',
      release_date: undefined,
      organism: undefined,
      study_type: undefined,
      description: undefined
    })
  })
})
