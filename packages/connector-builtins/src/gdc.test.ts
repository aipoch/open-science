import { describe, expect, it, vi, type Mock } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { ParserEngine } from '@aipoch/connector-core'
import { GDC_TOOLS } from './gdc'

const tool = (id: string): ToolDescriptor => GDC_TOOLS.find((item) => item.id === id)!
const ajv = new Ajv2020({ strict: true })
const validators = new Map(GDC_TOOLS.map((item) => [item.id, ajv.compile(item.input)]))

function setup(
  payload: unknown,
  status = 200
): {
  fetchImpl: Mock<typeof fetch>
  call: (id: string, args: Record<string, unknown>) => Promise<unknown>
} {
  const fetchImpl = vi.fn<typeof fetch>(
    async () =>
      new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status })
  )
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  return {
    fetchImpl,
    call: (id, args) => {
      if (!validators.get(id)!(args)) throw new Error('invalid_arguments')
      return engine.call(tool(id), args, {})
    }
  }
}

const paged = (
  hits: unknown[],
  total = hits.length
): { data: { hits: unknown[]; pagination: { total: number } } } => ({
  data: { hits, pagination: { total } }
})

describe('GDC tool input contracts', () => {
  it.each([
    ['gdc_search_files', { access: 'private' }],
    ['gdc_search_files', { page: 0 }],
    ['gdc_list_projects', { page: 10001 }],
    ['gdc_list_cases', { page: 10001 }],
    ['gdc_search_files', { page: 10001 }],
    ['gdc_search_files', { page_size: 101 }],
    ['gdc_list_projects', { project_ids: [] }],
    ['gdc_list_cases', { case_ids: [''] }],
    ['gdc_get_file', { file_id: 'not-a-uuid' }],
    ['gdc_get_manifest', { file_ids: [] }],
    ['gdc_get_manifest', { file_ids: ['not-a-uuid'] }]
  ])('rejects invalid %s arguments before HTTP: %j', (id, args) => {
    const { call, fetchImpl } = setup(paged([]))
    expect(() => call(id, args)).toThrow(/invalid_arguments/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe.each(['gdc_list_projects', 'gdc_list_cases', 'gdc_search_files'])(
  '%s pagination boundary',
  (id) => {
    const hit = {
      project_id: 'TCGA-BRCA',
      case_id: '57a1604c-60b7-4b30-a75e-f70939532c5c',
      file_id: '757ee75b-674e-49a5-8ba0-cc1b574a51ae',
      access: 'open'
    }

    it('returns a schema-valid next page immediately before the limit', async () => {
      const { call } = setup(paged([hit], 10001))
      const result = (await call(id, { page: 9999, page_size: 1 })) as {
        next_page: number
      }
      expect(result.next_page).toBe(10000)
      expect(validators.get(id)!({ page: result.next_page, page_size: 1 })).toBe(true)
    })

    it('stops at the page limit while preserving the larger upstream total', async () => {
      const { call, fetchImpl } = setup(paged([hit], 10001))
      await expect(call(id, { page: 10000, page_size: 1 })).resolves.toMatchObject({
        page: 10000,
        returned: 1,
        total: 10001,
        total_relation: 'eq',
        next_page: null
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
        from: 9999,
        size: 1
      })
    })

    it('still stops at the last result before the page limit', async () => {
      const { call } = setup(paged([hit], 2))
      await expect(call(id, { page: 2, page_size: 1 })).resolves.toMatchObject({
        total: 2,
        next_page: null
      })
    })
  }
)

describe('gdc_list_projects', () => {
  it('posts bounded filters and normalizes project summaries', async () => {
    const { call, fetchImpl } = setup(
      paged(
        [
          {
            project_id: 'TCGA-BRCA',
            name: 'Breast Invasive Carcinoma',
            program: [{ name: 'TCGA' }],
            disease_type: 'Breast Invasive Carcinoma',
            primary_site: 'Breast',
            state: 'current',
            summary: { case_count: 1098, file_count: 20000 }
          }
        ],
        3
      )
    )
    const out = await call('gdc_list_projects', {
      project_ids: ['TCGA-BRCA'],
      disease_type: 'Breast Invasive Carcinoma',
      page: 2,
      page_size: 1
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new URL(String(fetchImpl.mock.calls[0][0])).pathname).toBe('/projects')
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.filters).toEqual({
      op: 'and',
      content: [
        { op: 'in', content: { field: 'project_id', value: ['TCGA-BRCA'] } },
        {
          op: 'in',
          content: { field: 'disease_type', value: ['Breast Invasive Carcinoma'] }
        }
      ]
    })
    expect(body).toMatchObject({ from: 1, size: 1, format: 'JSON' })
    expect(out).toMatchObject({
      page: 2,
      page_size: 1,
      returned: 1,
      total: 3,
      next_page: 3,
      projects: [
        {
          project_id: 'TCGA-BRCA',
          program: 'TCGA',
          case_count: 1098,
          file_count: 20000
        }
      ]
    })
  })

  it('accepts the flattened related-field form for program.name', async () => {
    const { call } = setup(paged([{ project_id: 'TARGET-NBL', 'program.name': 'TARGET' }]))
    await expect(call('gdc_list_projects', {})).resolves.toMatchObject({
      projects: [{ project_id: 'TARGET-NBL', program: 'TARGET' }]
    })
  })
})

describe('gdc_list_cases', () => {
  it('normalizes project fields returned as nested objects', async () => {
    const { call } = setup(
      paged([
        {
          case_id: 'case-1',
          submitter_id: 'TCGA-XX-0001',
          project: { project_id: 'TCGA-BRCA', name: 'Breast Invasive Carcinoma' },
          disease_type: 'Breast Invasive Carcinoma',
          primary_site: 'Breast'
        }
      ])
    )
    await expect(call('gdc_list_cases', { project_ids: 'TCGA-BRCA' })).resolves.toMatchObject({
      cases: [
        {
          case_id: 'case-1',
          submitter_id: 'TCGA-XX-0001',
          project_id: 'TCGA-BRCA',
          project_name: 'Breast Invasive Carcinoma'
        }
      ]
    })
  })
})

describe('gdc_search_files', () => {
  it('keeps open and controlled access explicit and never promises controlled download', async () => {
    const { call } = setup(
      paged([
        {
          file_id: 'cb92f61d-041c-4424-a3e9-891b7545f351',
          file_name: 'open.maf.gz',
          file_size: 12,
          md5sum: 'abc',
          data_format: 'MAF',
          data_type: 'Masked Somatic Mutation',
          data_category: 'Simple Nucleotide Variation',
          access: 'open',
          state: 'released',
          'cases.project.project_id': 'TCGA-BRCA'
        },
        {
          file_id: 'fd89bfa5-b3a7-4079-bf90-709580c006e5',
          file_name: 'controlled.bam',
          access: 'controlled',
          'cases.project.project_id': 'TCGA-BRCA'
        }
      ])
    )
    const out = (await call('gdc_search_files', { project_ids: 'TCGA-BRCA' })) as Record<
      string,
      unknown
    >
    expect(out.access_summary).toEqual({ open: 1, controlled: 1, unknown: 0 })
    expect(out.controlled_files_require_authorization).toBe(true)
    expect(out.download_note).toMatch(/does not guarantee.*download/i)
    expect(out.files).toEqual([
      expect.objectContaining({
        access: 'open',
        download_url: 'https://api.gdc.cancer.gov/data/cb92f61d-041c-4424-a3e9-891b7545f351',
        download_requires_authentication: false,
        download_status: 'available_without_authentication'
      }),
      expect.objectContaining({
        access: 'controlled',
        download_url: null,
        download_requires_authentication: true,
        download_status: 'requires_authorization'
      })
    ])
  })
})

describe('gdc_get_file', () => {
  it.each(['open', 'controlled'])(
    'requests related fields and preserves %s access in a single file response',
    async (access) => {
      const { call, fetchImpl } = setup({
        data: {
          file_id: 'fd89bfa5-b3a7-4079-bf90-709580c006e5',
          file_name: 'controlled.bam',
          access,
          state: 'released',
          cases: [{ project: { project_id: 'TCGA-BRCA' } }]
        }
      })
      await expect(
        call('gdc_get_file', { file_id: 'fd89bfa5-b3a7-4079-bf90-709580c006e5' })
      ).resolves.toMatchObject({
        file: {
          file_id: 'fd89bfa5-b3a7-4079-bf90-709580c006e5',
          project_id: 'TCGA-BRCA',
          access,
          download_url:
            access === 'open'
              ? 'https://api.gdc.cancer.gov/data/fd89bfa5-b3a7-4079-bf90-709580c006e5'
              : null,
          download_requires_authentication: access === 'controlled'
        }
      })
      const url = new URL(String(fetchImpl.mock.calls[0][0]))
      expect(url.pathname).toBe('/files/fd89bfa5-b3a7-4079-bf90-709580c006e5')
      expect(url.searchParams.get('fields')?.split(',')).toEqual(
        expect.arrayContaining(['file_id', 'access', 'cases.project.project_id'])
      )
    }
  )

  it('propagates an upstream error instead of turning it into an empty result', async () => {
    await expect(
      setup({ message: 'missing' }, 404).call('gdc_get_file', {
        file_id: 'cb92f61d-041c-4424-a3e9-891b7545f351'
      })
    ).rejects.toThrow('HTTP 404')
  })
})

describe('gdc_get_manifest', () => {
  it('propagates a missing-file error instead of returning a successful manifest', async () => {
    await expect(
      setup({ message: 'not found' }, 404).call('gdc_get_manifest', {
        file_ids: ['00000000-0000-4000-8000-000000000000']
      })
    ).rejects.toThrow('HTTP 404')
  })

  it('requests a manifest without treating it as a file download', async () => {
    const { call, fetchImpl } = setup('id\tfilename\n')
    const out = await call('gdc_get_manifest', {
      file_ids: ['cb92f61d-041c-4424-a3e9-891b7545f351', 'fd89bfa5-b3a7-4079-bf90-709580c006e5']
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://api.gdc.cancer.gov/v0/manifest/cb92f61d-041c-4424-a3e9-891b7545f351,fd89bfa5-b3a7-4079-bf90-709580c006e5'
    )
    expect(out).toMatchObject({
      file_ids: ['cb92f61d-041c-4424-a3e9-891b7545f351', 'fd89bfa5-b3a7-4079-bf90-709580c006e5'],
      manifest: 'id\tfilename\n',
      download_note: expect.stringMatching(/inventory.*not a download/i)
    })
  })
})

// Representative relationship shapes observed on the public GDC /cases and /files
// endpoints for case 1e5c5b1b-3450-4a1f-9e92-bf522b47f23f. A file response is
// pruned to its own sample/aliquot paths, unlike the case biospecimen inventory.
const biospecimen = (
  id: string,
  type: string,
  aliquots: string[]
): {
  sample_id: string
  submitter_id: string
  sample_type: string
  tissue_type: string
  tumor_descriptor: string
  portions: {
    portion_id: string
    analytes: {
      analyte_id: string
      aliquots: { aliquot_id: string; submitter_id: string }[]
    }[]
  }[]
} => ({
  sample_id: id,
  submitter_id: `sample-${id}`,
  sample_type: type,
  tissue_type: type === 'Primary Tumor' ? 'Tumor' : 'Normal',
  tumor_descriptor: 'Not Reported',
  portions: [
    {
      portion_id: `portion-${id}`,
      analytes: [
        {
          analyte_id: `analyte-${id}`,
          aliquots: aliquots.map((aliquot_id) => ({
            aliquot_id,
            submitter_id: `aliquot-${aliquot_id}`
          }))
        }
      ]
    }
  ]
})
const fileId = 'ca3dad26-e33b-4361-be4a-a074a344a757'

describe('GDC biospecimen relationships', () => {
  it('returns case biospecimens without treating them as file sources', async () => {
    const { call, fetchImpl } = setup(
      paged([
        {
          case_id: 'case-1',
          samples: [
            biospecimen('normal', 'Blood Derived Normal', ['n']),
            biospecimen('tumor', 'Primary Tumor', ['t1', 't2'])
          ]
        }
      ])
    )
    const result = await call('gdc_list_cases', { case_ids: 'case-1' })
    expect(result).toMatchObject({
      cases: [
        {
          samples: [
            { sample_id: 'normal', aliquots: [{ aliquot_id: 'n' }] },
            { sample_id: 'tumor', aliquots: [{ aliquot_id: 't1' }, { aliquot_id: 't2' }] }
          ]
        }
      ]
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.fields.split(',')).toContain('samples.portions.analytes.aliquots.aliquot_id')
  })

  it.each(['gdc_search_files', 'gdc_get_file'])(
    'preserves only file-linked sample/aliquot paths in %s',
    async (id) => {
      const hit = {
        file_id: fileId,
        cases: [{ case_id: 'case-1', samples: [biospecimen('tumor', 'Primary Tumor', ['t2'])] }],
        analysis: {
          analysis_id: 'analysis-1',
          workflow_type: 'STAR - Counts',
          workflow_version: 'v1',
          workflow_link: 'https://example.org/workflow'
        }
      }
      const { call, fetchImpl } = setup(id === 'gdc_get_file' ? { data: hit } : paged([hit]))
      const out = (await call(id, id === 'gdc_get_file' ? { file_id: fileId } : {})) as {
        file: Record<string, unknown>
        files: Record<string, unknown>[]
      }
      const result = id === 'gdc_get_file' ? out.file : out.files[0]
      expect(result.cases).toEqual([
        {
          case_id: 'case-1',
          submitter_id: null,
          project_id: null,
          samples: [
            {
              sample_id: 'tumor',
              submitter_id: 'sample-tumor',
              sample_type: 'Primary Tumor',
              tissue_type: 'Tumor',
              tumor_descriptor: 'Not Reported',
              aliquots: [
                {
                  aliquot_id: 't2',
                  submitter_id: 'aliquot-t2',
                  portion_id: 'portion-tumor',
                  analyte_id: 'analyte-tumor'
                }
              ]
            }
          ]
        }
      ])
      expect(result.analysis).toEqual(hit.analysis)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const fields =
        id === 'gdc_get_file'
          ? new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('fields')!
          : JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).fields
      for (const field of [
        'cases.samples.sample_type',
        'cases.samples.portions.analytes.aliquots.aliquot_id',
        'analysis.workflow_type'
      ]) {
        expect(fields.split(',')).toContain(field)
      }
    }
  )

  it('keeps paired samples and multiple cases rather than selecting the first source', async () => {
    const { call } = setup(
      paged([
        {
          file_id: fileId,
          cases: [
            {
              case_id: 'case-1',
              samples: [
                biospecimen('normal', 'Blood Derived Normal', ['n']),
                biospecimen('tumor', 'Primary Tumor', ['t'])
              ]
            },
            { case_id: 'case-2', samples: [biospecimen('other', 'Primary Tumor', ['o1', 'o2'])] }
          ]
        }
      ])
    )
    const out = (await call('gdc_search_files', { sample_types: 'Primary Tumor' })) as {
      files: {
        cases: { case_id: string; samples: { sample_id: string; aliquots: unknown[] }[] }[]
      }[]
    }
    expect(out.files[0].cases.map((item) => item.case_id)).toEqual(['case-1', 'case-2'])
    expect(out.files[0].cases[0].samples.map((item) => item.sample_id)).toEqual(['normal', 'tumor'])
    expect(out.files[0].cases[1].samples[0].aliquots).toHaveLength(2)
  })

  it.each(['gdc_list_cases', 'gdc_search_files', 'gdc_get_file'])(
    'preserves every portion/analyte branch and its aliquot ownership in %s',
    async (id) => {
      const sample = biospecimen('tumor', 'Primary Tumor', ['a1', 'a2'])
      sample.portions[0].analytes.push({
        analyte_id: 'analyte-b',
        aliquots: [{ aliquot_id: 'b1', submitter_id: 'aliquot-b1' }]
      })
      sample.portions.push({
        portion_id: 'portion-b',
        analytes: [
          { analyte_id: 'empty', aliquots: [] },
          { analyte_id: 'analyte-c', aliquots: [{ aliquot_id: 'c1', submitter_id: 'aliquot-c1' }] }
        ]
      })
      const caseRecord = { case_id: 'case-1', samples: [sample] }
      const hit = id === 'gdc_list_cases' ? caseRecord : { file_id: fileId, cases: [caseRecord] }
      const { call } = setup(id === 'gdc_get_file' ? { data: hit } : paged([hit]))
      const result = (await call(id, id === 'gdc_get_file' ? { file_id: fileId } : {})) as {
        cases: { samples: { aliquots: unknown[] }[] }[]
        files: { cases: { samples: { aliquots: unknown[] }[] }[] }[]
        file: { cases: { samples: { aliquots: unknown[] }[] }[] }
      }
      const cases =
        id === 'gdc_list_cases'
          ? result.cases
          : id === 'gdc_get_file'
            ? result.file.cases
            : result.files[0].cases
      expect(cases[0].samples[0].aliquots).toEqual([
        {
          aliquot_id: 'a1',
          submitter_id: 'aliquot-a1',
          portion_id: 'portion-tumor',
          analyte_id: 'analyte-tumor'
        },
        {
          aliquot_id: 'a2',
          submitter_id: 'aliquot-a2',
          portion_id: 'portion-tumor',
          analyte_id: 'analyte-tumor'
        },
        {
          aliquot_id: 'b1',
          submitter_id: 'aliquot-b1',
          portion_id: 'portion-tumor',
          analyte_id: 'analyte-b'
        },
        {
          aliquot_id: 'c1',
          submitter_id: 'aliquot-c1',
          portion_id: 'portion-b',
          analyte_id: 'analyte-c'
        }
      ])
    }
  )

  it.each(['gdc_search_files', 'gdc_get_file'])(
    'keeps a real file source distinct from previously queried case inventory in %s',
    async (id) => {
      // IDs and relationship sets recorded from public GDC responses: the case has
      // three samples and six aliquots; this RNA file has one sample and one aliquot.
      const caseId = '1e5c5b1b-3450-4a1f-9e92-bf522b47f23f'
      const tumorId = '2be962e7-74f4-49f7-ae34-9080de3ef820'
      const linkedAliquot = '89b8448a-02ed-45c9-9838-b41e58a9dfbe'
      const caseRecord = {
        case_id: caseId,
        samples: [
          biospecimen('0a9473b0-857c-4592-bd9d-4b5479b9ec6b', 'Blood Derived Normal', [
            '39fbddfe-218a-4a59-865e-4e4d45f136f7'
          ]),
          biospecimen('1ee05c6a-bb23-4742-86f2-610029662392', 'Solid Tissue Normal', [
            'c5ede38f-0c34-4e5f-95cf-44f405b7eded'
          ]),
          biospecimen(tumorId, 'Primary Tumor', [
            '2b4ed2f5-3749-4f67-a8de-ac49107ebfa8',
            linkedAliquot,
            'b2031366-1cc1-48f4-a4d2-8754ad806cb6',
            'd30ab124-bcd9-49ba-bf31-10a7bfa5cfdb'
          ])
        ]
      }
      const hit = {
        file_id: fileId,
        cases: [
          { case_id: caseId, samples: [biospecimen(tumorId, 'Primary Tumor', [linkedAliquot])] }
        ]
      }
      const { call, fetchImpl } = setup(paged([caseRecord]))
      await call('gdc_list_cases', { case_ids: caseId })
      fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify(id === 'gdc_get_file' ? { data: hit } : paged([hit])))
      )
      const result = (await call(
        id,
        id === 'gdc_get_file' ? { file_id: fileId } : { case_ids: caseId }
      )) as {
        file: {
          cases: {
            case_id: string
            samples: { sample_id: string; aliquots: { aliquot_id: string }[] }[]
          }[]
        }
        files: {
          cases: {
            case_id: string
            samples: { sample_id: string; aliquots: { aliquot_id: string }[] }[]
          }[]
        }[]
      }
      const file = id === 'gdc_get_file' ? result.file : result.files[0]
      expect(
        file.cases.map((item) => ({
          case_id: item.case_id,
          samples: item.samples.map((sample) => ({
            sample_id: sample.sample_id,
            aliquots: sample.aliquots.map((aliquot) => aliquot.aliquot_id)
          }))
        }))
      ).toEqual([{ case_id: caseId, samples: [{ sample_id: tumorId, aliquots: [linkedAliquot] }] }])
      expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        '/cases',
        id === 'gdc_get_file' ? `/files/${fileId}` : '/files'
      ])
    }
  )

  it('does not invent sample relationships or workflow metadata when omitted', async () => {
    const { call } = setup(
      paged([{ file_id: fileId, cases: [{ case_id: 'case-only' }] }, { file_id: fileId }])
    )
    await expect(call('gdc_search_files', {})).resolves.toMatchObject({
      files: [
        { cases: [{ case_id: 'case-only', samples: [] }], analysis: null },
        { cases: [], analysis: null }
      ]
    })
  })

  it.each(['samples', 'portions', 'analytes', 'aliquots'])(
    'rejects malformed %s relationships',
    async (field) => {
      const sample = biospecimen('tumor', 'Primary Tumor', ['t'])
      const targets: Record<string, Record<string, unknown>> = {
        samples: {},
        portions: sample,
        analytes: sample.portions[0],
        aliquots: sample.portions[0].analytes[0]
      }
      const caseRecord = { samples: [sample] } as Record<string, unknown>
      targets.samples = caseRecord
      targets[field][field] = {}
      const { call } = setup(paged([{ file_id: fileId, cases: [caseRecord] }]))
      await expect(call('gdc_search_files', {})).rejects.toThrow(/Invalid GDC/)
    }
  )
})

describe('GDC file filters', () => {
  it.each(['case_ids', 'sample_types', 'workflow_types'])(
    'rejects invalid %s before HTTP',
    (name) => {
      const { call, fetchImpl } = setup(paged([]))
      for (const value of [[], [''], Array(101).fill('x'), 1, 'x'.repeat(201)]) {
        expect(() => call('gdc_search_files', { [name]: value })).toThrow('invalid_arguments')
      }
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'combines case, sample and workflow filters with existing filters (arrays=%s)',
    async (asArrays) => {
      const { call, fetchImpl } = setup(paged([]))
      await call('gdc_search_files', {
        project_ids: 'TCGA-BRCA',
        access: 'open',
        case_ids: asArrays ? ['case-1', 'case-2'] : 'case-1',
        sample_types: asArrays ? ['Primary Tumor', 'Solid Tissue Normal'] : 'Primary Tumor',
        workflow_types: asArrays ? ['STAR - Counts', 'HTSeq - Counts'] : 'STAR - Counts',
        page: 2,
        page_size: 3
      })
      const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
      expect(body).toMatchObject({ from: 3, size: 3 })
      expect(body.filters).toEqual({
        op: 'and',
        content: [
          { op: 'in', content: { field: 'cases.project.project_id', value: ['TCGA-BRCA'] } },
          {
            op: 'in',
            content: { field: 'cases.case_id', value: asArrays ? ['case-1', 'case-2'] : ['case-1'] }
          },
          {
            op: 'in',
            content: {
              field: 'cases.samples.sample_type',
              value: asArrays ? ['Primary Tumor', 'Solid Tissue Normal'] : ['Primary Tumor']
            }
          },
          {
            op: 'in',
            content: {
              field: 'analysis.workflow_type',
              value: asArrays ? ['STAR - Counts', 'HTSeq - Counts'] : ['STAR - Counts']
            }
          },
          { op: 'in', content: { field: 'files.access', value: ['open'] } }
        ]
      })
    }
  )
})
