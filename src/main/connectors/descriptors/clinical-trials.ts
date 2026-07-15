import type { ToolContext, ToolDescriptor } from '../types'

// ClinicalTrials.gov API v2. Read-only; the engine paces and retries 429/5xx. Each tool is
// page-oriented: page_size / page_token are forwarded server-side and next_page_token is returned,
// so a single request is issued per call (no full pageToken walk).
const STUDIES = 'https://clinicaltrials.gov/api/v2/studies'

// Trimmed server-side field projections (piece names / JSON paths), one per tool family.
const SEARCH_FIELDS = [
  'NCTId',
  'OfficialTitle',
  'BriefTitle',
  'OverallStatus',
  'Phase',
  'StudyType',
  'Condition',
  'InterventionName',
  'LeadSponsorName',
  'EnrollmentCount',
  'StartDate',
  'PrimaryCompletionDate',
  'LocationCity'
].join('|')
const INVESTIGATOR_FIELDS = [
  'NCTId',
  'BriefTitle',
  'Condition',
  'protocolSection.contactsLocationsModule.locations'
].join('|')
const ENDPOINT_FIELDS = 'NCTId|protocolSection.outcomesModule'
const DETAILS_FIELDS = 'protocolSection|hasResults'

// Enum vocabularies (from GET /api/v2/studies/enums, API 2.0.5).
const PHASE_ENUM = ['EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4', 'NA']
const STATUS_ENUM = [
  'NOT_YET_RECRUITING',
  'RECRUITING',
  'ENROLLING_BY_INVITATION',
  'ACTIVE_NOT_RECRUITING',
  'COMPLETED',
  'SUSPENDED',
  'TERMINATED',
  'WITHDRAWN',
  'AVAILABLE',
  'NO_LONGER_AVAILABLE',
  'TEMPORARILY_NOT_AVAILABLE',
  'APPROVED_FOR_MARKETING',
  'WITHHELD',
  'UNKNOWN'
]

// ── raw study record shapes ──────────────────────────────────────────────────
type Outcome = { measure?: string; timeFrame?: string; description?: string }
type OutcomesModule = {
  primaryOutcomes?: Outcome[]
  secondaryOutcomes?: Outcome[]
  otherOutcomes?: Outcome[]
}
type Contact = { name?: string; role?: string } & Record<string, unknown>
type Location = {
  facility?: string
  city?: string
  state?: string
  country?: string
  zip?: string
  status?: string
  contacts?: Contact[]
}
type Proto = {
  identificationModule?: {
    nctId?: string
    briefTitle?: string
    officialTitle?: string
    acronym?: string
  }
  statusModule?: {
    overallStatus?: string
    startDateStruct?: { date?: string }
    primaryCompletionDateStruct?: { date?: string }
    completionDateStruct?: { date?: string }
  }
  designModule?: { phases?: string[]; studyType?: string; enrollmentInfo?: { count?: number } }
  sponsorCollaboratorsModule?: {
    leadSponsor?: { name?: string }
    collaborators?: { name?: string }[]
  }
  descriptionModule?: { briefSummary?: string; detailedDescription?: string }
  eligibilityModule?: {
    eligibilityCriteria?: string
    minimumAge?: string
    maximumAge?: string
    sex?: string
    healthyVolunteers?: boolean
  }
  outcomesModule?: OutcomesModule
  conditionsModule?: { conditions?: string[] }
  armsInterventionsModule?: { interventions?: { name?: string }[] }
  contactsLocationsModule?: { locations?: Location[] }
}
type Study = { protocolSection?: Proto; hasResults?: boolean }
type SearchPage = { studies?: Study[]; totalCount?: number; nextPageToken?: string }

// ── shared helpers ───────────────────────────────────────────────────────────

// A schema value is "set" when it is neither null/undefined nor an empty string.
const truthy = (v: unknown): boolean => v != null && v !== ''

// Normalize a string-or-array schema value to a list of strings.
function asList(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') return [value]
  return (value as unknown[]).map((v) => String(v))
}

// String-or-array enum value(s), trimmed, upper-cased, empties dropped (API enums are UPPER).
function enumList(value: unknown): string[] {
  return asList(value)
    .map((v) => v.trim().toUpperCase())
    .filter((v) => v.length > 0)
}

// Clamp the requested page size to the API's 1..1000 window, defaulting on a bad value.
function pageSize(a: Record<string, unknown>, def: number): number {
  const n = Number((a.page_size as number) || def)
  const size = Number.isFinite(n) ? Math.trunc(n) : def
  return Math.max(1, Math.min(size, 1000))
}

// 'NCT' + 8 digits; prepend NCT when the caller passed just the number. Case-insensitive.
function normalizeNct(id: unknown): string {
  let nct = String(id).trim().toUpperCase()
  if (nct && !nct.startsWith('NCT')) nct = 'NCT' + nct
  return nct
}

// ── Essie expression builders (query.term / filter.advanced) ─────────────────

const quotePhrase = (text: string): string => '"' + text.replace(/"/g, '\\"') + '"'
const areaPhrase = (area: string, phrase: string): string => `AREA[${area}]${quotePhrase(phrase)}`
const areaTerm = (area: string, term: string): string => `AREA[${area}]${term}`
const areaRange = (area: string, lo: string | null, hi: string | null): string =>
  `AREA[${area}]RANGE[${lo || 'MIN'}, ${hi || 'MAX'}]`

// Parenthesize an expression carrying a top-level OR before it is AND-joined (defensive).
const parenIfOr = (e: string): string =>
  e.includes(' OR ') && !(e.startsWith('(') && e.endsWith(')')) ? `(${e})` : e

function andJoin(...exprs: (string | undefined)[]): string {
  const kept = exprs.filter((e): e is string => Boolean(e))
  if (!kept.length) throw new Error('no expressions to join')
  return kept.map(parenIfOr).join(' AND ')
}

function orJoin(...exprs: (string | undefined)[]): string {
  const kept = exprs.filter((e): e is string => Boolean(e))
  if (!kept.length) throw new Error('no expressions to join')
  return kept.length === 1 ? kept[0] : '(' + kept.join(' OR ') + ')'
}

// ── query builders (one per tool; reproduce the fielded / Essie translation) ─

// search_trials: condition/intervention -> query.cond/query.intr, status -> filter.overallStatus,
// phase + study_type -> filter.advanced; location/sponsor -> query.locn/query.spons; advanced_query
// merged into filter.advanced.
function searchTrialsParams(a: Record<string, unknown>): Record<string, string> {
  const studyType = truthy(a.study_type) ? String(a.study_type).trim().toUpperCase() : null
  const condition = truthy(a.condition) ? String(a.condition) : null
  const intervention = truthy(a.intervention) ? String(a.intervention) : null
  const status = enumList(a.status)
  const phase = enumList(a.phase)
  const params: Record<string, string> = {}
  if (condition || intervention || status.length || phase.length || studyType) {
    if (condition != null) params['query.cond'] = condition
    if (intervention != null) params['query.intr'] = intervention
    if (status.length) params['filter.overallStatus'] = status.join('|')
    const terms: string[] = []
    if (phase.length) {
      terms.push(
        phase.length === 1
          ? `AREA[Phase]${phase[0]}`
          : '(' + phase.map((p) => `AREA[Phase]${p}`).join(' OR ') + ')'
      )
    }
    if (studyType) terms.push(`AREA[StudyType]${studyType}`)
    if (terms.length) params['filter.advanced'] = terms.join(' AND ')
  }
  if (truthy(a.location)) params['query.locn'] = String(a.location)
  if (truthy(a.sponsor)) params['query.spons'] = String(a.sponsor)
  if (truthy(a.advanced_query)) {
    params['filter.advanced'] = andJoin(params['filter.advanced'], String(a.advanced_query))
  }
  return params
}

// search_by_sponsor: Essie LeadSponsorName phrase (partial match) + optional phase/condition/status.
function sponsorParams(a: Record<string, unknown>): Record<string, string> {
  const parts = [areaPhrase('LeadSponsorName', String(a.sponsor_name))]
  const phases = enumList(a.phase)
  if (phases.length) parts.push(orJoin(...phases.map((p) => areaTerm('Phase', p))))
  const params: Record<string, string> = { 'filter.advanced': andJoin(...parts) }
  if (truthy(a.condition)) params['query.cond'] = String(a.condition)
  const status = enumList(a.status)
  if (status.length) params['filter.overallStatus'] = status.join('|')
  return params
}

// search_by_eligibility: patient-matching Essie dimensions. min_age matches trials whose MinimumAge
// <= it (RANGE[MIN, min_age]); max_age matches MaximumAge >= it; sex matches that sex OR all-comers;
// status defaults to RECRUITING.
function eligibilityParams(a: Record<string, unknown>): Record<string, string> {
  const parts: string[] = []
  if (truthy(a.eligibility_keywords)) {
    parts.push(areaPhrase('EligibilityCriteria', String(a.eligibility_keywords)))
  }
  if (truthy(a.min_age)) parts.push(areaRange('MinimumAge', null, String(a.min_age)))
  if (truthy(a.max_age)) parts.push(areaRange('MaximumAge', String(a.max_age), null))
  if (truthy(a.sex)) {
    const sex = String(a.sex).toUpperCase()
    if (sex === 'MALE' || sex === 'FEMALE') {
      parts.push(orJoin(areaTerm('Sex', sex), areaTerm('Sex', 'ALL')))
    } else {
      parts.push(areaTerm('Sex', 'ALL'))
    }
  }
  const params: Record<string, string> = {}
  if (parts.length) params['filter.advanced'] = andJoin(...parts)
  if (truthy(a.condition)) params['query.cond'] = String(a.condition)
  const status = enumList(a.status)
  params['filter.overallStatus'] = (status.length ? status : ['RECRUITING']).join('|')
  if (!parts.length && !truthy(a.condition)) {
    throw new Error(
      'search_by_eligibility needs at least one of: condition, eligibility_keywords, min_age, max_age, sex'
    )
  }
  return params
}

// search_investigators: Essie OverallOfficialName / ResponsiblePartyInvestigatorFullName phrase
// search; institution filters on LocationFacility and takes precedence over location.
function investigatorParams(a: Record<string, unknown>): Record<string, string> {
  const parts: string[] = []
  if (truthy(a.investigator_name)) {
    const name = String(a.investigator_name)
    parts.push(
      orJoin(
        areaPhrase('OverallOfficialName', name),
        areaPhrase('ResponsiblePartyInvestigatorFullName', name)
      )
    )
  }
  const params: Record<string, string> = {}
  if (truthy(a.institution)) parts.push(areaPhrase('LocationFacility', String(a.institution)))
  else if (truthy(a.location)) params['query.locn'] = String(a.location)
  if (truthy(a.condition)) params['query.cond'] = String(a.condition)
  const status = enumList(a.status)
  if (status.length) params['filter.overallStatus'] = status.join('|')
  if (parts.length) params['filter.advanced'] = andJoin(...parts)
  if (Object.keys(params).length === 0) {
    throw new Error(
      'search_investigators needs at least one of: investigator_name, institution, location, condition, status'
    )
  }
  return params
}

// analyze_endpoints aggregate mode: condition + optional phase + StartDate lower bound.
function endpointsParams(a: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = { 'query.cond': String(a.condition) }
  const phases = enumList(a.phase)
  const parts: string[] = []
  if (phases.length) parts.push(orJoin(...phases.map((p) => areaTerm('Phase', p))))
  if (truthy(a.start_date_after))
    parts.push(areaRange('StartDate', String(a.start_date_after), null))
  if (parts.length) params['filter.advanced'] = andJoin(...parts)
  return params
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

// One server-side /studies page (page-oriented; no full-pagination walk).
async function fetchPage(
  ctx: ToolContext,
  params: Record<string, string>,
  size: number,
  pageToken: unknown,
  countTotal: boolean,
  fields: string
): Promise<SearchPage> {
  const p: Record<string, string> = { ...params, pageSize: String(size), fields }
  if (countTotal) p.countTotal = 'true'
  if (truthy(pageToken)) p.pageToken = String(pageToken)
  const url = `${STUDIES}?${new URLSearchParams(p).toString()}`
  return (await ctx.fetchJson(url)) as SearchPage
}

// GET /studies/{nctId} (single full record).
async function getStudy(ctx: ToolContext, nct: string, fields: string): Promise<Study> {
  const url = `${STUDIES}/${encodeURIComponent(nct)}?${new URLSearchParams({ fields }).toString()}`
  return (await ctx.fetchJson(url)) as Study
}

// A zero-hit or bad NCT id surfaces as an HTTP 400/404 from the engine.
function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error && (err.message.includes('HTTP 400') || err.message.includes('HTTP 404'))
  )
}

// ── marshalling (raw study JSON -> connector output shapes) ──────────────────

const structDate = (m?: { date?: string }): string | null => m?.date ?? null

// One search-result item (search_trials / search_by_sponsor / search_by_eligibility).
function trialSummary(study: Study): Record<string, unknown> {
  const p = study.protocolSection ?? {}
  const ident = p.identificationModule ?? {}
  const status = p.statusModule ?? {}
  const design = p.designModule ?? {}
  const sponsor = p.sponsorCollaboratorsModule ?? {}
  const conds = p.conditionsModule ?? {}
  const arms = p.armsInterventionsModule ?? {}
  const locations = p.contactsLocationsModule?.locations ?? []
  return {
    nct_id: ident.nctId ?? null,
    title: ident.officialTitle ?? ident.briefTitle ?? null,
    status: status.overallStatus ?? null,
    phase: design.phases?.length ? design.phases : null,
    conditions: conds.conditions ?? [],
    interventions: (arms.interventions ?? [])
      .map((i) => i.name)
      .filter((n): n is string => Boolean(n)),
    sponsor: sponsor.leadSponsor?.name ?? null,
    enrollment: design.enrollmentInfo?.count ?? null,
    start_date: structDate(status.startDateStruct),
    primary_completion_date: structDate(status.primaryCompletionDateStruct),
    locations_count: locations.length,
    study_type: design.studyType ?? null
  }
}

// Reshape one raw /studies page into the search output.
function searchResponse(page: SearchPage, countTotal: boolean): Record<string, unknown> {
  const items = (page.studies ?? []).map(trialSummary)
  return {
    count: items.length,
    total: countTotal ? (page.totalCount ?? null) : null,
    next_page_token: page.nextPageToken ?? null,
    items
  }
}

// One outcome group typed with its label, or null when the group is absent.
function outcomes(
  om: OutcomesModule,
  key: 'primaryOutcomes' | 'secondaryOutcomes' | 'otherOutcomes',
  label: string
): Record<string, unknown>[] | null {
  const raw = om[key]
  if (!raw || !raw.length) return null
  return raw.map((o) => ({
    measure: o.measure ?? null,
    time_frame: o.timeFrame ?? null,
    description: o.description ?? null,
    type: label
  }))
}

function locationOut(loc: Location): Record<string, unknown> {
  return {
    facility: loc.facility ?? null,
    city: loc.city ?? null,
    state: loc.state ?? null,
    country: loc.country ?? null,
    zip: loc.zip ?? null,
    status: loc.status ?? null,
    contacts: loc.contacts ?? null
  }
}

// Full get_trial_details record.
function trialDetailsResponse(study: Study): Record<string, unknown> {
  const p = study.protocolSection ?? {}
  const ident = p.identificationModule ?? {}
  const status = p.statusModule ?? {}
  const design = p.designModule ?? {}
  const sponsor = p.sponsorCollaboratorsModule ?? {}
  const desc = p.descriptionModule ?? {}
  const elig = p.eligibilityModule ?? {}
  const om = p.outcomesModule ?? {}
  const conds = p.conditionsModule ?? {}
  const arms = p.armsInterventionsModule ?? {}
  const locations = p.contactsLocationsModule?.locations
  const nctId = ident.nctId ?? null
  const collaborators = (sponsor.collaborators ?? [])
    .map((c) => c.name)
    .filter((n): n is string => Boolean(n))
  const hv = elig.healthyVolunteers
  const trial = {
    nct_id: nctId,
    title: ident.officialTitle ?? ident.briefTitle ?? null,
    brief_title: ident.briefTitle ?? null,
    acronym: ident.acronym ?? null,
    status: status.overallStatus ?? null,
    phase: design.phases?.length ? design.phases : null,
    study_type: design.studyType ?? null,
    conditions: conds.conditions ?? [],
    interventions: (arms.interventions ?? [])
      .map((i) => i.name)
      .filter((n): n is string => Boolean(n)),
    sponsor: sponsor.leadSponsor?.name ?? null,
    collaborators: collaborators.length ? collaborators : null,
    enrollment: design.enrollmentInfo?.count ?? null,
    start_date: structDate(status.startDateStruct),
    primary_completion_date: structDate(status.primaryCompletionDateStruct),
    completion_date: structDate(status.completionDateStruct),
    brief_summary: desc.briefSummary ?? null,
    detailed_description: desc.detailedDescription ?? null,
    eligibility_criteria: elig.eligibilityCriteria ?? null,
    minimum_age: elig.minimumAge ?? null,
    maximum_age: elig.maximumAge ?? null,
    sex: elig.sex ?? null,
    healthy_volunteers: hv == null ? null : hv ? 'Yes' : 'No',
    primary_outcomes: outcomes(om, 'primaryOutcomes', 'PRIMARY'),
    secondary_outcomes: outcomes(om, 'secondaryOutcomes', 'SECONDARY'),
    other_outcomes: outcomes(om, 'otherOutcomes', 'OTHER'),
    locations: locations?.length ? locations.map(locationOut) : null,
    url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : null,
    has_results: study.hasResults ?? null
  }
  return { found: true, trial }
}

function trialNotFoundResponse(nctId: string, error: string): Record<string, unknown> {
  return { found: false, nct_id: nctId, error }
}

// Aggregate protocol endpoints across the analyzed studies; common_measures = the 20 most common
// measure names (ties keep first-seen order — a stable sort of an insertion-ordered count map).
function endpointsResponse(
  studies: Study[],
  nctId: string | null,
  condition: string | null
): Record<string, unknown> {
  const primary: Record<string, unknown>[] = []
  const secondary: Record<string, unknown>[] = []
  const other: Record<string, unknown>[] = []
  const counts = new Map<string, number>()
  const groups: [Record<string, unknown>[], keyof OutcomesModule, string][] = [
    [primary, 'primaryOutcomes', 'PRIMARY'],
    [secondary, 'secondaryOutcomes', 'SECONDARY'],
    [other, 'otherOutcomes', 'OTHER']
  ]
  for (const study of studies) {
    const om = study.protocolSection?.outcomesModule ?? {}
    for (const [dest, key, label] of groups) {
      for (const o of om[key] ?? []) {
        dest.push({
          measure: o.measure ?? null,
          time_frame: o.timeFrame ?? null,
          description: o.description ?? null,
          type: label
        })
        if (o.measure) counts.set(o.measure, (counts.get(o.measure) ?? 0) + 1)
      }
    }
  }
  const commonMeasures = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([m]) => m)
  return {
    trials_analyzed: studies.length,
    nct_id: nctId,
    condition,
    primary_endpoints: primary,
    secondary_endpoints: secondary,
    other_endpoints: other,
    common_measures: commonMeasures
  }
}

// Collect investigators/contacts from each trial's site contact lists (locations[].contacts[]),
// deduplicated per trial by (name, role, nct_id).
function investigatorsResponse(studies: Study[]): Record<string, unknown> {
  const investigators: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const study of studies) {
    const p = study.protocolSection ?? {}
    const ident = p.identificationModule ?? {}
    const conds = p.conditionsModule?.conditions ?? []
    const nctId = ident.nctId ?? null
    const title = ident.briefTitle ?? null
    const condition = conds.length ? conds[0] : null
    for (const loc of p.contactsLocationsModule?.locations ?? []) {
      for (const contact of loc.contacts ?? []) {
        const key = JSON.stringify([contact.name ?? null, contact.role ?? null, nctId])
        if (seen.has(key)) continue
        seen.add(key)
        investigators.push({
          name: contact.name ?? null,
          role: contact.role ?? null,
          affiliation: loc.facility ?? null,
          facility: loc.facility ?? null,
          location: loc.city ?? null,
          nct_id: nctId,
          study_title: title,
          condition
        })
      }
    }
  }
  return { count: investigators.length, trials_analyzed: studies.length, investigators }
}

// Shared JSON Schema fragments for the tool inputs.
const statusSchema = { type: 'array', items: { type: 'string', enum: STATUS_ENUM } }
const phaseSchema = { type: 'array', items: { type: 'string', enum: PHASE_ENUM } }

// ClinicalTrials.gov API v2: search, details, sponsor/investigator discovery, endpoint analysis,
// and patient-eligibility matching.
export const CLINICAL_TRIALS_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_trials',
    connector: 'clinical_trials',
    description:
      'PRIMARY search over ClinicalTrials.gov. Filter by condition, intervention, sponsor, location, status (e.g. ["RECRUITING"]), phase (["PHASE1".."PHASE4"]) and study_type. condition/intervention/sponsor/location accept Essie query syntax (boolean AND/OR/NOT, "quoted phrases", grouping, automatic synonyms). Page with page_token; set count_total for the total match count. advanced_query merges a raw Essie expression into filter.advanced.',
    input: {
      type: 'object',
      properties: {
        condition: { type: 'string' },
        intervention: { type: 'string' },
        sponsor: { type: 'string' },
        location: { type: 'string' },
        status: statusSchema,
        phase: phaseSchema,
        study_type: {
          type: 'string',
          enum: ['INTERVENTIONAL', 'OBSERVATIONAL', 'EXPANDED_ACCESS']
        },
        advanced_query: { type: 'string' },
        page_size: { type: 'integer', default: 10, minimum: 1, maximum: 1000 },
        page_token: { type: 'string' },
        count_total: { type: 'boolean', default: false }
      }
    },
    returns:
      '`{ count, total (only when count_total, else null), next_page_token, items: [ { nct_id, title, status, phase (array|null), conditions, interventions, sponsor, enrollment, start_date, primary_completion_date, locations_count, study_type } ] }`.',
    example:
      'result = host.mcp("clinical_trials", "search_trials", {"condition": "lung cancer", "status": ["RECRUITING"], "phase": ["PHASE3"], "count_total": True, "page_size": 10})',
    run: async (ctx, a) => {
      const countTotal = Boolean(a.count_total)
      const page = await fetchPage(
        ctx,
        searchTrialsParams(a),
        pageSize(a, 10),
        a.page_token,
        countTotal,
        SEARCH_FIELDS
      )
      return searchResponse(page, countTotal)
    }
  },
  {
    id: 'get_trial_details',
    connector: 'clinical_trials',
    description:
      'Get comprehensive details for one trial by NCT id (format "NCT" + 8 digits; a bare number is prefixed, case-insensitive). Returns full eligibility criteria, study design, primary/secondary/other endpoints, all locations, sponsor and collaborators, dates, enrollment, and a results link.',
    input: {
      type: 'object',
      properties: { nct_id: { type: 'string' } },
      required: ['nct_id']
    },
    required: ['nct_id'],
    returns:
      'Found: `{ found: true, trial: { nct_id, title, brief_title, acronym, status, phase, study_type, conditions, interventions, sponsor, collaborators, enrollment, start_date, primary_completion_date, completion_date, brief_summary, detailed_description, eligibility_criteria, minimum_age, maximum_age, sex, healthy_volunteers ("Yes"/"No"), primary_outcomes, secondary_outcomes, other_outcomes, locations, url, has_results } }`. Missing/invalid id: `{ found: false, nct_id, error }`.',
    example: 'result = host.mcp("clinical_trials", "get_trial_details", {"nct_id": "NCT03661411"})',
    run: async (ctx, a) => {
      const nct = normalizeNct(a.nct_id)
      try {
        const study = await getStudy(ctx, nct, DETAILS_FIELDS)
        return trialDetailsResponse(study)
      } catch (err) {
        if (isNotFound(err)) return trialNotFoundResponse(nct, `Trial ${nct} not found`)
        throw err
      }
    }
  },
  {
    id: 'search_by_sponsor',
    connector: 'clinical_trials',
    description:
      'Find trials sponsored by a company or organization (partial name match, e.g. "Pfizer" matches "Pfizer Inc"). Optionally narrow by condition, phase and status. Set count_total for the total number of trials by the sponsor. Page with page_token.',
    input: {
      type: 'object',
      properties: {
        sponsor_name: { type: 'string' },
        condition: { type: 'string' },
        phase: phaseSchema,
        status: statusSchema,
        page_size: { type: 'integer', default: 10, minimum: 1, maximum: 1000 },
        page_token: { type: 'string' },
        count_total: { type: 'boolean', default: false }
      },
      required: ['sponsor_name']
    },
    required: ['sponsor_name'],
    returns:
      'Same shape as search_trials: `{ count, total, next_page_token, items: [ trial summaries ] }`.',
    example:
      'result = host.mcp("clinical_trials", "search_by_sponsor", {"sponsor_name": "Pfizer", "phase": ["PHASE3"], "count_total": True})',
    run: async (ctx, a) => {
      const countTotal = Boolean(a.count_total)
      const page = await fetchPage(
        ctx,
        sponsorParams(a),
        pageSize(a, 10),
        a.page_token,
        countTotal,
        SEARCH_FIELDS
      )
      return searchResponse(page, countTotal)
    }
  },
  {
    id: 'search_investigators',
    connector: 'clinical_trials',
    description:
      'Find principal investigators and research sites by condition, institution, location or investigator_name. institution filters on the site facility and takes precedence over location; investigator_name searches OverallOfficialName and ResponsiblePartyInvestigatorFullName. Returns site contacts (names, roles, affiliations, facilities, cities) with their trial NCT ids. page_size caps how many trials are scanned.',
    input: {
      type: 'object',
      properties: {
        condition: { type: 'string' },
        institution: { type: 'string' },
        location: { type: 'string' },
        investigator_name: { type: 'string' },
        status: statusSchema,
        page_size: { type: 'integer', default: 20, minimum: 1, maximum: 1000 }
      }
    },
    returns:
      '`{ count, trials_analyzed, investigators: [ { name, role, affiliation, facility, location, nct_id, study_title, condition } ] }`. Deduplicated per trial by (name, role, nct_id).',
    example:
      'result = host.mcp("clinical_trials", "search_investigators", {"condition": "Alzheimer", "institution": "Mayo Clinic", "page_size": 20})',
    run: async (ctx, a) => {
      const page = await fetchPage(
        ctx,
        investigatorParams(a),
        pageSize(a, 20),
        null,
        false,
        INVESTIGATOR_FIELDS
      )
      return investigatorsResponse(page.studies ?? [])
    }
  },
  {
    id: 'analyze_endpoints',
    connector: 'clinical_trials',
    description:
      'Analyze primary/secondary/other outcome measures (endpoints). Provide ONLY nct_id (single-trial mode) OR condition (aggregate mode across trials); if both are given, nct_id takes precedence. Aggregate mode may be narrowed by phase and start_date_after (YYYY-MM-DD) and scans up to page_size trials. Returns the endpoint lists plus the most common measure names across the analyzed trials.',
    input: {
      type: 'object',
      properties: {
        nct_id: { type: 'string' },
        condition: { type: 'string' },
        phase: phaseSchema,
        start_date_after: { type: 'string' },
        page_size: { type: 'integer', default: 50, minimum: 1, maximum: 1000 }
      }
    },
    returns:
      '`{ trials_analyzed, nct_id (or null), condition (or null), primary_endpoints, secondary_endpoints, other_endpoints, common_measures: [str] }`. Each endpoint is `{ measure, time_frame, description, type }`; common_measures is the 20 most frequent measure names.',
    example: 'result = host.mcp("clinical_trials", "analyze_endpoints", {"nct_id": "NCT03661411"})',
    run: async (ctx, a) => {
      if (!truthy(a.nct_id) && !truthy(a.condition)) {
        throw new Error('analyze_endpoints needs nct_id or condition')
      }
      if (truthy(a.nct_id)) {
        const nct = normalizeNct(a.nct_id)
        const study = await getStudy(ctx, nct, ENDPOINT_FIELDS)
        return endpointsResponse([study], nct, null)
      }
      const page = await fetchPage(
        ctx,
        endpointsParams(a),
        pageSize(a, 50),
        null,
        false,
        ENDPOINT_FIELDS
      )
      return endpointsResponse(page.studies ?? [], null, String(a.condition))
    }
  },
  {
    id: 'search_by_eligibility',
    connector: 'clinical_trials',
    description:
      'Patient-trial matching. DEFAULTS to RECRUITING trials unless status is set. min_age/max_age are the PATIENT\'s age ("65 Years", "6 Months") and match trials whose age window admits the patient; sex matches trials accepting that sex or all comers; eligibility_keywords searches the inclusion/exclusion criteria text (e.g. "HbA1c > 8", "BRCA mutation", "ECOG 0-1"). At least one of condition, eligibility_keywords, min_age, max_age or sex is required. Page with page_token.',
    input: {
      type: 'object',
      properties: {
        condition: { type: 'string' },
        eligibility_keywords: { type: 'string' },
        min_age: { type: 'string' },
        max_age: { type: 'string' },
        sex: { type: 'string', enum: ['ALL', 'MALE', 'FEMALE'] },
        status: statusSchema,
        page_size: { type: 'integer', default: 10, minimum: 1, maximum: 1000 },
        page_token: { type: 'string' }
      }
    },
    returns:
      'Same shape as search_trials: `{ count, total (always null — count_total is not exposed here), next_page_token, items: [ trial summaries ] }`.',
    example:
      'result = host.mcp("clinical_trials", "search_by_eligibility", {"condition": "diabetes", "min_age": "65 Years", "sex": "FEMALE"})',
    run: async (ctx, a) => {
      const page = await fetchPage(
        ctx,
        eligibilityParams(a),
        pageSize(a, 10),
        a.page_token,
        false,
        SEARCH_FIELDS
      )
      return searchResponse(page, false)
    }
  }
]
