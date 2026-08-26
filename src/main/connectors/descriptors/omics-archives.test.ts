import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { OMICS_ARCHIVES_TOOLS } from './omics-archives'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => OMICS_ARCHIVES_TOOLS.find((t) => t.id === id)!

// Response mocks. `headers` is only consulted by fetchJsonWithHeaders (PRIDE search total_records).
const jsonRes = (body: unknown, headers: Record<string, string> = {}): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null }
  }) as unknown as Response
const textRes = (body: string): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => body,
    headers: { get: () => null }
  }) as unknown as Response
const errRes = (status: number): Response =>
  ({ ok: false, status, headers: { get: () => null } }) as unknown as Response

const engine = (fetchImpl: typeof fetch): ParserEngine =>
  new ParserEngine({ fetchImpl, retries: 0 })

const sdrfFetch = (text: string, path: string, size?: number): typeof fetch =>
  vi.fn().mockImplementation(async (url: string) =>
    url.includes('/biostudies/files/')
      ? textRes(text)
      : jsonRes({
          accno: 'E-MTAB-1',
          section: {
            files: [
              {
                path,
                ...(size === undefined ? {} : { size }),
                attributes: [{ name: 'Type', value: 'SDRF File' }]
              }
            ]
          }
        })
  ) as unknown as typeof fetch

const MGNIFY_ANALYSES = [
  {
    id: 'MGYA2',
    attributes: {
      'pipeline-version': 5,
      'experiment-type': 'metatranscriptomics',
      'analysis-status': 'completed'
    },
    relationships: { sample: { data: { id: 'SAME2' } } }
  },
  {
    id: 'MGYA1',
    attributes: { 'experiment-type': 'amplicon' },
    relationships: {
      run: { data: [{ id: 'ERR2' }, { id: 'ERR1' }] },
      assembly: { data: { id: 'ERZ1' } }
    }
  }
]

describe('omics-archives tool set', () => {
  it('exposes exactly the 17 upstream tools, all on connector omics-archives', () => {
    expect(OMICS_ARCHIVES_TOOLS.map((t) => t.id).sort()).toEqual(
      [
        'arrayexpress_get_experiment',
        'arrayexpress_get_experiment_files',
        'arrayexpress_get_experiment_samples',
        'arrayexpress_search_experiments',
        'geo_get_series',
        'geo_search_series',
        'metabolights_get_studies',
        'metabolights_get_study_files',
        'metabolights_list_studies',
        'metabolights_search_data_files',
        'mgnify_get_studies',
        'mgnify_get_study_analyses',
        'mgnify_search_studies',
        'pride_find_projects_for_protein',
        'pride_get_projects',
        'pride_search_project_proteins',
        'pride_search_projects'
      ].sort()
    )
    expect(OMICS_ARCHIVES_TOOLS.every((t) => t.connector === 'omics-archives')).toBe(true)
  })
})

describe('arrayexpress_search_experiments', () => {
  it('builds facet params, walks pages and verifies against totalHits', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        totalHits: 1,
        isTotalHitsExact: true,
        hits: [
          {
            accession: 'E-MTAB-1',
            title: 'A',
            release_date: '2020-01-01',
            files: 3,
            links: 1,
            isPublic: true
          }
        ]
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_search_experiments'),
      {
        query: 'cancer AND pancreas',
        organism: 'Homo sapiens',
        study_type: 'ChIP-seq',
        technology: ' Sequencing Assay ',
        released_after: '2020-01-01',
        released_before: '2020-12-31',
        extra_facets: { species: ' Mouse ', 'facet.instrument': ' Orbitrap ' }
      },
      {}
    )) as Record<string, unknown>
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toContain('arrayexpress/search?')
    expect(url).toContain(
      `query=${encodeURIComponent(
        '(cancer AND pancreas) AND release_date:[2020-01-01 TO 2020-12-31]'
      )}`
    )
    expect(url).toContain(encodeURIComponent('facet.organism'))
    expect(url).toContain('homo%20sapiens')
    expect(url).toContain(`${encodeURIComponent('facet.technology')}=sequencing%20assay`)
    expect(url).toContain(`${encodeURIComponent('facet.species')}=mouse`)
    expect(url).toContain(`${encodeURIComponent('facet.instrument')}=orbitrap`)
    expect(url).toContain('sortBy=release_date')
    expect(url).toContain('pageSize=100')
    expect(out.total_hits).toBe(1)
    expect(out.is_total_exact).toBe(true)
    expect(out.truncated).toBe(false)
    expect(out.records).toEqual([
      {
        accession: 'E-MTAB-1',
        title: 'A',
        release_date: '2020-01-01',
        files: 3,
        links: 1,
        is_public: true
      }
    ])
  })

  it('caps at max_records and flags truncated without raising a mismatch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        totalHits: 5,
        isTotalHitsExact: true,
        hits: [
          { accession: 'E-1', release_date: '2020-01-03' },
          { accession: 'E-2', release_date: '2020-01-02' },
          { accession: 'E-3', release_date: '2020-01-01' }
        ]
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_search_experiments'),
      { query: 'x', max_records: 2 },
      {}
    )) as Record<string, unknown>
    expect(out.truncated).toBe(true)
    expect(out.total_hits).toBe(5)
    expect((out.records as unknown[]).length).toBe(2)
  })

  it('retries changing page boundaries before surfacing a pagination mismatch', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page')
      return jsonRes({
        totalHits: 2,
        isTotalHitsExact: true,
        hits: page === '1' ? [{ accession: 'E-1', release_date: '2020-01-01' }] : []
      })
    })

    await expect(
      engine(fetchImpl).call(tool('arrayexpress_search_experiments'), { query: 'x' }, {})
    ).rejects.toThrow(
      'Pagination mismatch: retrieved 1 unique accessions but the API reported totalHits=2'
    )

    expect(
      fetchImpl.mock.calls.map(([url]) => new URL(url as string).searchParams.get('pageSize'))
    ).toEqual(['100', '100', '97', '97', '89', '89'])
  })
})

describe('arrayexpress_get_experiment', () => {
  it('flattens the submission section tree', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        accno: 'E-MTAB-5061',
        attributes: [{ name: 'ReleaseDate', value: '2017-01-01' }],
        section: {
          type: 'Study',
          attributes: [
            { name: 'Title', value: 'Human pancreas' },
            { name: 'Study type', value: 'RNA-seq of coding RNA from single cells' },
            { name: 'Organism', value: 'Homo sapiens' },
            { name: 'Description', value: 'D' }
          ],
          subsections: [
            { type: 'Samples', attributes: [{ name: 'Sample count', value: '18' }] },
            {
              type: 'Assays and Data',
              attributes: [
                { name: 'Technology', value: 'sequencing assay' },
                { name: 'Assay count', value: '18' }
              ]
            }
          ]
        }
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_get_experiment'),
      { accession: 'E-MTAB-5061' },
      {}
    )) as Record<string, unknown>
    expect(out).toMatchObject({
      accession: 'E-MTAB-5061',
      title: 'Human pancreas',
      release_date: '2017-01-01',
      study_type: 'RNA-seq of coding RNA from single cells',
      organisms: ['Homo sapiens'],
      sample_count: 18,
      assay_count: 18,
      technology: 'sequencing assay',
      file_count: 0
    })
  })

  it('normalizes nested people, publications, protocols, files, and links', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        accno: 'E-MTAB-2',
        attributes: [
          { name: 'Title', value: 'Fallback title' },
          { name: 'ReleaseDate', value: '2024-01-02' }
        ],
        section: {
          type: 'Study',
          attributes: [
            { name: 'Title', value: 'Nested study' },
            { name: 'Organism', value: 'Mus musculus' },
            { name: 'Organism', value: 'Mus musculus' }
          ],
          subsections: [
            [
              {
                type: 'Samples',
                attributes: [
                  { name: 'Sample count', value: '2.9' },
                  { name: 'Experimental Designs', value: 'design-b' },
                  { name: 'Experimental Designs', value: 'design-a' },
                  { name: 'Experimental Factors', value: 'factor-a' }
                ]
              },
              {
                type: 'Assays and Data',
                attributes: [
                  { name: 'Assay count', value: '3' },
                  { name: 'Technology', value: 'sequencing assay' },
                  { name: 'Assay by Molecule', value: 'RNA assay' }
                ]
              },
              {
                type: 'Organization',
                accno: 'ORG2',
                attributes: [{ name: 'Name', value: 'Zeta Lab' }]
              },
              {
                type: 'Organisation',
                accno: 'ORG1',
                attributes: [{ name: 'Name', value: 'Alpha Lab' }]
              },
              {
                type: 'Author',
                attributes: [
                  { name: 'Name', value: 'Ada Scientist' },
                  { name: 'Email', value: 'ada@example.org' },
                  { name: 'Role', value: 'submitter' },
                  { name: 'affiliation', value: 'ORG2' },
                  { name: 'affiliation', value: 'External Institute' }
                ]
              },
              {
                type: 'Publication',
                accno: 'PMID1',
                attributes: [
                  { name: 'Title', value: 'Paper' },
                  { name: 'DOI', value: '10.1/example' }
                ]
              },
              {
                type: 'Protocols',
                attributes: [
                  { name: 'Type', value: 'library construction' },
                  { name: 'Type', value: 'sequencing' }
                ]
              }
            ],
            {
              type: 'Data',
              files: [
                [
                  {
                    path: 'b.txt',
                    size: 10,
                    attributes: [{ name: 'Description', value: 'processed' }]
                  },
                  {
                    path: 'a.fastq',
                    size: 5,
                    attributes: [{ name: 'Type', value: 'raw' }]
                  }
                ],
                { path: 'c.txt', size: '7', attributes: [] }
              ],
              links: [
                [
                  {
                    url: 'A-DESIGN-2',
                    attributes: [{ name: 'Type', value: 'Array Design' }]
                  },
                  {
                    url: 'A-DESIGN-1',
                    attributes: [{ name: 'Type', value: 'Array Design' }]
                  },
                  {
                    url: 'A-DESIGN-1',
                    attributes: [{ name: 'Type', value: 'Array Design' }]
                  }
                ],
                { url: 'https://example.org/data', attributes: [{ name: 'Type', value: 'Data' }] }
              ]
            }
          ]
        }
      })
    )

    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_get_experiment'),
      { accession: 'E-MTAB-2' },
      {}
    )) as Record<string, unknown>

    expect(out).toMatchObject({
      accession: 'E-MTAB-2',
      title: 'Nested study',
      sample_count: 2,
      assay_count: 3,
      technology: 'sequencing assay',
      assay_by_molecule: 'RNA assay',
      experimental_designs: ['design-a', 'design-b'],
      experimental_factors: ['factor-a'],
      submitter_organizations: ['Alpha Lab', 'Zeta Lab'],
      protocol_count: 1,
      protocol_types: ['library construction', 'sequencing'],
      array_designs: ['A-DESIGN-1', 'A-DESIGN-2'],
      file_count: 3,
      files_by_type: { processed: 1, raw: 1, unspecified: 1 },
      total_file_bytes: 15
    })
    expect(out.authors).toEqual([
      {
        name: 'Ada Scientist',
        email: 'ada@example.org',
        role: 'submitter',
        affiliations: ['Zeta Lab', 'External Institute']
      }
    ])
    expect(out.publications).toEqual([
      {
        accno: 'PMID1',
        title: 'Paper',
        authors: undefined,
        doi: '10.1/example',
        status: undefined
      }
    ])
    expect(out.links).toEqual([
      { target: 'A-DESIGN-1', type: 'Array Design' },
      { target: 'A-DESIGN-2', type: 'Array Design' },
      { target: 'https://example.org/data', type: 'Data' }
    ])
  })
})

describe('arrayexpress_get_experiment_files', () => {
  it('joins submission files with /info download links', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      url.endsWith('/info')
        ? jsonRes({ files: 1, httpLink: 'http://h', ftpLink: 'ftp://f', relPath: 'r' })
        : jsonRes({
            accno: 'E-MTAB-1',
            section: {
              files: [
                { path: 'data/x.txt', size: 10, attributes: [{ name: 'Type', value: 'raw' }] }
              ]
            }
          })
    )
    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_get_experiment_files'),
      { accession: 'E-MTAB-1' },
      {}
    )) as Record<string, unknown>
    expect(out.n_files).toBe(1)
    expect(out.info_reported_file_count).toBe(1)
    const files = out.files as Array<Record<string, unknown>>
    expect(files[0].download_url).toBe('https://www.ebi.ac.uk/biostudies/files/E-MTAB-1/data/x.txt')
  })
})

describe('arrayexpress_get_experiment_samples', () => {
  it('returns no_sdrf when the submission has no SDRF file', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ accno: 'E-MTAB-1', section: { files: [{ path: 'x.txt', attributes: [] }] } })
      )
    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_get_experiment_samples'),
      { accession: 'E-MTAB-1' },
      {}
    )) as Record<string, unknown>
    expect(out.error).toBe('no_sdrf')
    expect(out.n_samples).toBe(0)
    expect(out.samples).toEqual([])
  })

  it('parses SDRF rows and disambiguates repeated headers', async () => {
    const fetchImpl = sdrfFetch(
      'Source Name\tCharacteristics[organism]\tCharacteristics[organism]\nS1\tHomo\tsapiens\n',
      'a.sdrf.txt',
      100
    )
    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_get_experiment_samples'),
      { accession: 'E-MTAB-1' },
      {}
    )) as Record<string, unknown>
    expect(out.headers).toEqual([
      'Source Name',
      'Characteristics[organism]',
      'Characteristics[organism]#2'
    ])
    expect(out.n_samples).toBe(1)
    expect((out.samples as Array<Record<string, string>>)[0]).toEqual({
      'Source Name': 'S1',
      'Characteristics[organism]': 'Homo',
      'Characteristics[organism]#2': 'sapiens'
    })
    expect(out.rows_truncated).toBe(false)
  })

  it('returns an empty header set for an empty SDRF file', async () => {
    const fetchImpl = sdrfFetch('\n\t\n', 'empty.sdrf.txt', 0)

    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_get_experiment_samples'),
      { accession: 'E-MTAB-1' },
      {}
    )) as Record<string, unknown>

    expect(out).toMatchObject({
      sdrf_file: 'empty.sdrf.txt',
      headers: [],
      n_samples: 0,
      samples: []
    })
  })

  it('pads short SDRF rows and caps returned samples without losing the total', async () => {
    const fetchImpl = sdrfFetch('Sample\tValue\nS1\nS2\tmeasured\n', 'samples.sdrf.txt', 30)

    const out = (await engine(fetchImpl).call(
      tool('arrayexpress_get_experiment_samples'),
      { accession: 'E-MTAB-1', max_rows_returned: 1 },
      {}
    )) as Record<string, unknown>

    expect(out.n_samples).toBe(2)
    expect(out.n_samples_returned).toBe(1)
    expect(out.rows_truncated).toBe(true)
    expect(out.samples).toEqual([{ Sample: 'S1', Value: '' }])
  })

  it('rejects SDRF rows wider than the header instead of truncating them', async () => {
    const fetchImpl = sdrfFetch('Sample\tValue\nS1\tmeasured\textra\n', 'invalid.sdrf.txt')

    await expect(
      engine(fetchImpl).call(
        tool('arrayexpress_get_experiment_samples'),
        { accession: 'E-MTAB-1' },
        {}
      )
    ).rejects.toThrow('SDRF row has 3 fields but header has 2')
  })
})

describe('geo_search_series', () => {
  it('esearch + esummary, trims docs, sorts samples, includes etiquette', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '2', idlist: ['1', '2'] } }))
      .mockResolvedValueOnce(
        jsonRes({
          result: {
            uids: ['1', '2'],
            '1': {
              accession: 'GSE1',
              title: 't1',
              taxon: 'Homo sapiens',
              n_samples: 5,
              gdstype: 'x',
              samples: [
                { accession: 'GSM2', title: 'b' },
                { accession: 'GSM1', title: 'a' }
              ]
            },
            '2': { accession: 'GSE2', title: 't2', n_samples: '', gdstype: 'y' }
          }
        })
      )
    const out = (await engine(fetchImpl).call(
      tool('geo_search_series'),
      { term: 'asthma AND gse[ETYP]', retmax: 2 },
      { ncbiEmail: 'x@y.org' }
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toContain('db=gds')
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(out.count).toBe(2)
    const records = out.records as Array<Record<string, unknown>>
    expect(records.map((r) => r.accession)).toEqual(['GSE1', 'GSE2'])
    expect(records[0].n_samples).toBe(5)
    expect(records[0].samples).toEqual([
      { accession: 'GSM1', title: 'a' },
      { accession: 'GSM2', title: 'b' }
    ])
    expect(records[1].n_samples).toBeNull() // "" normalizes to null, not 0
  })

  it('surfaces an explicit E-utilities error response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ esearchresult: { ERROR: 'invalid term' } }))

    await expect(
      engine(fetchImpl).call(tool('geo_search_series'), { term: 'bad[query]' }, {})
    ).rejects.toThrow('esearch error for term "bad[query]": invalid term')
  })
})

describe('geo_get_series', () => {
  it('resolves accessions then assembles from SOFT headers', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('esearch.fcgi'))
        return jsonRes({ esearchresult: { count: '1', idlist: ['200000001'] } })
      if (url.includes('esummary.fcgi'))
        return jsonRes({
          result: {
            uids: ['200000001'],
            '200000001': {
              accession: 'GSE1',
              taxon: 'Homo sapiens; Mus musculus',
              ftplink: 'ftp://x'
            }
          }
        })
      if (url.includes('targ=self'))
        return textRes(
          '^SERIES = GSE1\n!Series_title = My series\n!Series_summary = line one\n!Series_type = Expression profiling\n!Series_platform_id = GPL1\n'
        )
      return textRes(
        '^SAMPLE = GSM1\n!Sample_title = s1\n!Sample_characteristics_ch1 = tissue: lung\n!Sample_characteristics_ch1 = status:\n!Sample_supplementary_file = NONE\n!Sample_supplementary_file_1 = ftp://sample\n'
      )
    })
    const out = (await engine(fetchImpl).call(
      tool('geo_get_series'),
      { accessions: ['GSE1'] },
      { ncbiEmail: 'x@y.org' }
    )) as Record<string, unknown>
    expect(out.n_requested).toBe(1)
    const rec = (out.records as Array<Record<string, unknown>>)[0]
    expect(rec.accession).toBe('GSE1')
    expect(rec.title).toBe('My series')
    expect(rec.organism).toEqual(['Homo sapiens', 'Mus musculus'])
    expect(rec.n_samples).toBe(1)
    const sample = (rec.samples as Array<Record<string, unknown>>)[0]
    expect(sample.characteristics).toEqual([
      { tag: 'tissue', value: 'lung' },
      { tag: 'status', value: '' }
    ])
    expect(sample.supplementary_files).toEqual(['ftp://sample'])
    expect((rec.supplementary_files as Record<string, unknown>).samples).toEqual({
      GSM1: ['ftp://sample']
    })
  })

  it('rejects a non-GSE accession before any request', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('geo_get_series'), { accessions: ['MTBLS1'] }, {})
    ).rejects.toThrow(/not a GSE accession/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a valid GSE accession missing from the esummary response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '1', idlist: ['1'] } }))
      .mockResolvedValueOnce(jsonRes({ result: { uids: ['1'], '1': { accession: 'GSE2' } } }))

    await expect(
      engine(fetchImpl).call(tool('geo_get_series'), { accessions: ['GSE1'] }, {})
    ).rejects.toThrow('accessions not found in GEO DataSets (db=gds): GSE1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects an acc.cgi response without SOFT entities', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('esearch.fcgi'))
        return jsonRes({ esearchresult: { count: '1', idlist: ['1'] } })
      if (url.includes('esummary.fcgi'))
        return jsonRes({ result: { uids: ['1'], '1': { accession: 'GSE1' } } })
      return textRes('temporarily unavailable')
    })

    await expect(
      engine(fetchImpl).call(tool('geo_get_series'), { accessions: ['GSE1'] }, {})
    ).rejects.toThrow('acc.cgi returned no SOFT entities for GSE1 (targ=self)')
  })
})

describe('metabolights_list_studies', () => {
  it('sorts accessions numerically and reports the API count', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ content: ['MTBLS10', 'MTBLS2', 'MTBLS2'], studies: 2 }))
    const out = (await engine(fetchImpl).call(tool('metabolights_list_studies'), {}, {})) as Record<
      string,
      unknown
    >
    expect(out.accessions).toEqual(['MTBLS2', 'MTBLS10'])
    expect(out.count).toBe(2)
    expect(out.reported_count).toBe(2)
  })
})

describe('metabolights_get_studies', () => {
  it('extracts metadata and routes 404 accessions to not_found', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      url.includes('MTBLS1/') || url.endsWith('MTBLS1')
        ? jsonRes({
            content: {
              studyIdentifier: 'MTBLS1',
              title: 'A study',
              studyStatus: 'PUBLIC',
              organism: [{ organismName: 'Homo sapiens', organismPart: 'urine' }],
              assays: [
                {
                  assayNumber: 1,
                  measurement: 'm',
                  technology: 'NMR spectroscopy assay',
                  fileName: 'a.txt'
                }
              ],
              factors: [{ name: 'Gender' }],
              descriptors: [{ description: 'EFO:x' }],
              derivedData: { releaseYear: 2012, submissionYear: 2012 },
              sampleTable: { data: [[1], [2]], fields: {} },
              protocols: [{ name: 'Extraction', description: 'desc' }]
            }
          })
        : errRes(404)
    )
    const out = (await engine(fetchImpl).call(
      tool('metabolights_get_studies'),
      { accessions: ['MTBLS1', 'MTBLS999'] },
      {}
    )) as Record<string, unknown>
    expect(out.n_requested).toBe(2)
    expect(out.not_found).toEqual(['MTBLS999'])
    const rec = (out.records as Array<Record<string, unknown>>)[0]
    expect(rec.accession).toBe('MTBLS1')
    expect(rec.sample_count).toBe(2)
    expect(rec.technologies).toEqual(['NMR spectroscopy assay'])
    expect(rec.protocols).toEqual([{ name: 'Extraction', description: 'desc' }])
  })

  it('includes an ordered and capped sample table when requested', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        content: {
          studyIdentifier: 'MTBLS2',
          sampleTable: {
            fields: {
              second: { index: 1 },
              first: { index: 0, header: 'Sample Name' },
              ignored: { header: 'Ignored' }
            },
            data: [['S1'], ['S2', 'measured']]
          },
          protocols: [{ name: ' ' }, { description: 'Prepared consistently' }]
        }
      })
    )

    const out = (await engine(fetchImpl).call(
      tool('metabolights_get_studies'),
      { accessions: [' mtbls2 ', 'MTBLS2'], include_samples: true, max_sample_rows_returned: 1 },
      {}
    )) as Record<string, unknown>
    const record = (out.records as Array<Record<string, unknown>>)[0]

    expect(out.n_requested).toBe(1)
    expect(record.protocols).toEqual([{ name: null, description: 'Prepared consistently' }])
    expect(record.sample_table).toEqual({
      headers: ['Sample Name', 'column_1'],
      rows: [{ 'Sample Name': 'S1', column_1: '' }],
      n_rows_total: 2,
      rows_truncated: true
    })
  })
})

describe('metabolights_get_study_files', () => {
  it('validates the accession before making a request', async () => {
    const fetchImpl = vi.fn()

    await expect(
      engine(fetchImpl).call(tool('metabolights_get_study_files'), { accession: 'GSE1' }, {})
    ).rejects.toThrow('not a MetaboLights accession')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sorts study entries and includes the recursive data inventory by default', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      url.includes('/public-data-files?')
        ? jsonRes({
            files: [{ name: 'FILES/z.raw' }, { name: undefined }, { name: 'FILES/a.raw' }]
          })
        : jsonRes({
            latest: 'v2',
            study: [
              { file: 'z.raw', type: 'raw', status: 'active', directory: false },
              { file: 'metadata', type: 'metadata-folder', status: 'active', directory: true },
              { file: 'i_mtbls2.txt', type: 'metadata-isa', status: 'active', directory: false }
            ]
          })
    )

    const out = (await engine(fetchImpl).call(
      tool('metabolights_get_study_files'),
      { accession: ' mtbls2 ' },
      {}
    )) as Record<string, unknown>

    expect(out).toMatchObject({
      accession: 'MTBLS2',
      latest_version: 'v2',
      n_study_folder_entries: 3,
      metadata_files: ['i_mtbls2.txt', 'metadata'],
      data_files: ['FILES/a.raw', 'FILES/z.raw'],
      n_data_files: 2
    })
    expect((out.study_folder as Array<Record<string, unknown>>).map((entry) => entry.file)).toEqual(
      ['metadata', 'i_mtbls2.txt', 'z.raw']
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not fetch the data inventory when include_data_files is false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ latest: 'v1', study: [] }))

    const out = (await engine(fetchImpl).call(
      tool('metabolights_get_study_files'),
      { accession: 'MTBLS1', include_data_files: false },
      {}
    )) as Record<string, unknown>

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(out).not.toHaveProperty('data_files')
    expect(out).not.toHaveProperty('n_data_files')
  })
})

describe('metabolights_search_data_files', () => {
  it('normalizes the accession and verifies wildcard matches client-side', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        files: [{ name: 'FILES/sample[1]-b.mzML' }, { name: 'FILES/sample[1]-a.mzML' }]
      })
    )

    const out = (await engine(fetchImpl).call(
      tool('metabolights_search_data_files'),
      { accession: ' mtbls3 ', pattern: 'sample[1]-?.mzML' },
      {}
    )) as Record<string, unknown>
    const url = new URL(fetchImpl.mock.calls[0][0] as string)

    expect(url.pathname).toContain('/studies/MTBLS3/public-data-files')
    expect(url.searchParams.get('search_pattern')).toBe('sample[1]-?.mzML')
    expect(out).toEqual({
      accession: 'MTBLS3',
      pattern: 'sample[1]-?.mzML',
      file_match: true,
      folder_match: false,
      files: ['FILES/sample[1]-a.mzML', 'FILES/sample[1]-b.mzML'],
      n_files: 2
    })
  })

  it('rejects a server result outside the requested glob', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ files: [{ name: 'FILES/sample.raw' }] }))

    await expect(
      engine(fetchImpl).call(
        tool('metabolights_search_data_files'),
        { accession: 'MTBLS3', pattern: '*.mzML' },
        {}
      )
    ).rejects.toThrow('server returned 1 entries not matching pattern "*.mzML"')
  })
})

describe('mgnify_search_studies', () => {
  it('requires exactly one of query / biome_lineage', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(
        tool('mgnify_search_studies'),
        { query: 'coral', biome_lineage: 'root:X' },
        {}
      )
    ).rejects.toThrow(/exactly one/)
    await expect(engine(fetchImpl).call(tool('mgnify_search_studies'), {}, {})).rejects.toThrow(
      /exactly one/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('paginates to completion and verifies the count', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        meta: { pagination: { count: 1 } },
        links: {},
        data: [
          {
            id: 'MGYS1',
            type: 'studies',
            attributes: { 'study-name': 'n', 'samples-count': 3 },
            relationships: { biomes: { data: [{ id: 'root:Engineered:Wastewater' }] } }
          }
        ]
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('mgnify_search_studies'),
      { query: 'coral' },
      {}
    )) as Record<string, unknown>
    expect(out.count).toBe(1)
    const rec = (out.records as Array<Record<string, unknown>>)[0]
    expect(rec.accession).toBe('MGYS1')
    expect(rec.biome_lineages).toEqual(['root:Engineered:Wastewater'])
  })

  it('walks the biome-lineage endpoint through every page', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({
          meta: { pagination: { count: 2 } },
          links: { next: 'https://next.example/studies?page=2' },
          data: [{ id: 'MGYS2', attributes: { 'study-name': 'second' } }]
        })
      )
      .mockResolvedValueOnce(
        jsonRes({
          links: {},
          data: [{ id: 'MGYS1', attributes: { 'study-name': 'first' } }]
        })
      )

    const out = (await engine(fetchImpl).call(
      tool('mgnify_search_studies'),
      { biome_lineage: 'root:Engineered:Wastewater' },
      {}
    )) as Record<string, unknown>

    expect(fetchImpl.mock.calls[0][0]).toContain('/biomes/root:Engineered:Wastewater/studies?')
    expect(out.pages_fetched).toBe(2)
    expect(
      (out.records as Array<Record<string, unknown>>).map((record) => record.accession)
    ).toEqual(['MGYS1', 'MGYS2'])
  })

  it('rejects duplicate records that disagree with the API count', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        meta: { pagination: { count: 2 } },
        links: {},
        data: [{ id: 'MGYS1' }, { id: 'MGYS1' }]
      })
    )

    await expect(
      engine(fetchImpl).call(tool('mgnify_search_studies'), { query: 'coral' }, {})
    ).rejects.toThrow(
      'pagination mismatch on studies: meta.pagination.count=2, retrieved=2, unique=1'
    )
  })
})

describe('mgnify_get_studies', () => {
  it('deduplicates studies, collects missing accessions, and summarizes analyses', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/studies/MGYS1/analyses?'))
        return jsonRes({
          meta: { pagination: { count: 2 } },
          links: {},
          data: MGNIFY_ANALYSES
        })
      if (url.includes('/studies/MGYS2/analyses?'))
        return jsonRes({ meta: { pagination: { count: 0 } }, links: {}, data: [] })
      if (url.endsWith('/studies/MGYS1'))
        return jsonRes({
          data: {
            id: 'MGYS1',
            attributes: { 'study-name': 'Study one' },
            relationships: { biomes: { data: [{ id: 'root:Marine' }] } }
          }
        })
      if (url.endsWith('/studies/MGYS2'))
        return jsonRes({
          data: { id: 'MGYS2', attributes: { 'study-name': 'Study two' }, relationships: {} }
        })
      return errRes(404)
    })

    const out = (await engine(fetchImpl).call(
      tool('mgnify_get_studies'),
      { accessions: ['MGYS9', 'MGYS2', 'MGYS1', 'MGYS1'], include_analyses: true },
      {}
    )) as Record<string, unknown>
    const study = (out.studies as Array<Record<string, unknown>>)[0]
    const analyses = (out.analyses as Record<string, Array<Record<string, unknown>>>).MGYS1

    expect(out.missing).toEqual(['MGYS9'])
    expect(
      (out.studies as Array<Record<string, unknown>>).map((record) => record.accession)
    ).toEqual(['MGYS1', 'MGYS2'])
    expect(
      fetchImpl.mock.calls.filter(([url]) => (url as string).endsWith('/studies/MGYS1'))
    ).toHaveLength(1)
    expect(study).toMatchObject({
      accession: 'MGYS1',
      biome_lineages: ['root:Marine'],
      analyses_total: 2,
      analyses_by_pipeline_version: { '5': 1, unknown: 1 },
      analyses_by_experiment_type: { amplicon: 1, metatranscriptomics: 1 }
    })
    expect(analyses.map((analysis) => analysis.analysis_accession)).toEqual(['MGYA1', 'MGYA2'])
  })
})

describe('mgnify_get_study_analyses', () => {
  it('flattens relationships and sorts analysis records', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        meta: { pagination: { count: 2 } },
        links: {},
        data: MGNIFY_ANALYSES
      })
    )

    const out = (await engine(fetchImpl).call(
      tool('mgnify_get_study_analyses'),
      { accession: 'MGYS1' },
      {}
    )) as Record<string, unknown>
    const analyses = out.analyses as Array<Record<string, unknown>>

    expect(out.analyses_count).toBe(2)
    expect(analyses.map((analysis) => analysis.analysis_accession)).toEqual(['MGYA1', 'MGYA2'])
    expect(analyses[0]).toMatchObject({
      study_accession: 'MGYS1',
      pipeline_version: null,
      experiment_type: 'amplicon',
      run_accession: 'ERR1',
      assembly_accession: 'ERZ1',
      sample_accession: null
    })
  })
})

describe('pride_search_projects', () => {
  it('reads the total_records header, sorts by accession, and caps output', async () => {
    const body = [
      { accession: 'PXD2', title: 't2', organisms: ['Homo sapiens (human)'] },
      {
        accession: 'PXD1',
        title: ' t1 ',
        organisms: [{ name: 'Homo sapiens (human)' }, 'Homo sapiens (human)'],
        submitters: [{ firstName: 'Ada', lastName: 'Lovelace' }, { name: ' Grace Hopper ' }],
        references: [
          'Reference line--pubMed:123--doi: https://doi.org/10.1/X',
          'Invalid ids--pubMed:notanumber--doi: none',
          'Unstructured reference'
        ]
      }
    ]
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(body, { total_records: '2' }))
    const out = (await engine(fetchImpl).call(
      tool('pride_search_projects'),
      {
        keyword: 'phosphoproteome',
        organism: 'Homo sapiens (human)',
        instrument: 'Orbitrap',
        disease: 'Cancer',
        extra_filters: { projectTags: 'Human' },
        max_records_returned: 1
      },
      {}
    )) as Record<string, unknown>
    expect(out.api_total).toBe(2)
    expect(out.complete).toBe(true)
    expect(out.records_truncated).toBe(true)
    expect((out.records as Array<Record<string, unknown>>).map((r) => r.accession)).toEqual([
      'PXD1'
    ])
    const url = new URL(fetchImpl.mock.calls[0][0] as string)
    expect(url.searchParams.get('sortFields')).toBe('accession')
    expect(url.searchParams.get('sortDirection')).toBe('ASC')
    expect(url.searchParams.get('filter')).toBe(
      'organisms==Homo sapiens (human),instruments==Orbitrap,diseases==Cancer,projectTags==Human'
    )
    const record = (out.records as Array<Record<string, unknown>>)[0]
    expect(record.title).toBe('t1')
    expect(record.organisms).toEqual(['Homo sapiens (human)'])
    expect(record.submitters).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(record.references).toEqual([
      { pubmed_id: null, doi: null, reference_line: 'Invalid ids' },
      { pubmed_id: null, doi: null, reference_line: 'Unstructured reference' },
      { pubmed_id: 123, doi: '10.1/x', reference_line: 'Reference line' }
    ])
  })

  it('rejects a complete response whose unique count disagrees with total_records', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes([{ accession: 'PXD1' }], { total_records: '2' }))

    await expect(
      engine(fetchImpl).call(tool('pride_search_projects'), { keyword: 'x' }, {})
    ).rejects.toThrow('retrieved 1 unique projects but API reported total_records=2')
  })
})

describe('pride_get_projects', () => {
  it('normalizes detail records and collects not_found', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      url.endsWith('PXD1')
        ? jsonRes({
            accession: 'PXD1',
            title: 't',
            organisms: [{ name: 'Homo sapiens (human)' }],
            references: [{ pubmedID: '123', doi: 'https://doi.org/10.1/X', referenceLine: 'ref' }]
          })
        : errRes(404)
    )
    const out = (await engine(fetchImpl).call(
      tool('pride_get_projects'),
      { accessions: ['PXD1', 'PXD9'] },
      {}
    )) as Record<string, unknown>
    expect(out.not_found).toEqual(['PXD9'])
    const rec = (out.records as Array<Record<string, unknown>>)[0]
    expect(rec.source).toBe('detail')
    expect(rec.organisms).toEqual(['Homo sapiens (human)'])
    expect(rec.references).toEqual([{ pubmed_id: 123, doi: '10.1/x', reference_line: 'ref' }])
  })

  it('rethrows a non-not-found detail failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(500))

    await expect(
      engine(fetchImpl).call(tool('pride_get_projects'), { accessions: ['PXD1'] }, {})
    ).rejects.toThrow(/HTTP 500/)
  })
})

describe('pride_search_project_proteins', () => {
  it('forwards the keyword, paginates to exhaustion, normalizes, and sorts proteins', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      proteinAccession: `P${String(100 - index).padStart(3, '0')}`,
      proteinName: `Protein ${index}`,
      gene: `GENE${index}`,
      projectCount: index + 1
    }))
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page')
      return jsonRes(
        page === '0'
          ? firstPage
          : [{ proteinAccession: 'P000', proteinName: 'Protein zero', projectCount: 1 }]
      )
    })

    const out = (await engine(fetchImpl).call(
      tool('pride_search_project_proteins'),
      { project_accession: 'PXD1', keyword: 'kinase' },
      {}
    )) as Record<string, unknown>
    const proteins = out.proteins as Array<Record<string, unknown>>
    const firstUrl = new URL(fetchImpl.mock.calls[0][0] as string)

    expect(firstUrl.searchParams.get('projectAccession')).toBe('PXD1')
    expect(firstUrl.searchParams.get('keyword')).toBe('kinase')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.n_proteins).toBe(101)
    expect(proteins[0]).toMatchObject({
      protein_accession: 'P000',
      protein_name: 'Protein zero',
      project_count: 1
    })
    expect(proteins.at(-1)?.protein_accession).toBe('P100')
  })
})

describe('pride_find_projects_for_protein', () => {
  it('returns projects for a protein, sorted', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes([{ proteinAccession: 'P04637', projects: ['PXD2', 'PXD1'] }]))
    const out = (await engine(fetchImpl).call(
      tool('pride_find_projects_for_protein'),
      { protein_accession: 'P04637' },
      {}
    )) as Record<string, unknown>
    const rec = (out.records as Array<Record<string, unknown>>)[0]
    expect(rec.projects).toEqual(['PXD1', 'PXD2'])
    expect(rec.n_projects).toBe(2)
  })
})

// -----------------------------------------------------------------------------
// LIVE integration tests — hit the real EBI/NCBI backends. Opt in with LIVE_API=1.
// -----------------------------------------------------------------------------
describe.skipIf(!process.env.LIVE_API)('omics-archives (LIVE)', () => {
  const live = new ParserEngine()
  const call = (id: string, args: Record<string, unknown>): Promise<unknown> =>
    live.call(tool(id), args, { ncbiEmail: 'openscience-tests@example.org' })

  it('arrayexpress_get_experiment E-MTAB-5061', async () => {
    const out = (await call('arrayexpress_get_experiment', { accession: 'E-MTAB-5061' })) as Record<
      string,
      unknown
    >
    expect(out.accession).toBe('E-MTAB-5061')
    expect(out.organisms).toContain('Homo sapiens')
  }, 30000)

  it('arrayexpress_search_experiments (bounded)', async () => {
    const out = (await call('arrayexpress_search_experiments', {
      organism: 'Homo sapiens',
      study_type: 'ChIP-seq',
      max_records: 3
    })) as Record<string, unknown>
    expect(typeof out.total_hits).toBe('number')
    expect((out.records as unknown[]).length).toBeLessThanOrEqual(3)
  }, 60000)

  it('geo_search_series', async () => {
    const out = (await call('geo_search_series', {
      term: '"single cell rna seq"[All Fields] AND gse[ETYP]',
      retmax: 3
    })) as Record<string, unknown>
    expect(typeof out.count).toBe('number')
  }, 30000)

  it('metabolights_get_studies MTBLS1', async () => {
    const out = (await call('metabolights_get_studies', { accessions: ['MTBLS1'] })) as Record<
      string,
      unknown
    >
    expect((out.records as Array<Record<string, unknown>>)[0].accession).toBe('MTBLS1')
  }, 30000)

  it('mgnify_search_studies (biome) verifies count', async () => {
    const out = (await call('mgnify_search_studies', {
      biome_lineage: 'root:Engineered:Wastewater'
    })) as Record<string, unknown>
    expect(out.count).toBe((out.records as unknown[]).length)
  }, 60000)

  it('pride_search_projects (bounded)', async () => {
    const out = (await call('pride_search_projects', {
      keyword: 'phosphoproteome',
      max_records_returned: 3
    })) as Record<string, unknown>
    expect(typeof out.api_total).toBe('number')
    expect((out.records as unknown[]).length).toBeLessThanOrEqual(3)
  }, 60000)

  it('pride_find_projects_for_protein P04637', async () => {
    const out = (await call('pride_find_projects_for_protein', {
      protein_accession: 'P04637'
    })) as Record<string, unknown>
    expect(typeof out.n_records).toBe('number')
  }, 30000)
})
