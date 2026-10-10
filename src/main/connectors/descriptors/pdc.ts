import type { ToolContext, ToolDescriptor } from '../../connector-core/types'

const ENDPOINT = 'https://pdc.cancer.gov/graphql'
const MAX_OFFSET = 1_000_000
// The public resolver defaults to LIMIT 0, 1000, but exposes no offset/limit arguments.
const BIOSPECIMEN_UPSTREAM_LIMIT = 1000
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
const usage = {
  source: 'NCI Proteomic Data Commons',
  terms_url: 'https://pdc.cancer.gov/pdc/data-use-guidelines',
  documentation_url: 'https://pdc.cancer.gov/pdc/publicapi-documentation',
  citation_note:
    'Follow PDC data use guidelines (CC BY 4.0): cite PDC, the study identifier and the primary publication; acknowledge CPTAC for CPTAC data. External resources have their own access requirements.',
  discovery_note:
    'Metadata discovery only. No files are downloaded, no signed URLs are requested and no data use agreement is accepted on your behalf.'
}
const versionNote =
  'pdc_study_id selects the latest version; study_id is the UUID of a specific version. Use a returned study_id to pin subsequent calls. External reference IDs belong to the named resource; do not assume PDC and GDC UUIDs are interchangeable.'
const catalogFields = `pdc_study_id versions {
  study_id study_submitter_id study_shortname study_version is_latest_version
}`
const studyFields = `study_id pdc_study_id study_submitter_id study_name study_description
  program_name project_name disease_type primary_site analytical_fraction experiment_type
  cases_count aliquots_count filesCount { data_category file_type files_count }`
const biospecimenFields = `aliquot_id sample_id case_id aliquot_submitter_id
  sample_submitter_id case_submitter_id aliquot_status sample_status case_status
  project_name sample_type disease_type primary_site pool taxon
  externalReferences { external_reference_id reference_resource_shortname
    reference_resource_name reference_entity_location }`
const fileFields = `study_id pdc_study_id study_submitter_id study_name file_id file_name
  file_submitter_id file_type md5sum file_location file_size data_category file_format`

type Row = Record<string, unknown>
const object = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid PDC response: expected an object')
  return value as Row
}
const rows = (value: unknown, ids: string[]): Row[] => {
  if (!Array.isArray(value)) throw new Error('Invalid PDC response: expected a record list')
  return value.map((value) => {
    const row = object(value)
    for (const id of ids) {
      if (typeof row[id] !== 'string' || !row[id])
        throw new Error(`Invalid PDC response: missing ${id}`)
    }
    return row
  })
}
async function query(ctx: ToolContext, query: string, variables: Row): Promise<Row> {
  const body = object(await ctx.postJson(ENDPOINT, { query, variables }))
  if (body.errors != null) {
    if (!Array.isArray(body.errors)) throw new Error('Invalid PDC GraphQL errors')
    if (body.errors.length) {
      const messages = body.errors.slice(0, 3).map((error) => {
        const message = object(error).message
        return typeof message === 'string' ? message.slice(0, 300) : 'Unknown upstream error'
      })
      // Partial GraphQL data must not masquerade as a complete discovery result.
      throw new Error(`PDC GraphQL error: ${messages.join('; ')}`)
    }
  }
  return object(body.data)
}
const paging = (args: Row): { offset: number; limit: number } => ({
  offset: Number(args.offset ?? 0),
  limit: Number(args.limit ?? 20)
})
function page(records: Row[], args: Row, key: string): Row {
  const { offset, limit } = paging(args)
  const selected = records.slice(offset, offset + limit)
  const more = offset + selected.length < records.length
  return {
    [key]: selected,
    offset,
    limit,
    returned: selected.length,
    total: records.length,
    pagination_mode: 'local',
    next_offset: more && offset + limit <= MAX_OFFSET ? offset + limit : null,
    truncated: more && offset + limit > MAX_OFFSET,
    usage
  }
}
// PDC resolvers do not tolerate explicit null optional filters; omit absent variables.
const selector = (args: Row): Row => ({
  study_id: args.study_id,
  pdc_study_id: args.pdc_study_id
})
const selectorDeclaration = '$study_id: String, $pdc_study_id: String'
const selectorArguments = 'study_id: $study_id, pdc_study_id: $pdc_study_id'
const paginationProperties = {
  offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, default: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
}
const studyProperties = {
  pdc_study_id: { type: 'string', pattern: '^PDC[0-9]{6}$', maxLength: 9 },
  study_id: { type: 'string', pattern: UUID, maxLength: 36 }
}
const studyRequired = [
  { properties: { pdc_study_id: studyProperties.pdc_study_id }, required: ['pdc_study_id'] },
  { properties: { study_id: studyProperties.study_id }, required: ['study_id'] }
]
const filterString = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }

export const PDC_TOOLS: ToolDescriptor[] = [
  {
    connector: 'pdc',
    id: 'pdc_search_studies',
    description:
      'Search PDC study identifiers and version names in the public study catalog. Keyword matching is case-insensitive local substring matching, not disease/clinical filtering. Without a keyword, browse the catalog. All versions are retained.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { query: filterString, ...paginationProperties }
    },
    returns:
      '{ studies: [{ pdc_study_id, versions: [{ study_id, study_submitter_id, study_shortname, study_version, is_latest_version }] }], total, offset, limit, returned, next_offset, truncated, pagination_mode: "local", usage }. The upstream catalog has no pagination; this call fetches it within an 8 MiB response budget, sorts by PDC ID, filters locally and returns at most 100 studies. total counts matching studies, not versions. ' +
      versionNote,
    example:
      'const result = await host.mcp("pdc", "pdc_search_studies", {"query":"CCRCC", "limit":5})',
    maxResponseBytes: 8 * 1024 * 1024,
    run: async (ctx, args) => {
      const data = await query(ctx, `query { studyCatalog { ${catalogFields} } }`, {})
      const studies = rows(data.studyCatalog, ['pdc_study_id']).map(
        (study): Row & { versions: Row[] } => ({
          ...study,
          versions: rows(study.versions, ['study_id'])
        })
      )
      const keyword = String(args.query ?? '')
        .trim()
        .toLowerCase()
      const filtered = studies
        .filter((study) =>
          [
            study.pdc_study_id,
            ...study.versions.flatMap((version) => [
              version.study_id,
              version.study_submitter_id,
              version.study_shortname
            ])
          ].some((value) => typeof value === 'string' && value.toLowerCase().includes(keyword))
        )
        .sort((a, b) => String(a.pdc_study_id).localeCompare(String(b.pdc_study_id)))
      return page(filtered, args, 'studies')
    }
  },
  {
    connector: 'pdc',
    id: 'pdc_get_study',
    description:
      'Retrieve PDC study metadata, assay type, case/aliquot counts, file categories and available versions. ' +
      versionNote,
    input: {
      type: 'object',
      additionalProperties: false,
      properties: studyProperties,
      oneOf: studyRequired
    },
    returns:
      '{ studies: [{ study_id, pdc_study_id, study_submitter_id, study_name, study_description, program_name, project_name, disease_type, primary_site, analytical_fraction, experiment_type, cases_count, aliquots_count, filesCount }], catalog: [{ pdc_study_id, versions }], usage }. A missing study returns empty arrays. study_description may contain upstream HTML. Counts describe the selected version; catalog also includes other versions.',
    example: 'const result = await host.mcp("pdc", "pdc_get_study", {"pdc_study_id":"PDC000127"})',
    maxResponseBytes: 8 * 1024 * 1024,
    run: async (ctx, args) => {
      const data = await query(
        ctx,
        `query(${selectorDeclaration}) { study(${selectorArguments}) { ${studyFields} } }`,
        selector(args)
      )
      const studies = rows(data.study, ['study_id', 'pdc_study_id'])
      if (studies.length > 1) throw new Error('Invalid PDC response: ambiguous study selector')
      if (!studies.length) return { studies: [], catalog: [], usage }
      const versions = await query(
        ctx,
        `query($id: String!) { studyCatalog(pdc_study_id: $id) { ${catalogFields} } }`,
        { id: studies[0].pdc_study_id }
      )
      const catalog = rows(versions.studyCatalog, ['pdc_study_id']).map((entry) => ({
        ...entry,
        versions: rows(entry.versions, ['study_id'])
      }))
      return { studies, catalog, usage }
    }
  },
  {
    connector: 'pdc',
    id: 'pdc_list_biospecimens',
    description:
      "Map PDC study aliquots to samples and cases, preserving submitter IDs, pool flags and external references for CPTAC multi-omics research. Each row is an aliquot association, not a unique patient. Use pagination_mode: upstream to traverse beyond the local mode's 1000-association upstream cap; upstream offsets and limits count cases. " +
      versionNote,
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...studyProperties,
        ...paginationProperties,
        pagination_mode: { type: 'string', enum: ['local', 'upstream'], default: 'local' }
      },
      oneOf: studyRequired
    },
    returns:
      '{ biospecimens: [{ aliquot_id, sample_id, case_id, aliquot_submitter_id, sample_submitter_id, case_submitter_id, aliquot_status, sample_status, case_status, project_name, sample_type, disease_type, primary_site, pool, taxon, externalReferences }], study_selector, total, available, upstream_limit_reached, offset, limit, returned, next_offset, truncated, pagination_mode, usage }. ' +
      'Default pagination_mode: local preserves association-row pagination: fetch biospecimenPerStudy within an 8 MiB response budget, sort by aliquot/sample/case IDs and page locally. available counts all received associations. Below the 1000-record upstream cap, total equals available. At or above the cap, total is null, upstream_limit_reached and truncated are true on every page because completeness is unknown, even for exactly 1000 associations. next_offset pages only the received records; null does not establish study completeness. ' +
      'With pagination_mode: upstream, fetch one paginatedCasesSamplesAliquots case page plus one lookahead case and flatten only the selected cases. Additional fields: { pagination_unit: "case", case_total, returned_cases, has_more, unavailable_fields }. offset, limit and next_offset count cases, while returned and available count associations in this page and can exceed limit. total is null because the association total is unknown; case_total is the upstream case count. sample_id and case_id come from parent nodes. case_status, project_name and taxon are null and listed in unavailable_fields because this endpoint does not supply them. No automatic full-study aggregation or data cache is introduced. ' +
      'Each call refetches upstream data; upstream does not guarantee stable ordering or a cross-page snapshot. Pinning study_id fixes the version, not a snapshot or duplicate-free enumeration. A GDC external reference is separate from the PDC case_id; preserve its resource and identifier. No clinical treatment or outcome data is returned.',
    example:
      'const result = await host.mcp("pdc", "pdc_list_biospecimens", {"pdc_study_id":"PDC000127", "pagination_mode":"upstream", "limit":5})',
    maxResponseBytes: 8 * 1024 * 1024,
    run: async (ctx, args) => {
      if (args.pagination_mode === 'upstream') {
        const { offset, limit } = paging(args)
        const data = await query(
          ctx,
          `query(${selectorDeclaration}, $offset: Int!, $limit: Int!) {
            paginatedCasesSamplesAliquots(${selectorArguments}, offset: $offset, limit: $limit) {
              total casesSamplesAliquots {
                case_id case_submitter_id disease_type primary_site
                externalReferences { external_reference_id reference_resource_shortname
                  reference_resource_name reference_entity_location }
                samples { sample_id sample_submitter_id sample_type status
                  aliquots { aliquot_id aliquot_submitter_id status pool } }
              }
            }
          }`,
          { ...selector(args), offset, limit: limit + 1 }
        )
        const result = object(data.paginatedCasesSamplesAliquots)
        if (
          typeof result.total !== 'number' ||
          !Number.isSafeInteger(result.total) ||
          result.total < 0
        )
          throw new Error('Invalid PDC response: expected a case total')
        const cases = rows(result.casesSamplesAliquots, ['case_id'])
        if (cases.length > limit + 1)
          throw new Error('Invalid PDC response: upstream ignored biospecimen case limit')
        const selected = cases.slice(0, limit)
        const biospecimens = selected.flatMap((c) =>
          rows(c.samples, ['sample_id']).flatMap((sample) =>
            rows(sample.aliquots, ['aliquot_id']).map((aliquot) => ({
              aliquot_id: aliquot.aliquot_id,
              sample_id: sample.sample_id,
              case_id: c.case_id,
              aliquot_submitter_id: aliquot.aliquot_submitter_id,
              sample_submitter_id: sample.sample_submitter_id,
              case_submitter_id: c.case_submitter_id,
              aliquot_status: aliquot.status,
              sample_status: sample.status,
              case_status: null,
              project_name: null,
              sample_type: sample.sample_type,
              disease_type: c.disease_type,
              primary_site: c.primary_site,
              pool: aliquot.pool,
              taxon: null,
              externalReferences: c.externalReferences
            }))
          )
        )
        const more = cases.length > limit
        return {
          biospecimens,
          study_selector: selector(args),
          total: null,
          available: biospecimens.length,
          upstream_limit_reached: false,
          offset,
          limit,
          returned: biospecimens.length,
          next_offset: more && offset + limit <= MAX_OFFSET ? offset + limit : null,
          truncated: more && offset + limit > MAX_OFFSET,
          pagination_mode: 'upstream',
          pagination_unit: 'case',
          case_total: result.total,
          returned_cases: selected.length,
          has_more: more,
          unavailable_fields: ['case_status', 'project_name', 'taxon'],
          usage
        }
      }
      const data = await query(
        ctx,
        `query(${selectorDeclaration}) { biospecimenPerStudy(${selectorArguments}) { ${biospecimenFields} } }`,
        selector(args)
      )
      const records = rows(data.biospecimenPerStudy, ['aliquot_id', 'sample_id', 'case_id'])
      records.sort((a, b) =>
        ['aliquot_id', 'sample_id', 'case_id']
          .map((key) => String(a[key]))
          .join('/')
          .localeCompare(
            ['aliquot_id', 'sample_id', 'case_id'].map((key) => String(b[key])).join('/')
          )
      )
      const result = page(records, args, 'biospecimens')
      const upstreamLimitReached = records.length >= BIOSPECIMEN_UPSTREAM_LIMIT
      return {
        ...result,
        study_selector: selector(args),
        available: records.length,
        total: upstreamLimitReached ? null : records.length,
        upstream_limit_reached: upstreamLimitReached,
        truncated: upstreamLimitReached || result.truncated
      }
    }
  },
  {
    connector: 'pdc',
    id: 'pdc_list_files',
    description:
      'Discover PDC study files, including quantitative reports (data_category: Protein Assembly) and publication supplements. Filters are passed to the official API. Returns metadata and storage paths, not file contents or download URLs. ' +
      versionNote,
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...studyProperties,
        ...paginationProperties,
        data_category: filterString,
        file_type: filterString,
        file_format: filterString,
        file_name: { ...filterString, maxLength: 500 }
      },
      oneOf: studyRequired
    },
    returns:
      '{ files: [{ study_id, pdc_study_id, study_submitter_id, study_name, file_id, file_name, file_submitter_id, file_type, md5sum, file_location, file_size, data_category, file_format }], offset, limit, returned, total: null, has_more, next_offset, truncated, pagination_mode: "upstream", usage }. file_size is the upstream byte-count string. file_location is a storage path, not an authorized download URL. Fetches limit + 1 records to determine has_more; no total is invented. A listed file is not evidence of download permission. Upstream does not guarantee stable ordering or a cross-page snapshot; pinning study_id fixes the version but does not guarantee duplicate-free or complete enumeration across calls.',
    example:
      'const result = await host.mcp("pdc", "pdc_list_files", {"pdc_study_id":"PDC000127", "data_category":"Protein Assembly", "limit":10})',
    maxResponseBytes: 8 * 1024 * 1024,
    run: async (ctx, args) => {
      const { offset, limit } = paging(args)
      const data = await query(
        ctx,
        `query(${selectorDeclaration}, $offset: Int!, $limit: Int!, $data_category: String,
          $file_type: String, $file_format: String, $file_name: String) {
          filesPerStudy(${selectorArguments}, offset: $offset, limit: $limit,
            data_category: $data_category, file_type: $file_type, file_format: $file_format,
            file_name: $file_name) { ${fileFields} }
        }`,
        {
          ...selector(args),
          offset,
          limit: limit + 1,
          data_category: args.data_category,
          file_type: args.file_type,
          file_format: args.file_format,
          file_name: args.file_name
        }
      )
      const records = rows(data.filesPerStudy, ['file_id', 'study_id', 'pdc_study_id'])
      if (records.length > limit + 1)
        throw new Error('Invalid PDC response: upstream ignored file limit')
      const files = records.slice(0, limit)
      const more = records.length > limit
      return {
        files,
        offset,
        limit,
        returned: files.length,
        total: null,
        has_more: more,
        next_offset: more && offset + limit <= MAX_OFFSET ? offset + limit : null,
        truncated: more && offset + limit > MAX_OFFSET,
        pagination_mode: 'upstream',
        usage
      }
    }
  }
]
