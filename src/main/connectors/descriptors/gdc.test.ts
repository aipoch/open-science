import { describe, expect, it, vi, type Mock } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ToolDescriptor } from '../types'
import { ParserEngine } from '../engine'
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
