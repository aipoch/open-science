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

describe('omics_archives tool set', () => {
  it('exposes exactly the 17 upstream tools, all on connector omics_archives', () => {
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
    expect(OMICS_ARCHIVES_TOOLS.every((t) => t.connector === 'omics_archives')).toBe(true)
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
      { query: 'cancer', organism: 'Homo sapiens', study_type: 'ChIP-seq' },
      {}
    )) as Record<string, unknown>
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toContain('arrayexpress/search?')
    expect(url).toContain('query=cancer')
    expect(url).toContain(encodeURIComponent('facet.organism'))
    expect(url).toContain('homo%20sapiens')
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
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      url.includes('/biostudies/files/')
        ? textRes(
            'Source Name\tCharacteristics[organism]\tCharacteristics[organism]\nS1\tHomo\tsapiens\n'
          )
        : jsonRes({
            accno: 'E-MTAB-1',
            section: {
              files: [
                {
                  path: 'a.sdrf.txt',
                  size: 100,
                  attributes: [{ name: 'Type', value: 'SDRF File' }]
                }
              ]
            }
          })
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
            '200000001': { accession: 'GSE1', taxon: 'Homo sapiens', ftplink: 'ftp://x' }
          }
        })
      if (url.includes('targ=self'))
        return textRes(
          '^SERIES = GSE1\n!Series_title = My series\n!Series_summary = line one\n!Series_type = Expression profiling\n!Series_platform_id = GPL1\n'
        )
      return textRes(
        '^SAMPLE = GSM1\n!Sample_title = s1\n!Sample_organism_ch1 = Homo sapiens\n!Sample_characteristics_ch1 = tissue: lung\n'
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
    expect(rec.organism).toEqual(['Homo sapiens'])
    expect(rec.n_samples).toBe(1)
    const sample = (rec.samples as Array<Record<string, unknown>>)[0]
    expect(sample.characteristics).toEqual([{ tag: 'tissue', value: 'lung' }])
  })

  it('rejects a non-GSE accession before any request', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('geo_get_series'), { accessions: ['MTBLS1'] }, {})
    ).rejects.toThrow(/not a GSE accession/)
    expect(fetchImpl).not.toHaveBeenCalled()
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
})

describe('pride_search_projects', () => {
  it('reads the total_records header, sorts by accession, and caps output', async () => {
    const body = [
      { accession: 'PXD2', title: 't2', organisms: ['Homo sapiens (human)'] },
      { accession: 'PXD1', title: 't1', organisms: ['Homo sapiens (human)'] }
    ]
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(body, { total_records: '2' }))
    const out = (await engine(fetchImpl).call(
      tool('pride_search_projects'),
      { keyword: 'phosphoproteome', max_records_returned: 1 },
      {}
    )) as Record<string, unknown>
    expect(out.api_total).toBe(2)
    expect(out.complete).toBe(true)
    expect(out.records_truncated).toBe(true)
    expect((out.records as Array<Record<string, unknown>>).map((r) => r.accession)).toEqual([
      'PXD1'
    ])
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toContain('sortFields=accession')
    expect(url).toContain('sortDirection=ASC')
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
describe.skipIf(!process.env.LIVE_API)('omics_archives (LIVE)', () => {
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
