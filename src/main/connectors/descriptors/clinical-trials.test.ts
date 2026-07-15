import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CLINICAL_TRIALS_TOOLS } from './clinical-trials'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CLINICAL_TRIALS_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const call = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch }).call(tool(id), args, {})

// Decode a request URL into { path, params } with params in the API's decoded form.
const parseUrl = (url: string): { path: string; params: Record<string, string> } => {
  const u = new URL(url)
  const params: Record<string, string> = {}
  u.searchParams.forEach((v, k) => (params[k] = v))
  return { path: u.origin + u.pathname, params }
}

// A minimal raw study record with the fields the marshallers read.
const study = (over: Record<string, unknown> = {}): unknown => ({
  protocolSection: {
    identificationModule: { nctId: 'NCT00000001', briefTitle: 'Brief', officialTitle: 'Official' },
    statusModule: {
      overallStatus: 'RECRUITING',
      startDateStruct: { date: '2023-01-01' },
      primaryCompletionDateStruct: { date: '2025-01-01' }
    },
    designModule: {
      studyType: 'INTERVENTIONAL',
      phases: ['PHASE3'],
      enrollmentInfo: { count: 100 }
    },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Acme' } },
    conditionsModule: { conditions: ['Cancer'] },
    armsInterventionsModule: { interventions: [{ name: 'DrugX' }, {}] },
    contactsLocationsModule: { locations: [{ city: 'Boston' }] },
    ...(over as object)
  }
})

const STUDIES = 'https://clinicaltrials.gov/api/v2/studies'

describe('search_trials', () => {
  it('builds fielded + Essie params and reshapes the page (count_total)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ totalCount: 42, nextPageToken: 'tok', studies: [study()] }))
    const out = (await call(
      'search_trials',
      {
        condition: 'lung cancer',
        intervention: 'pembrolizumab',
        status: ['RECRUITING'],
        phase: ['PHASE2', 'PHASE3'],
        study_type: 'INTERVENTIONAL',
        location: 'Boston',
        sponsor: 'Merck',
        count_total: true,
        page_size: 5
      },
      fetchImpl
    )) as Record<string, unknown>
    const { path, params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(path).toBe(STUDIES)
    expect(params['query.cond']).toBe('lung cancer')
    expect(params['query.intr']).toBe('pembrolizumab')
    expect(params['filter.overallStatus']).toBe('RECRUITING')
    expect(params['filter.advanced']).toBe(
      '(AREA[Phase]PHASE2 OR AREA[Phase]PHASE3) AND AREA[StudyType]INTERVENTIONAL'
    )
    expect(params['query.locn']).toBe('Boston')
    expect(params['query.spons']).toBe('Merck')
    expect(params.pageSize).toBe('5')
    expect(params.countTotal).toBe('true')
    expect(params.fields).toContain('OfficialTitle')
    expect(out.count).toBe(1)
    expect(out.total).toBe(42)
    expect(out.next_page_token).toBe('tok')
    expect((out.items as Record<string, unknown>[])[0]).toEqual({
      nct_id: 'NCT00000001',
      title: 'Official',
      status: 'RECRUITING',
      phase: ['PHASE3'],
      conditions: ['Cancer'],
      interventions: ['DrugX'],
      sponsor: 'Acme',
      enrollment: 100,
      start_date: '2023-01-01',
      primary_completion_date: '2025-01-01',
      locations_count: 1,
      study_type: 'INTERVENTIONAL'
    })
  })

  it('single phase uses no OR group; total null and no countTotal without count_total', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ studies: [] }))
    const out = (await call(
      'search_trials',
      { condition: 'x', phase: 'PHASE1' },
      fetchImpl
    )) as Record<string, unknown>
    const { params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(params['filter.advanced']).toBe('AREA[Phase]PHASE1')
    expect(params.pageSize).toBe('10')
    expect(params.countTotal).toBeUndefined()
    expect(out).toEqual({ count: 0, total: null, next_page_token: null, items: [] })
  })

  it('forwards page_token and merges advanced_query into filter.advanced', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ studies: [] }))
    await call(
      'search_trials',
      {
        phase: ['PHASE2', 'PHASE3'],
        advanced_query: 'AREA[EnrollmentCount]RANGE[100,MAX]',
        page_token: 'PG'
      },
      fetchImpl
    )
    const { params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(params.pageToken).toBe('PG')
    expect(params['filter.advanced']).toBe(
      '(AREA[Phase]PHASE2 OR AREA[Phase]PHASE3) AND AREA[EnrollmentCount]RANGE[100,MAX]'
    )
  })
})

describe('get_trial_details', () => {
  it('fetches by NCT id with details fields and returns the full trial', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        hasResults: true,
        protocolSection: {
          identificationModule: {
            nctId: 'NCT03661411',
            briefTitle: 'BT',
            officialTitle: 'OT',
            acronym: 'ACR'
          },
          statusModule: {
            overallStatus: 'COMPLETED',
            startDateStruct: { date: '2018-01-01' },
            primaryCompletionDateStruct: { date: '2020-01-01' },
            completionDateStruct: { date: '2021-01-01' }
          },
          designModule: {
            studyType: 'INTERVENTIONAL',
            phases: ['PHASE3'],
            enrollmentInfo: { count: 500 }
          },
          sponsorCollaboratorsModule: {
            leadSponsor: { name: 'Lead' },
            collaborators: [{ name: 'Collab' }]
          },
          descriptionModule: { briefSummary: 'BS', detailedDescription: 'DD' },
          eligibilityModule: {
            eligibilityCriteria: 'EC',
            minimumAge: '18 Years',
            maximumAge: '75 Years',
            sex: 'ALL',
            healthyVolunteers: false
          },
          outcomesModule: {
            primaryOutcomes: [{ measure: 'OS', timeFrame: '2y', description: 'd' }],
            secondaryOutcomes: [{ measure: 'PFS', timeFrame: '1y' }]
          },
          conditionsModule: { conditions: ['Cancer'] },
          armsInterventionsModule: { interventions: [{ name: 'DrugX' }] },
          contactsLocationsModule: {
            locations: [
              {
                facility: 'Fac',
                city: 'NYC',
                state: 'NY',
                country: 'US',
                zip: '10001',
                status: 'RECRUITING',
                contacts: [{ name: 'A' }]
              }
            ]
          }
        }
      })
    )
    const out = (await call('get_trial_details', { nct_id: 'nct03661411' }, fetchImpl)) as Record<
      string,
      unknown
    >
    const { path, params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    // Bare-number/lowercase input is normalized to the canonical NCT id.
    expect(path).toBe(`${STUDIES}/NCT03661411`)
    expect(params.fields).toBe('protocolSection|hasResults')
    expect(out.found).toBe(true)
    const trial = out.trial as Record<string, unknown>
    expect(trial.nct_id).toBe('NCT03661411')
    expect(trial.title).toBe('OT')
    expect(trial.acronym).toBe('ACR')
    expect(trial.collaborators).toEqual(['Collab'])
    expect(trial.healthy_volunteers).toBe('No')
    expect(trial.completion_date).toBe('2021-01-01')
    expect(trial.primary_outcomes).toEqual([
      { measure: 'OS', time_frame: '2y', description: 'd', type: 'PRIMARY' }
    ])
    expect(trial.secondary_outcomes).toEqual([
      { measure: 'PFS', time_frame: '1y', description: null, type: 'SECONDARY' }
    ])
    expect(trial.other_outcomes).toBeNull()
    expect(trial.url).toBe('https://clinicaltrials.gov/study/NCT03661411')
    expect(trial.has_results).toBe(true)
  })

  it('maps an HTTP 404 to a not-found response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, headers: new Headers() } as Response)
    const out = (await call('get_trial_details', { nct_id: 'NCT99999999' }, fetchImpl)) as Record<
      string,
      unknown
    >
    expect(out).toEqual({
      found: false,
      nct_id: 'NCT99999999',
      error: 'Trial NCT99999999 not found'
    })
  })
})

describe('search_by_sponsor', () => {
  it('builds a LeadSponsorName Essie phrase with phase and status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ totalCount: 7, studies: [study()] }))
    const out = (await call(
      'search_by_sponsor',
      {
        sponsor_name: 'Pfizer',
        phase: ['PHASE3'],
        condition: 'cancer',
        status: ['RECRUITING'],
        count_total: true
      },
      fetchImpl
    )) as Record<string, unknown>
    const { params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(params['filter.advanced']).toBe('AREA[LeadSponsorName]"Pfizer" AND AREA[Phase]PHASE3')
    expect(params['query.cond']).toBe('cancer')
    expect(params['filter.overallStatus']).toBe('RECRUITING')
    expect(params.countTotal).toBe('true')
    expect(out.total).toBe(7)
  })
})

describe('search_investigators', () => {
  it('extracts site contacts, deduped, with institution precedence over location', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT00000009', briefTitle: 'Study 9' },
              conditionsModule: { conditions: ['Alzheimer', 'Dementia'] },
              contactsLocationsModule: {
                locations: [
                  {
                    facility: 'Mayo Clinic',
                    city: 'Rochester',
                    contacts: [
                      { name: 'Dr A', role: 'PRINCIPAL_INVESTIGATOR' },
                      { name: 'Dr A', role: 'PRINCIPAL_INVESTIGATOR' },
                      { name: 'Dr B', role: 'CONTACT' }
                    ]
                  }
                ]
              }
            }
          }
        ]
      })
    )
    const out = (await call(
      'search_investigators',
      {
        condition: 'Alzheimer',
        institution: 'Mayo Clinic',
        location: 'ignored',
        investigator_name: 'Smith'
      },
      fetchImpl
    )) as Record<string, unknown>
    const { params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(params['filter.advanced']).toBe(
      '(AREA[OverallOfficialName]"Smith" OR AREA[ResponsiblePartyInvestigatorFullName]"Smith") AND AREA[LocationFacility]"Mayo Clinic"'
    )
    expect(params['query.cond']).toBe('Alzheimer')
    // institution takes precedence: no query.locn is emitted.
    expect(params['query.locn']).toBeUndefined()
    expect(params.pageSize).toBe('20')
    expect(out.count).toBe(2)
    expect((out.investigators as Record<string, unknown>[])[0]).toEqual({
      name: 'Dr A',
      role: 'PRINCIPAL_INVESTIGATOR',
      affiliation: 'Mayo Clinic',
      facility: 'Mayo Clinic',
      location: 'Rochester',
      nct_id: 'NCT00000009',
      study_title: 'Study 9',
      condition: 'Alzheimer'
    })
  })

  it('uses query.locn when only location is given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ studies: [] }))
    await call('search_investigators', { location: 'California' }, fetchImpl)
    const { params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(params['query.locn']).toBe('California')
    expect(params['filter.advanced']).toBeUndefined()
  })
})

describe('analyze_endpoints', () => {
  it('single-trial mode: nct_id takes precedence over condition', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(
        study({
          outcomesModule: {
            primaryOutcomes: [{ measure: 'OS', timeFrame: '2y' }],
            secondaryOutcomes: [{ measure: 'OS' }, { measure: 'PFS' }]
          }
        })
      )
    )
    const out = (await call(
      'analyze_endpoints',
      { nct_id: 'NCT00000001', condition: 'cancer' },
      fetchImpl
    )) as Record<string, unknown>
    const { path, params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(path).toBe(`${STUDIES}/NCT00000001`)
    expect(params.fields).toBe('NCTId|protocolSection.outcomesModule')
    expect(out.trials_analyzed).toBe(1)
    expect(out.nct_id).toBe('NCT00000001')
    expect(out.condition).toBeNull()
    // OS appears twice (first-seen order), PFS once.
    expect(out.common_measures).toEqual(['OS', 'PFS'])
  })

  it('aggregate mode: condition builds query.cond + phase, scans a page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        studies: [
          study({ outcomesModule: { primaryOutcomes: [{ measure: 'HbA1c' }] } }),
          study({ outcomesModule: { primaryOutcomes: [{ measure: 'HbA1c' }] } })
        ]
      })
    )
    const out = (await call(
      'analyze_endpoints',
      { condition: 'diabetes', phase: ['PHASE3'], start_date_after: '2022-01-01', page_size: 25 },
      fetchImpl
    )) as Record<string, unknown>
    const { path, params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(path).toBe(STUDIES)
    expect(params['query.cond']).toBe('diabetes')
    expect(params['filter.advanced']).toBe(
      'AREA[Phase]PHASE3 AND AREA[StartDate]RANGE[2022-01-01, MAX]'
    )
    expect(params.pageSize).toBe('25')
    expect(out.trials_analyzed).toBe(2)
    expect(out.condition).toBe('diabetes')
    expect(out.nct_id).toBeNull()
    expect(out.common_measures).toEqual(['HbA1c'])
  })

  it('throws when neither nct_id nor condition is given', async () => {
    const fetchImpl = vi.fn()
    await expect(call('analyze_endpoints', {}, fetchImpl)).rejects.toThrow(
      'needs nct_id or condition'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('search_by_eligibility', () => {
  it('defaults status to RECRUITING and builds age/sex Essie ranges', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ studies: [study()] }))
    const out = (await call(
      'search_by_eligibility',
      {
        condition: 'diabetes',
        min_age: '65 Years',
        max_age: '80 Years',
        sex: 'FEMALE',
        eligibility_keywords: 'HbA1c > 8'
      },
      fetchImpl
    )) as Record<string, unknown>
    const { params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(params['filter.overallStatus']).toBe('RECRUITING')
    expect(params['query.cond']).toBe('diabetes')
    expect(params['filter.advanced']).toBe(
      'AREA[EligibilityCriteria]"HbA1c > 8" AND AREA[MinimumAge]RANGE[MIN, 65 Years] AND AREA[MaximumAge]RANGE[80 Years, MAX] AND (AREA[Sex]FEMALE OR AREA[Sex]ALL)'
    )
    // count_total is not exposed for this tool: total stays null.
    expect(out.total).toBeNull()
  })

  it('honors an explicit status instead of the RECRUITING default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ studies: [] }))
    await call(
      'search_by_eligibility',
      { condition: 'cancer', status: ['COMPLETED', 'RECRUITING'] },
      fetchImpl
    )
    const { params } = parseUrl(fetchImpl.mock.calls[0][0] as string)
    expect(params['filter.overallStatus']).toBe('COMPLETED|RECRUITING')
  })

  it('throws when no matchable criterion is supplied', async () => {
    const fetchImpl = vi.fn()
    await expect(call('search_by_eligibility', { sex: '' }, fetchImpl)).rejects.toThrow(
      'search_by_eligibility needs at least one of'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
