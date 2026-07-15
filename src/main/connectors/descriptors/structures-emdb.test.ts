import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { STRUCTURES_EMDB_TOOLS } from './structures-emdb'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as unknown as Response

const errRes = (status: number): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    headers: { get: () => null }
  }) as unknown as Response

const tool = (id: string): (typeof STRUCTURES_EMDB_TOOLS)[number] => {
  const t = STRUCTURES_EMDB_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }).call(
    tool(id),
    args,
    {}
  )

// A representative released EMDB /entry document (mouse apoferritin, EMD-11638-shaped).
const relEntry = {
  emdb_id: 'EMD-11638',
  admin: {
    title: 'Cryo-EM structure of mouse heavy-chain apoferritin',
    current_status: { code: { valueOf_: 'REL' }, date: '2024-07-10T00:00:00' },
    key_dates: {
      deposition: '2020-08-20T00:00:00',
      header_release: '2020-10-28T00:00:00',
      map_release: '2020-10-28T00:00:00',
      update: '2024-07-10T00:00:00'
    }
  },
  crossreferences: {
    pdb_list: { pdb_reference: [{ pdb_id: '7A4M' }, { pdb_id: '7a4m' }] },
    citation_list: {
      primary_citation: {
        citation_type: {
          title: 'Single-particle cryo-EM at atomic resolution.',
          journal: 'Nature',
          journal_abbreviation: 'Nature',
          year: '2020',
          published: true,
          volume: '587',
          first_page: '152',
          last_page: '156',
          country: 'UK',
          author: [
            { order: 2, valueOf_: 'Second A' },
            { order: 1, valueOf_: 'Nakane T' }
          ],
          external_references: [
            { type_: 'PUBMED', valueOf_: '33087931' },
            { type_: 'DOI', valueOf_: 'doi:10.1038/s41586-020-2829-0' },
            { type_: 'ISSN', valueOf_: '1476-4687' },
            { type_: 'CSD', valueOf_: '0006' }
          ]
        }
      }
    }
  },
  sample: {
    name: { valueOf_: 'Mouse heavy-chain apoferritin' },
    macromolecule_list: {
      macromolecule: [
        {
          macromolecule_id: 1,
          instance_type: 'protein',
          name: { valueOf_: 'Ferritin heavy chain' },
          number_of_copies: 24,
          molecular_weight: { theoretical: { units: 'MDa', valueOf_: '0.020079594' } },
          ec_number: [{ valueOf_: '1.16.3.1' }],
          natural_source: { organism: { ncbi: 10090, valueOf_: 'Mus musculus' } },
          sequence: { external_references: [{ type_: 'UNIPROTKB', valueOf_: 'P09528' }] }
        }
      ]
    },
    supramolecule_list: {
      supramolecule: [
        { supramolecule_id: 0, instance_type: 'complex', name: { valueOf_: 'Apoferritin' } }
      ]
    }
  },
  structure_determination_list: {
    structure_determination: [
      {
        method: 'singleParticle',
        aggregation_state: 'particle',
        image_processing: [
          {
            final_reconstruction: {
              resolution: { res_type: 'BY AUTHOR', units: 'Å', valueOf_: '1.22' },
              resolution_method: 'FSC 0.143 CUT-OFF'
            }
          }
        ],
        microscopy_list: {
          microscopy: [
            {
              microscopy_id: 1,
              instance_type: 'single_particle_microscopy',
              microscope: 'FEI TITAN KRIOS',
              acceleration_voltage: { units: 'kV', valueOf_: '300' },
              electron_source: 'FIELD EMISSION GUN',
              nominal_magnification: '75000',
              image_recording_list: {
                image_recording: [
                  {
                    image_recording_id: 1,
                    film_or_detector_model: { valueOf_: 'FEI FALCON III (4k x 4k)' },
                    number_real_images: 3126,
                    average_electron_dose_per_image: { units: 'e/Å^2', valueOf_: '40' }
                  }
                ]
              }
            }
          ]
        },
        specimen_preparation_list: {
          specimen_preparation: [
            {
              preparation_id: 1,
              instance_type: 'single_particle_preparation',
              buffer: { ph: '7.5', details: 'HEPES' },
              vitrification: {
                cryogen_name: 'ETHANE',
                chamber_humidity: { units: '%', valueOf_: '100' }
              }
            }
          ]
        }
      }
    ]
  },
  map: {
    file: 'emd_11638.map.gz',
    format: 'CCP4',
    size_kbytes: 67109,
    data_type: 'IMAGE STORED AS FLOATING POINT NUMBER (4 BYTES)',
    dimensions: { col: 256, row: 256, sec: 256 },
    origin: { col: 0, row: 0, sec: 0 },
    spacing: { x: 256, y: 256, z: 256 },
    axis_order: { fast: 'X', medium: 'Y', slow: 'Z' },
    pixel_spacing: {
      x: { units: 'Å', valueOf_: '0.5332' },
      y: { units: 'Å', valueOf_: '0.5332' },
      z: { units: 'Å', valueOf_: '0.5332' }
    },
    cell: { a: { units: 'Å', valueOf_: '136.4992' }, alpha: { units: 'deg', valueOf_: '90.0' } },
    statistics: { minimum: -0.159, maximum: 0.521, average: -0.0007, std: 0.0264 },
    contour_list: { contour: [{ level: 0.116, primary: true, source: 'AUTHOR' }] },
    symmetry: { space_group: 1 },
    label: '::::EMD-11638::::'
  }
}

describe('emdb_get_entries', () => {
  it('normalizes EMD-1234 / emd-1234 / 1234 to EMD-1234 in the fetched URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(relEntry))
    await run('emdb_get_entries', { emdb_ids: ['EMD-11638', 'emd-3061', '1234'] }, fetchImpl)
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]))
    expect(urls[0]).toContain('/entry/EMD-11638')
    expect(urls[1]).toContain('/entry/EMD-3061')
    expect(urls[2]).toContain('/entry/EMD-1234')
  })

  it('extracts the headline record: resolution, deduped fitted PDBs, citation, voxel size', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(relEntry))
    const out = (await run('emdb_get_entries', { emdb_ids: ['EMD-11638'] }, fetchImpl)) as {
      n_requested: number
      records: Array<Record<string, unknown>>
    }
    expect(out.n_requested).toBe(1)
    const r = out.records[0]
    expect(r.emdb_id).toBe('EMD-11638')
    expect(r.status).toBe('REL')
    expect(r.is_obsolete).toBe(false)
    expect(r.method).toBe('singleParticle')
    expect(r.resolution_angstrom).toBe(1.22)
    expect(r.resolution_method).toBe('FSC 0.143 CUT-OFF')
    expect(r.deposition_date).toBe('2020-08-20')
    expect(r.map_release_date).toBe('2020-10-28')
    // pdb ids lowercased + de-duplicated
    expect(r.fitted_pdb_ids).toEqual(['7a4m'])
    expect(r.has_fitted_model).toBe(true)
    expect(r.macromolecule_names).toEqual(['Ferritin heavy chain'])
    expect(r.supramolecule_names).toEqual(['Apoferritin'])
    expect(r.citation).toEqual({
      title: 'Single-particle cryo-EM at atomic resolution.',
      journal: 'Nature',
      year: 2020,
      published: true,
      doi: '10.1038/s41586-020-2829-0',
      pmid: '33087931',
      first_author: 'Second A',
      author_count: 2
    })
    // headline map: voxel size unwrapped, dimensions carried
    expect((r.map as Record<string, unknown>).dimensions).toEqual({ col: 256, row: 256, sec: 256 })
    expect((r.map as { voxel_size_angstrom: { x: unknown } }).voxel_size_angstrom.x).toEqual({
      value: 0.5332,
      units: 'Å'
    })
  })

  it('reports null resolution and empty fitted PDBs for a raw tomogram (pdb_list null)', async () => {
    const tomo = {
      emdb_id: 'EMD-3061',
      admin: { title: 'Tomogram', current_status: { code: { valueOf_: 'REL' } }, key_dates: {} },
      crossreferences: { pdb_list: null },
      sample: {},
      structure_determination_list: {
        structure_determination: [{ method: 'tomography', image_processing: [{}] }]
      },
      map: {}
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(tomo))
    const out = (await run('emdb_get_entries', { emdb_ids: ['3061'] }, fetchImpl)) as {
      records: Array<Record<string, unknown>>
    }
    const r = out.records[0]
    expect(r.method).toBe('tomography')
    expect(r.resolution_angstrom).toBeNull()
    expect(r.resolution_method).toBeNull()
    expect(r.fitted_pdb_ids).toEqual([])
    expect(r.has_fitted_model).toBe(false)
  })

  it('flags obsolete entries with is_obsolete + superseded_by', async () => {
    const obs = {
      emdb_id: 'EMD-1000',
      admin: {
        title: 'Old map',
        current_status: { code: { valueOf_: 'OBS' } },
        key_dates: { obsolete: '2021-01-05T00:00:00' },
        obsolete_list: { entry: [{ entry: 'EMD-2000', date: '2021-01-05T00:00:00' }] }
      },
      crossreferences: {},
      sample: {},
      structure_determination_list: {},
      map: {}
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(obs))
    const out = (await run('emdb_get_entries', { emdb_ids: ['EMD-1000'] }, fetchImpl)) as {
      records: Array<Record<string, unknown>>
    }
    const r = out.records[0]
    expect(r.is_obsolete).toBe(true)
    expect(r.superseded_by).toEqual(['EMD-2000'])
    expect(r.obsolete_date).toBe('2021-01-05')
  })

  it('tags an unknown accession as not_found instead of dropping it', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(url.includes('EMD-11638') ? jsonRes(relEntry) : errRes(404))
      )
    const out = (await run(
      'emdb_get_entries',
      { emdb_ids: ['EMD-11638', 'EMD-99999999'] },
      fetchImpl
    )) as {
      records: Array<Record<string, unknown>>
    }
    expect(out.records).toHaveLength(2)
    expect(out.records[0].emdb_id).toBe('EMD-11638')
    expect(out.records[1]).toEqual({ emdb_id: 'EMD-99999999', error: 'not_found' })
  })
})

describe('emdb_search_entries', () => {
  const FL =
    'emdb_id,title,resolution,structure_determination_method,fitted_pdbs,current_status,release_date'
  const header = FL
  const relRow = (n: number): string =>
    `EMD-${n},"Apoferritin, particle ${n}",1.9,singleParticle,,REL,2024-01-01T00:00:00Z`

  it('sweeps all pages, verifies released count, splits status, sorts by accession', async () => {
    // page 1: 200 released rows (EMD-201 .. EMD-2 in reverse to test sorting); page 2: 1 obsolete row.
    const page1 = [header, ...Array.from({ length: 200 }, (_, i) => relRow(201 - i))].join('\n')
    const page2 = [header, 'EMD-1,Superseded map,,helical,,OBS,2010-01-01T00:00:00Z'].join('\n')
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/facet/')) return Promise.resolve(jsonRes({ current_status: { rel: 200 } }))
      if (url.includes('page=1')) return Promise.resolve(textRes(page1))
      if (url.includes('page=2')) return Promise.resolve(textRes(page2))
      return Promise.resolve(textRes(header))
    })
    const out = (await run(
      'emdb_search_entries',
      { query: 'title:"apoferritin" AND resolution:[0 TO 1.5]', max_rows: 1000 },
      fetchImpl
    )) as {
      num_found_released: number
      rows_retrieved: number
      rows_by_status: Record<string, number>
      released_complete: boolean
      records: Array<Record<string, string>>
      max_rows: number
    }
    // search URL is compact CSV (wt=csv) with the fl field list, query encoded.
    const searchUrl = String(
      fetchImpl.mock.calls.find((c) => String(c[0]).includes('/search/'))![0]
    )
    expect(searchUrl).toContain('wt=csv')
    expect(searchUrl).toContain('fl=emdb_id%2Ctitle')
    expect(searchUrl).toContain(encodeURIComponent('title:"apoferritin"'))
    expect(out.num_found_released).toBe(200)
    expect(out.rows_retrieved).toBe(201)
    expect(out.rows_by_status).toEqual({ OBS: 1, REL: 200 })
    expect(out.released_complete).toBe(true)
    expect(out.max_rows).toBe(1000)
    // sorted by EMD accession number ascending; the quoted comma-bearing title survives CSV parsing.
    expect(out.records[0].emdb_id).toBe('EMD-1')
    expect(out.records[1].emdb_id).toBe('EMD-2')
    expect(out.records[out.records.length - 1].emdb_id).toBe('EMD-201')
    expect(out.records[1].title).toBe('Apoferritin, particle 2')
  })

  it('marks released_complete=false when retrieved REL rows fall short of the facet count', async () => {
    const page1 = [header, relRow(5), relRow(6), relRow(7)].join('\n')
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/facet/')) return Promise.resolve(jsonRes({ current_status: { rel: 9 } }))
      if (url.includes('page=1')) return Promise.resolve(textRes(page1))
      return Promise.resolve(textRes(header))
    })
    const out = (await run('emdb_search_entries', { query: 'title:"x"' }, fetchImpl)) as {
      num_found_released: number
      rows_retrieved: number
      released_complete: boolean
    }
    expect(out.num_found_released).toBe(9)
    expect(out.rows_retrieved).toBe(3)
    expect(out.released_complete).toBe(false)
  })
})

describe('emdb_get_entry_section', () => {
  it('publications: ordered authors + external references', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(relEntry))
    const out = (await run(
      'emdb_get_entry_section',
      { emdb_ids: ['EMD-11638'], section: 'publications' },
      fetchImpl
    )) as { section: string; records: Array<Record<string, unknown>> }
    expect(out.section).toBe('publications')
    const pub = out.records[0].primary_citation as Record<string, unknown>
    // authors sorted by `order` (Nakane order 1 before Second A order 2)
    expect((pub.authors as Array<{ name: string }>).map((a) => a.name)).toEqual([
      'Nakane T',
      'Second A'
    ])
    expect(pub.external_references).toEqual({
      doi: '10.1038/s41586-020-2829-0',
      pmid: '33087931',
      issn: '1476-4687',
      csd: '0006'
    })
  })

  it('map: dimensions, unit-wrapped pixel spacing, contour levels, space group', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(relEntry))
    const out = (await run(
      'emdb_get_entry_section',
      { emdb_ids: ['EMD-11638'], section: 'map' },
      fetchImpl
    )) as { records: Array<Record<string, unknown>> }
    const m = out.records[0]
    expect(m.format).toBe('CCP4')
    expect(m.dimensions).toEqual({ col: 256, row: 256, sec: 256 })
    expect((m.pixel_spacing_angstrom as { x: unknown }).x).toEqual({ value: 0.5332, units: 'Å' })
    expect(m.contour_levels).toEqual([{ level: 0.116, primary: true, source: 'AUTHOR' }])
    expect(m.space_group).toBe(1)
  })

  it('sample: per-macromolecule weight, EC number, source organism taxid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(relEntry))
    const out = (await run(
      'emdb_get_entry_section',
      { emdb_ids: ['EMD-11638'], section: 'sample' },
      fetchImpl
    )) as { records: Array<Record<string, unknown>> }
    const mm = (out.records[0].macromolecules as Array<Record<string, unknown>>)[0]
    expect(mm.name).toBe('Ferritin heavy chain')
    expect(mm.number_of_copies).toBe(24)
    expect(mm.ec_number).toEqual(['1.16.3.1'])
    expect(mm.natural_source).toEqual({ organism: 'Mus musculus', ncbi_taxid: 10090 })
    expect(mm.molecular_weight).toEqual({ theoretical: { value: 0.020079594, units: 'MDa' } })
  })

  it('imaging: microscopy session with voltage and image recordings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(relEntry))
    const out = (await run(
      'emdb_get_entry_section',
      { emdb_ids: ['EMD-11638'], section: 'imaging' },
      fetchImpl
    )) as { records: Array<Record<string, unknown>> }
    const rec = out.records[0]
    expect(rec.method).toBe('singleParticle')
    const session = (rec.microscopy as Array<Record<string, unknown>>)[0]
    expect(session.microscope).toBe('FEI TITAN KRIOS')
    expect(session.acceleration_voltage).toEqual({ value: 300, units: 'kV' })
    expect(session.nominal_magnification).toBe(75000)
    const recording = (session.image_recordings as Array<Record<string, unknown>>)[0]
    expect(recording.detector).toBe('FEI FALCON III (4k x 4k)')
  })

  it('rejects an unknown section name', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('emdb_get_entry_section', { emdb_ids: ['EMD-1'], section: 'nope' }, fetchImpl)
    ).rejects.toThrow(/unknown section/)
  })

  it('tags an unknown accession as not_found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(404))
    const out = (await run(
      'emdb_get_entry_section',
      { emdb_ids: ['EMD-99999999'], section: 'map' },
      fetchImpl
    )) as { records: Array<Record<string, unknown>> }
    expect(out.records[0]).toEqual({ emdb_id: 'EMD-99999999', error: 'not_found' })
  })
})

describe('emdb_get_validation', () => {
  const analysis = {
    '11638': {
      resolution: { value: 1.22 },
      qscore: { allmodels_average_qscore: 0.911 },
      atom_inclusion_by_level: { average_ai_allmodels: 0.98 },
      recommended_contour_level: { level: 0.116 },
      model_volume: { value: 1234 },
      // a non-object scalar block must be normalized to null
      surfaces: 'not-an-object'
    }
  }

  it('extracts numeric metrics, lists available_blocks, normalizes scalar blocks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(analysis))
    const out = (await run('emdb_get_validation', { emdb_ids: ['EMD-11638'] }, fetchImpl)) as {
      records: Array<Record<string, unknown>>
    }
    const r = out.records[0]
    expect(r.emdb_id).toBe('EMD-11638')
    expect(r.has_validation_analysis).toBe(true)
    expect(r.resolution_angstrom).toBe(1.22)
    expect(r.qscore_average).toBe(0.911)
    expect(r.atom_inclusion_average).toBe(0.98)
    expect(r.available_blocks).toEqual([
      'atom_inclusion_by_level',
      'model_volume',
      'qscore',
      'recommended_contour_level',
      'resolution',
      'surfaces'
    ])
    expect(r.recommended_contour_level).toEqual({ level: 0.116 })
    expect(r.model_volume).toEqual({ value: 1234 })
    // present-but-non-object block -> null
    expect(r.surfaces).toBeNull()
    // block the payload never carried -> null
    expect(r.mask_volume).toBeNull()
  })

  it('reports has_validation_analysis=false for an empty/sparse payload, never dropped', async () => {
    // route returns 200 with no entry for the accession key -> inner {} -> false, explicit nulls.
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({}))
    const out = (await run('emdb_get_validation', { emdb_ids: ['EMD-3061'] }, fetchImpl)) as {
      records: Array<Record<string, unknown>>
    }
    const r = out.records[0]
    expect(r.emdb_id).toBe('EMD-3061')
    expect(r.has_validation_analysis).toBe(false)
    expect(r.resolution_angstrom).toBeNull()
    expect(r.available_blocks).toEqual([])
  })

  it('tags a 404 accession as not_found with has_validation_analysis=false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(404))
    const out = (await run('emdb_get_validation', { emdb_ids: ['EMD-99999999'] }, fetchImpl)) as {
      records: Array<Record<string, unknown>>
    }
    expect(out.records[0]).toEqual({
      emdb_id: 'EMD-99999999',
      has_validation_analysis: false,
      error: 'not_found'
    })
  })
})
