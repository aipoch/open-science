import type { ToolContext, ToolDescriptor } from '../types'

const GDC_API = 'https://api.gdc.cancer.gov'
const MAX_PAGE = 10000
const PAGINATION_NOTE =
  ' Pagination is limited to 10000 pages. next_page is null when no further matches are reported, the total is unknown, or the page limit is reached; it does not by itself prove that all matches were retrieved. Narrow the filters when the page limit is reached with more matches remaining.'
const UUID =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
const FILE_FIELDS = [
  'file_id',
  'file_name',
  'file_size',
  'md5sum',
  'data_format',
  'data_type',
  'data_category',
  'access',
  'state',
  'cases.project.project_id'
].join(',')

type Obj = Record<string, unknown>

const object = (value: unknown, message: string): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Obj
}

const array = (value: unknown, message: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const textOrList = (value: unknown): string | string[] | null => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === 'string')
    return strings.length ? strings : null
  }
  return null
}

const nestedText = (value: unknown, ...path: string[]): string | null => {
  let current: unknown = value
  for (const part of path) {
    if (Array.isArray(current)) current = current[0]
    if (!current || typeof current !== 'object') return null
    current = (current as Obj)[part]
  }
  return text(current)
}

const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

type Access = 'open' | 'controlled' | 'unknown'

const access = (value: unknown): Access =>
  value === 'open' || value === 'controlled' ? value : 'unknown'

const fileSummary = (raw: unknown): Obj => {
  const file = object(raw, 'Invalid GDC response: expected a file object')
  const fileId = text(file.file_id) ?? text(file.id)
  if (!fileId || !new RegExp(UUID).test(fileId)) {
    throw new Error('Invalid GDC response: file is missing a valid UUID')
  }
  const fileAccess = access(file.access)
  const downloadRequiresAuthentication =
    fileAccess === 'controlled' ? true : fileAccess === 'open' ? false : null
  return {
    file_id: fileId,
    file_name: text(file.file_name),
    file_size_bytes: integer(file.file_size),
    md5sum: text(file.md5sum),
    data_format: text(file.data_format),
    data_type: text(file.data_type),
    data_category: text(file.data_category),
    access: fileAccess,
    state: text(file.state),
    project_id:
      text(file['cases.project.project_id']) ??
      text(file.project_id) ??
      nestedText(file, 'cases', 'project', 'project_id'),
    download_url: fileAccess === 'open' ? `${GDC_API}/data/${fileId}` : null,
    download_requires_authentication: downloadRequiresAuthentication,
    download_status:
      fileAccess === 'open'
        ? 'available_without_authentication'
        : fileAccess === 'controlled'
          ? 'requires_authorization'
          : 'access_unknown'
  }
}

const pagination = (payload: Obj, page: number, pageSize: number, returned: number): Obj => {
  const data = object(payload.data, 'Invalid GDC response: missing data')
  const pageInfo = data.pagination == null ? {} : object(data.pagination, 'Invalid GDC pagination')
  const total = integer(pageInfo.total)
  const nextPage = total !== null && page < MAX_PAGE && page * pageSize < total ? page + 1 : null
  return {
    page,
    page_size: pageSize,
    returned,
    total,
    total_relation: total === null ? 'unknown' : 'eq',
    next_page: nextPage
  }
}

const resultData = (raw: unknown): { payload: Obj; hits: Obj[] } => {
  const payload = object(raw, 'Invalid GDC response: expected an object')
  const data = object(payload.data, 'Invalid GDC response: missing data')
  const hits = array(data.hits, 'Invalid GDC response: missing data.hits').map((hit) =>
    object(hit, 'Invalid GDC response: hit is not an object')
  )
  return { payload, hits }
}

const filter = (field: string, values: string[]): Obj => ({
  op: 'in',
  content: { field, value: values }
})

const andFilters = (filters: Obj[]): Obj | undefined =>
  filters.length === 0
    ? undefined
    : filters.length === 1
      ? filters[0]
      : { op: 'and', content: filters }

const values = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value == null ? [] : [value]).map(String)

const pageArgs = (
  args: Record<string, unknown>
): { page: number; pageSize: number; from: number } => {
  const page = Number(args.page ?? 1)
  const pageSize = Number(args.page_size ?? 20)
  return { page, pageSize, from: (page - 1) * pageSize }
}

const postSearch = async (
  ctx: ToolContext,
  endpoint: 'projects' | 'cases' | 'files',
  body: Obj
): Promise<unknown> => ctx.postJson(`${GDC_API}/${endpoint}`, body)

const listProjects = async (ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> => {
  const { page, pageSize, from } = pageArgs(args)
  const filters: Obj[] = []
  const projectIds = values(args.project_ids)
  if (projectIds.length) filters.push(filter('project_id', projectIds))
  if (args.disease_type != null) filters.push(filter('disease_type', [String(args.disease_type)]))
  if (args.primary_site != null) filters.push(filter('primary_site', [String(args.primary_site)]))
  const raw = await postSearch(ctx, 'projects', {
    filters: andFilters(filters),
    fields: [
      'project_id',
      'name',
      'program.name',
      'disease_type',
      'primary_site',
      'state',
      'dbgap_accession_number',
      'summary.case_count',
      'summary.file_count',
      'summary.data_categories.data_category',
      'summary.data_categories.file_count'
    ].join(','),
    format: 'JSON',
    from,
    size: pageSize
  })
  const { payload, hits } = resultData(raw)
  const records = hits.map((project) => ({
    project_id: text(project.project_id) ?? text(project.id),
    name: text(project.name),
    program: text(project['program.name']) ?? nestedText(project, 'program', 'name'),
    disease_type: textOrList(project.disease_type),
    primary_site: textOrList(project.primary_site),
    state: text(project.state),
    dbgap_accession_number: text(project.dbgap_accession_number),
    case_count: integer(object(project.summary ?? {}, 'Invalid GDC project.summary').case_count),
    file_count: integer(object(project.summary ?? {}, 'Invalid GDC project.summary').file_count)
  }))
  return { ...pagination(payload, page, pageSize, records.length), projects: records }
}

const listCases = async (ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> => {
  const { page, pageSize, from } = pageArgs(args)
  const filters: Obj[] = []
  const projectIds = values(args.project_ids)
  const submitterIds = values(args.submitter_ids)
  const caseIds = values(args.case_ids)
  if (projectIds.length) filters.push(filter('project.project_id', projectIds))
  if (submitterIds.length) filters.push(filter('submitter_id', submitterIds))
  if (caseIds.length) filters.push(filter('case_id', caseIds))
  const raw = await postSearch(ctx, 'cases', {
    filters: andFilters(filters),
    fields: [
      'case_id',
      'submitter_id',
      'project.project_id',
      'project.name',
      'disease_type',
      'primary_site',
      'state'
    ].join(','),
    format: 'JSON',
    from,
    size: pageSize
  })
  const { payload, hits } = resultData(raw)
  const records = hits.map((item) => ({
    case_id: text(item.case_id) ?? text(item.id),
    submitter_id: text(item.submitter_id),
    project_id: text(item['project.project_id']) ?? nestedText(item, 'project', 'project_id'),
    project_name: text(item['project.name']) ?? nestedText(item, 'project', 'name'),
    disease_type: textOrList(item.disease_type),
    primary_site: textOrList(item.primary_site),
    state: text(item.state)
  }))
  return { ...pagination(payload, page, pageSize, records.length), cases: records }
}

const searchFiles = async (ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> => {
  const { page, pageSize, from } = pageArgs(args)
  const filters: Obj[] = []
  const projectIds = values(args.project_ids)
  if (projectIds.length) filters.push(filter('cases.project.project_id', projectIds))
  if (args.access != null && args.access !== 'all')
    filters.push(filter('files.access', [String(args.access)]))
  if (args.data_category != null)
    filters.push(filter('files.data_category', [String(args.data_category)]))
  if (args.data_type != null) filters.push(filter('files.data_type', [String(args.data_type)]))
  if (args.data_format != null)
    filters.push(filter('files.data_format', [String(args.data_format)]))
  if (args.file_name != null) filters.push(filter('files.file_name', [String(args.file_name)]))
  const raw = await postSearch(ctx, 'files', {
    filters: andFilters(filters),
    fields: FILE_FIELDS,
    format: 'JSON',
    from,
    size: pageSize
  })
  const { payload, hits } = resultData(raw)
  const files = hits.map(fileSummary)
  const accessSummary = { open: 0, controlled: 0, unknown: 0 }
  for (const file of files) accessSummary[file.access as keyof typeof accessSummary]++
  return {
    ...pagination(payload, page, pageSize, files.length),
    access_summary: accessSummary,
    controlled_files_require_authorization: accessSummary.controlled > 0,
    files,
    download_note:
      'This tool returns metadata only. A file being listed does not guarantee that it can be downloaded; controlled-access data requires GDC authorization and an X-Auth-Token.'
  }
}

const parseFile = (raw: unknown): unknown => {
  const payload = object(raw, 'Invalid GDC response: expected an object')
  return {
    file: fileSummary(payload.data ?? payload),
    download_note:
      'This tool returns metadata only. Controlled-access data requires GDC authorization and an X-Auth-Token.'
  }
}

const getManifest = async (ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> => {
  const fileIds = values(args.file_ids)
  const manifest = await ctx.fetchText(
    `${GDC_API}/v0/manifest/${fileIds.map((id) => encodeURIComponent(id)).join(',')}`,
    'text/plain'
  )
  return {
    file_ids: fileIds,
    manifest,
    download_note:
      'A manifest is an inventory for the GDC Data Transfer Tool, not a download. Controlled-access entries still require appropriate GDC authorization and an X-Auth-Token.'
  }
}

export const GDC_TOOLS: ToolDescriptor[] = [
  {
    connector: 'gdc',
    id: 'gdc_list_projects',
    description:
      'List GDC cancer projects and their case/file summaries. Filters are explicit and bounded; this is metadata discovery, not a data download operation.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project_ids: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 100 }
          ]
        },
        disease_type: { type: 'string', minLength: 1, maxLength: 200 },
        primary_site: { type: 'string', minLength: 1, maxLength: 200 },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      }
    },
    returns:
      '`{ page, page_size, returned, total, total_relation, next_page, projects: [{ project_id, name, program, disease_type, primary_site, state, dbgap_accession_number, case_count, file_count }] }`. Project/file counts are summaries from GDC metadata; no files are downloaded.' +
      PAGINATION_NOTE,
    example:
      'const result = await host.mcp("gdc", "gdc_list_projects", {"project_ids": "TCGA-BRCA", "page_size": 5})',
    run: listProjects
  },
  {
    connector: 'gdc',
    id: 'gdc_list_cases',
    description:
      'List GDC cases (sample donors) with project and disease metadata. Results identify cases and do not expose or download controlled data.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project_ids: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 100 }
          ]
        },
        submitter_ids: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 100 }
          ]
        },
        case_ids: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 100 }
          ]
        },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      }
    },
    returns:
      '`{ page, page_size, returned, total, total_relation, next_page, cases: [{ case_id, submitter_id, project_id, project_name, disease_type, primary_site, state }] }`. Case metadata is returned without file contents.' +
      PAGINATION_NOTE,
    example:
      'const result = await host.mcp("gdc", "gdc_list_cases", {"project_ids": ["TCGA-BRCA"], "page_size": 5})',
    run: listCases
  },
  {
    connector: 'gdc',
    id: 'gdc_search_files',
    description:
      'Search the GDC file inventory and explicitly label each file as open or controlled access. Metadata discovery does not grant download access; controlled files require appropriate GDC authorization.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project_ids: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 100 }
          ]
        },
        access: { type: 'string', enum: ['all', 'open', 'controlled'], default: 'all' },
        data_category: { type: 'string', minLength: 1, maxLength: 200 },
        data_type: { type: 'string', minLength: 1, maxLength: 200 },
        data_format: { type: 'string', minLength: 1, maxLength: 50 },
        file_name: { type: 'string', minLength: 1, maxLength: 500 },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      }
    },
    returns:
      '`{ page, page_size, returned, total, total_relation, next_page, access_summary: { open, controlled, unknown }, controlled_files_require_authorization, files: [{ file_id, file_name, file_size_bytes, md5sum, data_format, data_type, data_category, access, state, project_id, download_url, download_requires_authentication, download_status }], download_note }`. Open files expose a public data URL; controlled files deliberately expose no downloadable URL and are marked `requires_authorization`. No file bytes are downloaded. access_summary and controlled_files_require_authorization describe only the returned page. project_id is a single related-project summary; nested cases use the first case, not a complete list of related projects.' +
      PAGINATION_NOTE,
    example:
      'const result = await host.mcp("gdc", "gdc_search_files", {"project_ids": ["TCGA-BRCA"], "access": "open", "page_size": 10})',
    run: searchFiles
  },
  {
    connector: 'gdc',
    id: 'gdc_get_file',
    description:
      'Retrieve metadata for one GDC file UUID, including its open/controlled access classification. This performs no file download and does not claim that a listed file is downloadable for the current user.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { file_id: { type: 'string', pattern: UUID } },
      required: ['file_id']
    },
    returns:
      '`{ file: { file_id, file_name, file_size_bytes, md5sum, data_format, data_type, data_category, access, state, project_id, download_url, download_requires_authentication, download_status }, download_note }`. `download_url` is only returned for open-access files; controlled-access files require authorization and an `X-Auth-Token` outside this metadata call. project_id is a single related-project summary; nested cases use the first case, not a complete list of related projects.',
    example:
      'const result = await host.mcp("gdc", "gdc_get_file", {"file_id": "cb92f61d-041c-4424-a3e9-891b7545f351"})',
    url: (args) =>
      `${GDC_API}/files/${encodeURIComponent(String(args.file_id))}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    parse: parseFile
  },
  {
    connector: 'gdc',
    id: 'gdc_get_manifest',
    description:
      'Create a GDC Data Transfer Tool manifest for up to 100 file UUIDs. The returned manifest is an inventory only; it does not download files or bypass controlled-access authorization.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_ids: {
          type: 'array',
          items: { type: 'string', pattern: UUID },
          minItems: 1,
          maxItems: 100,
          uniqueItems: true
        }
      },
      required: ['file_ids']
    },
    returns:
      '`{ file_ids: [str], manifest: str, download_note }`. `manifest` is the GDC Data Transfer Tool inventory text. It does not establish that every entry is downloadable; controlled-access entries still require authorization. Match manifest rows by UUID, not request order. If any requested UUID is not found, the request fails with HTTP 404 rather than returning a partial manifest.',
    example:
      'const result = await host.mcp("gdc", "gdc_get_manifest", {"file_ids": ["cb92f61d-041c-4424-a3e9-891b7545f351"]})',
    run: getManifest
  }
]
