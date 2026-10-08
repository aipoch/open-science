import { describe, expect, it, vi } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { ParserEngine } from '../engine'
import { PDC_TOOLS } from './pdc'

const ajv = new Ajv2020({ strict: true })
const validators = new Map(PDC_TOOLS.map((tool) => [tool.id, ajv.compile(tool.input)]))
const studyId = 'dbe94609-1fb3-11e9-b7f8-0a80fada099c'
const selector = { pdc_study_id: 'PDC000127' }
const study = { study_id: studyId, ...selector, study_name: 'CCRCC Proteome' }
const version = {
  study_id: studyId,
  study_shortname: 'CCRCC Proteome',
  study_version: '1',
  is_latest_version: 'yes'
}
const catalog = { ...selector, versions: [version] }
const file = {
  ...study,
  file_id: 'b5fe6d02-1b71-11e9-bd99-005056921935',
  file_size: '174131545',
  file_location: 'studies/127/reports/peptides.tsv',
  md5sum: '89def588cfaf10a31addb09e49bdef16'
}
const upstreamCase = (
  id: string,
  aliquots = 1
): {
  case_id: string
  case_submitter_id: string
  disease_type: string
  primary_site: string
  externalReferences: Record<string, string>[]
  samples: {
    sample_id: string
    sample_submitter_id: string
    sample_type: string
    status: string
    aliquots: Record<string, unknown>[]
  }[]
} => ({
  case_id: `case-${id}`,
  case_submitter_id: `case-submitter-${id}`,
  disease_type: 'Clear Cell Renal Cell Carcinoma',
  primary_site: 'Kidney',
  externalReferences: [
    { reference_resource_shortname: 'GDC', external_reference_id: `gdc-case-${id}` }
  ],
  samples: [
    {
      sample_id: `sample-${id}`,
      sample_submitter_id: `sample-submitter-${id}`,
      sample_type: 'Primary Tumor',
      status: 'Qualified',
      aliquots: Array.from({ length: aliquots }, (_, i) => ({
        aliquot_id: `aliquot-${id}-${i}`,
        aliquot_submitter_id: `aliquot-submitter-${id}-${i}`,
        sample_id: null,
        case_id: null,
        status: 'Qualified',
        pool: 'Yes'
      }))
    }
  ]
})
function setup(...responses: unknown[]): {
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
  call: (id: string, args: Record<string, unknown>) => Promise<unknown>
} {
  const fetchImpl = vi.fn<typeof fetch>()
  for (const payload of responses)
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(payload)))
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  return {
    fetchImpl,
    call: (id, args) => {
      if (!validators.get(id)!(args)) throw new Error('invalid_arguments')
      return engine.call(
        PDC_TOOLS.find((tool) => tool.id === id)!,
        args,
        {}
      )
    }
  }
}

describe('PDC input contracts', () => {
  it.each([
    ['pdc_search_studies', { query: '   ' }],
    ['pdc_search_studies', { limit: 101 }],
    ['pdc_search_studies', { offset: -1 }],
    ['pdc_search_studies', { offset: 1_000_001 }],
    ['pdc_search_studies', { limit: 1.5 }],
    ['pdc_search_studies', { url: 'https://example.com' }],
    ['pdc_get_study', {}],
    ['pdc_get_study', { ...selector, study_id: studyId }],
    ['pdc_get_study', { pdc_study_id: 'PDC000127\n' }],
    ['pdc_get_study', { study_id: 'not-a-uuid' }],
    ['pdc_list_biospecimens', { ...selector, acceptDUA: true }],
    ['pdc_list_biospecimens', { ...selector, pagination_mode: 'automatic' }],
    ['pdc_list_biospecimens', { ...selector, pagination_mode: 'upstream', limit: 101 }],
    ['pdc_list_files', { ...selector, pagination_mode: 'upstream' }],
    ['pdc_list_files', { ...selector, limit: '10' }],
    ['pdc_list_files', { ...selector, data_category: '' }]
  ])('rejects invalid %s input before HTTP', (id, args) => {
    const { call, fetchImpl } = setup()
    expect(() => call(id as string, args as Record<string, unknown>)).toThrow('invalid_arguments')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('PDC discovery', () => {
  it('filters names across versions, preserves all versions and pages sorted catalog locally', async () => {
    const old = { ...version, study_shortname: 'Older kidney assay', is_latest_version: 'no' }
    const { call, fetchImpl } = setup({
      data: {
        studyCatalog: [
          { pdc_study_id: 'PDC000200', versions: [old] },
          { ...catalog, versions: [version, old] },
          { pdc_study_id: 'PDC000001', versions: [{ ...version, study_shortname: 'Breast' }] }
        ]
      }
    })
    await expect(call('pdc_search_studies', { query: 'KIDNEY', limit: 1 })).resolves.toMatchObject({
      studies: [{ ...selector, versions: [version, old] }],
      total: 2,
      returned: 1,
      next_offset: 1,
      pagination_mode: 'local'
    })
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(fetchImpl.mock.calls[0][0]).toBe('https://pdc.cancer.gov/graphql')
    expect(request.query).not.toContain('KIDNEY')
    expect(request.query).not.toContain('acceptDUA')
  })

  it('pins study UUIDs and retrieves catalog using the returned accession', async () => {
    const { call, fetchImpl } = setup(
      { data: { study: [study] } },
      { data: { studyCatalog: [catalog] } }
    )
    await expect(call('pdc_get_study', { study_id: studyId })).resolves.toMatchObject({
      studies: [study],
      catalog: [catalog]
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).variables).toEqual({
      study_id: studyId
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).variables).toEqual({
      id: 'PDC000127'
    })
  })

  it.each([
    {
      failure: 'GraphQL partial data',
      response: {
        errors: [{ message: 'Catalog resolver failed' }],
        data: { studyCatalog: [catalog] }
      },
      message: 'PDC GraphQL error: Catalog resolver failed'
    },
    {
      failure: 'malformed catalog data',
      response: { data: { studyCatalog: null } },
      message: 'Invalid PDC response: expected a record list'
    }
  ])('rejects the whole study result on catalog $failure', async ({ response, message }) => {
    const { call, fetchImpl } = setup({ data: { study: [study] } }, response)

    await expect(call('pdc_get_study', { study_id: studyId })).rejects.toThrow(message)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).variables).toEqual({
      id: selector.pdc_study_id
    })
  })

  it('propagates a catalog network failure after the study query succeeds', async () => {
    const { call, fetchImpl } = setup({ data: { study: [study] } })
    const failure = new Error('Catalog network failure')
    fetchImpl.mockRejectedValueOnce(failure)

    await expect(call('pdc_get_study', { study_id: studyId })).rejects.toBe(failure)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).variables).toEqual({
      id: selector.pdc_study_id
    })
  })

  it('does not request a global catalog when the study is absent', async () => {
    const { call, fetchImpl } = setup({ data: { study: [] } })
    await expect(call('pdc_get_study', selector)).resolves.toMatchObject({
      studies: [],
      catalog: []
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('preserves many aliquots per sample, pool flags and resource-specific case references', async () => {
    const association = {
      case_id: 'pdc-case',
      case_submitter_id: 'C3L-00791',
      sample_id: 'sample',
      sample_submitter_id: 'C3L-00791-01',
      pool: 'Yes',
      externalReferences: [
        { reference_resource_shortname: 'GDC', external_reference_id: 'different-gdc-case' }
      ]
    }
    const a = { ...association, aliquot_id: 'a' }
    const b = { ...association, aliquot_id: 'b' }
    const { call, fetchImpl } = setup({ data: { biospecimenPerStudy: [b, a] } })
    await expect(
      call('pdc_list_biospecimens', { ...selector, offset: 1, limit: 1 })
    ).resolves.toMatchObject({
      biospecimens: [b],
      total: 2,
      returned: 1,
      next_offset: null,
      pagination_mode: 'local'
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.query).toContain('biospecimenPerStudy')
    expect(body.query).not.toContain('paginatedCasesSamplesAliquots')
    expect(body.variables).not.toHaveProperty('offset')
  })

  it.each([
    { count: 0, offset: 0, returned: 0 },
    { count: 999, offset: 900, returned: 99 },
    { count: 999, offset: 1000, returned: 0 }
  ])('keeps exact totals below the biospecimen cap: %j', async ({ count, offset, returned }) => {
    const records = Array.from({ length: count }, (_, i) => ({
      aliquot_id: `a${i}`,
      sample_id: `s${i}`,
      case_id: `c${i}`
    }))
    const { call } = setup({ data: { biospecimenPerStudy: records } })
    await expect(
      call('pdc_list_biospecimens', { ...selector, offset, limit: 100 })
    ).resolves.toMatchObject({
      total: count,
      available: count,
      returned,
      next_offset: null,
      upstream_limit_reached: false,
      truncated: false
    })
  })

  it.each([
    { offset: 0, returned: 100, next: 100 },
    { offset: 900, returned: 100, next: null },
    { offset: 1000, returned: 0, next: null }
  ])('never claims completeness at the biospecimen cap: %j', async ({ offset, returned, next }) => {
    const records = Array.from({ length: 1000 }, (_, i) => ({
      aliquot_id: `a${String(i).padStart(4, '0')}`,
      sample_id: `s${i}`,
      case_id: `c${i}`
    }))
    const { call, fetchImpl } = setup({ data: { biospecimenPerStudy: records } })
    const out = await call('pdc_list_biospecimens', { ...selector, offset, limit: 100 })
    expect(out).toMatchObject({
      total: null,
      available: 1000,
      returned,
      next_offset: next,
      upstream_limit_reached: true,
      truncated: true,
      pagination_mode: 'local'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).variables).toEqual(selector)
    if (offset === 900) expect(out).toHaveProperty('biospecimens.99.aliquot_id', 'a0999')
  })

  it('preserves explicit local biospecimen pagination', async () => {
    const record = { aliquot_id: 'a', sample_id: 's', case_id: 'c', taxon: 'Homo sapiens' }
    const { call, fetchImpl } = setup({ data: { biospecimenPerStudy: [record] } })
    await expect(
      call('pdc_list_biospecimens', { ...selector, pagination_mode: 'local' })
    ).resolves.toMatchObject({ biospecimens: [record], total: 1, pagination_mode: 'local' })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).variables).toEqual(selector)
  })

  it('pages upstream by cases beyond offset 1000 and reconstructs association IDs', async () => {
    const c = upstreamCase('selected', 2)
    c.samples.push(upstreamCase('another-sample').samples[0])
    const { call, fetchImpl } = setup({
      data: {
        paginatedCasesSamplesAliquots: {
          total: 2000,
          casesSamplesAliquots: [c, upstreamCase('lookahead')]
        }
      }
    })
    const out = await call('pdc_list_biospecimens', {
      study_id: studyId,
      pagination_mode: 'upstream',
      offset: 1001,
      limit: 1
    })
    expect(out).toMatchObject({
      total: null,
      available: 3,
      returned: 3,
      case_total: 2000,
      returned_cases: 1,
      offset: 1001,
      limit: 1,
      next_offset: 1002,
      has_more: true,
      upstream_limit_reached: false,
      truncated: false,
      pagination_mode: 'upstream',
      pagination_unit: 'case',
      unavailable_fields: ['case_status', 'project_name', 'taxon'],
      biospecimens: [
        {
          aliquot_id: 'aliquot-selected-0',
          sample_id: 'sample-selected',
          case_id: c.case_id,
          aliquot_submitter_id: 'aliquot-submitter-selected-0',
          sample_submitter_id: 'sample-submitter-selected',
          case_submitter_id: c.case_submitter_id,
          sample_status: 'Qualified',
          aliquot_status: 'Qualified',
          pool: 'Yes',
          case_status: null,
          project_name: null,
          taxon: null,
          externalReferences: c.externalReferences
        },
        { aliquot_id: 'aliquot-selected-1', case_id: c.case_id },
        {
          aliquot_id: 'aliquot-another-sample-0',
          sample_id: 'sample-another-sample',
          case_id: c.case_id
        }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.query).toContain('paginatedCasesSamplesAliquots')
    expect(body.variables).toEqual({ study_id: studyId, offset: 1001, limit: 2 })
  })

  it('does not truncate more than 1000 associations within a selected case', async () => {
    const { call } = setup({
      data: {
        paginatedCasesSamplesAliquots: {
          total: 1,
          casesSamplesAliquots: [upstreamCase('large', 1001)]
        }
      }
    })
    const out = await call('pdc_list_biospecimens', {
      ...selector,
      pagination_mode: 'upstream',
      limit: 1
    })
    expect(out).toMatchObject({
      returned: 1001,
      available: 1001,
      returned_cases: 1,
      case_total: 1,
      total: null,
      has_more: false,
      next_offset: null,
      truncated: false
    })
    expect(out).toHaveProperty('biospecimens.1000.aliquot_id', 'aliquot-large-1000')
  })

  it.each([
    { total: 0, offset: 0, cases: [] },
    { total: 124, offset: 124, cases: [] },
    { total: 124, offset: 120, cases: [upstreamCase('last')] }
  ])(
    'ends upstream case pagination without inventing association totals: %j',
    async ({ total, offset, cases }) => {
      const { call } = setup({
        data: { paginatedCasesSamplesAliquots: { total, casesSamplesAliquots: cases } }
      })
      await expect(
        call('pdc_list_biospecimens', {
          ...selector,
          pagination_mode: 'upstream',
          offset,
          limit: 10
        })
      ).resolves.toMatchObject({
        total: null,
        case_total: total,
        returned_cases: cases.length,
        has_more: false,
        next_offset: null,
        truncated: false
      })
    }
  )

  it('advances case pagination even when the selected case has no associations', async () => {
    const c = { ...upstreamCase('empty'), samples: [] }
    const { call } = setup({
      data: {
        paginatedCasesSamplesAliquots: { total: 2, casesSamplesAliquots: [c, upstreamCase('next')] }
      }
    })
    await expect(
      call('pdc_list_biospecimens', { ...selector, pagination_mode: 'upstream', limit: 1 })
    ).resolves.toMatchObject({
      biospecimens: [],
      returned: 0,
      returned_cases: 1,
      has_more: true,
      next_offset: 1
    })
  })

  it('marks the upstream case offset ceiling without returning an invalid continuation', async () => {
    const { call } = setup({
      data: {
        paginatedCasesSamplesAliquots: {
          total: 1_000_002,
          casesSamplesAliquots: [upstreamCase('last'), upstreamCase('next')]
        }
      }
    })
    await expect(
      call('pdc_list_biospecimens', {
        ...selector,
        pagination_mode: 'upstream',
        offset: 1_000_000,
        limit: 1
      })
    ).resolves.toMatchObject({ has_more: true, next_offset: null, truncated: true })
  })

  it.each([
    { total: null, casesSamplesAliquots: [] },
    { total: '2', casesSamplesAliquots: [] },
    { total: -1, casesSamplesAliquots: [] },
    { total: 1.5, casesSamplesAliquots: [] },
    { total: 1, casesSamplesAliquots: null },
    { total: 1, casesSamplesAliquots: [{}] },
    { total: 1, casesSamplesAliquots: [{ case_id: 'c', samples: null }] },
    { total: 1, casesSamplesAliquots: [{ case_id: 'c', samples: [{}] }] },
    {
      total: 1,
      casesSamplesAliquots: [{ case_id: 'c', samples: [{ sample_id: 's', aliquots: null }] }]
    },
    {
      total: 1,
      casesSamplesAliquots: [{ case_id: 'c', samples: [{ sample_id: 's', aliquots: [{}] }] }]
    },
    { total: 3, casesSamplesAliquots: [upstreamCase('a'), upstreamCase('b'), upstreamCase('c')] }
  ])(
    'rejects malformed upstream associations without falling back to capped data: %j',
    async (payload) => {
      const { call, fetchImpl } = setup({ data: { paginatedCasesSamplesAliquots: payload } })
      await expect(
        call('pdc_list_biospecimens', { ...selector, pagination_mode: 'upstream', limit: 1 })
      ).rejects.toThrow('Invalid PDC response')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects partial GraphQL data in upstream case mode without a local fallback', async () => {
    const { call, fetchImpl } = setup({
      errors: [{ message: 'Nested aliquot resolver failed' }],
      data: {
        paginatedCasesSamplesAliquots: { total: 1, casesSamplesAliquots: [upstreamCase('partial')] }
      }
    })
    await expect(
      call('pdc_list_biospecimens', { ...selector, pagination_mode: 'upstream' })
    ).rejects.toThrow('PDC GraphQL error: Nested aliquot resolver failed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps catalog totals exact at 1000 studies', async () => {
    const studies = Array.from({ length: 1000 }, (_, i) => ({
      pdc_study_id: `PDC${String(i).padStart(6, '0')}`,
      versions: [version]
    }))
    const { call } = setup({ data: { studyCatalog: studies } })
    await expect(call('pdc_search_studies', { offset: 900, limit: 100 })).resolves.toMatchObject({
      total: 1000,
      returned: 100,
      next_offset: null,
      truncated: false
    })
  })

  it.each([selector, { study_id: studyId }])(
    'omits absent file query variables for %j',
    async (selection) => {
      const { call, fetchImpl } = setup({ data: { filesPerStudy: [] } })
      await call('pdc_list_files', selection)
      expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).variables).toEqual({
        ...selection,
        offset: 0,
        limit: 21
      })
    }
  )

  it('uses variables for filters, preserves byte-count strings and uses one-record lookahead', async () => {
    const { call, fetchImpl } = setup({
      data: { filesPerStudy: [file, { ...file, file_id: 'second' }] }
    })
    const name = 'a" ) { signedUrl {url} } #'
    const out = await call('pdc_list_files', {
      ...selector,
      file_name: name,
      data_category: 'Protein Assembly',
      offset: 2,
      limit: 1
    })
    expect(out).toMatchObject({
      files: [file],
      total: null,
      has_more: true,
      next_offset: 3,
      returned: 1,
      pagination_mode: 'upstream'
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.variables).toMatchObject({
      file_name: name,
      offset: 2,
      limit: 2,
      data_category: 'Protein Assembly'
    })
    expect(body.query).not.toContain(name)
    expect(body.query).not.toContain('signedUrl')
    expect(body.query).not.toContain('acceptDUA')
    expect(out).not.toHaveProperty('download_url')
  })

  it.each([{ files: [] }, { files: [file] }])(
    'ends upstream pagination without inventing a total',
    async ({ files }) => {
      const { call } = setup({ data: { filesPerStudy: files } })
      await expect(call('pdc_list_files', { ...selector, limit: 1 })).resolves.toMatchObject({
        total: null,
        next_offset: null,
        has_more: false,
        truncated: false
      })
    }
  )

  it('marks the offset ceiling without returning an invalid continuation', async () => {
    const { call } = setup({ data: { filesPerStudy: [file, file] } })
    await expect(
      call('pdc_list_files', { ...selector, offset: 1_000_000, limit: 1 })
    ).resolves.toMatchObject({
      has_more: true,
      next_offset: null,
      truncated: true
    })
  })

  it('rejects an upstream response that ignores the requested limit', async () => {
    const { call } = setup({ data: { filesPerStudy: [file, file, file] } })
    await expect(call('pdc_list_files', { ...selector, limit: 1 })).rejects.toThrow(
      'ignored file limit'
    )
  })

  it.each([
    ['pdc_search_studies', {}, { studyCatalog: null }],
    ['pdc_search_studies', {}, { studyCatalog: [{ ...selector, versions: null }] }],
    ['pdc_get_study', selector, { study: [{ study_id: studyId }] }],
    [
      'pdc_list_biospecimens',
      selector,
      { biospecimenPerStudy: [{ aliquot_id: 'a', sample_id: null, case_id: 'c' }] }
    ],
    ['pdc_list_files', selector, { filesPerStudy: [{}] }]
  ])('fails closed on malformed %s records', async (id, args, data) => {
    await expect(
      setup({ data }).call(id as string, args as Record<string, unknown>)
    ).rejects.toThrow('Invalid PDC response')
  })

  it.each(PDC_TOOLS.map((tool) => tool.id))(
    'rejects GraphQL errors and partial data for %s',
    async (id) => {
      const { call } = setup({
        errors: [
          { message: 'Upstream resolver failed', extensions: { stacktrace: ['private trace'] } }
        ],
        data: {
          study: [study],
          studyCatalog: [catalog],
          biospecimenPerStudy: [],
          filesPerStudy: [file]
        }
      })
      await expect(call(id, id === 'pdc_search_studies' ? {} : selector)).rejects.toThrow(
        'PDC GraphQL error: Upstream resolver failed'
      )
    }
  )

  it('propagates HTTP failures through the shared engine', async () => {
    const engine = new ParserEngine({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Unavailable', { status: 503 })),
      retries: 0
    })
    await expect(engine.call(PDC_TOOLS[0], {}, {})).rejects.toThrow('503')
  })
})
