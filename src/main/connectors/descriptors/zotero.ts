import type { ToolContext, ToolDescriptor } from '../types'

const BASE = 'https://api.zotero.org'
const numericId = { type: 'string', pattern: '^[1-9][0-9]{0,19}$' }
const key = { type: 'string', pattern: '^[A-Z0-9]{8}$' }
const libraryProperties = {
  library_type: {
    type: 'string',
    enum: ['user', 'group'],
    description: 'Public user library or public group library.'
  },
  library_id: { ...numericId, description: 'Numeric user/group ID from Zotero; not a username.' }
}
const pagingProperties = {
  start: {
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'Offset; default 0. Use next_start to continue.'
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description: 'Page size; default 25, maximum 100.'
  }
}
const libraryRequired = ['library_type', 'library_id']
const input = (
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const libraryPath = (a: Record<string, unknown>): string =>
  `/${a.library_type === 'group' ? 'groups' : 'users'}/${a.library_id}`
const urlFor = (path: string, params: Record<string, string> = {}): string => {
  const url = new URL(`${BASE}${path}`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return url.toString()
}

// Return a bounded page without following upstream links.
async function page(
  ctx: ToolContext,
  path: string,
  a: Record<string, unknown>,
  params: Record<string, string> = {}
): Promise<unknown> {
  const start = Number(a.start ?? 0)
  const limit = Number(a.limit ?? 25)
  const { body, headers } = await ctx.fetchJsonWithHeaders(
    urlFor(path, {
      ...params,
      format: 'json',
      start: String(start),
      limit: String(limit)
    })
  )
  if (!Array.isArray(body)) throw new Error('Invalid Zotero list response')
  const totalHeader = headers.get('Total-Results')
  const total =
    totalHeader !== null && /^\d+$/.test(totalHeader) && Number.isSafeInteger(Number(totalHeader))
      ? Number(totalHeader)
      : null
  // Missing totals must not turn a full page into a false claim of completeness.
  const nextStart = start + body.length
  const more = total === null ? body.length === limit : nextStart < total
  if (body.length === 0 && more)
    throw new Error('Zotero returned an empty page before Total-Results; retry the search')
  if (more && !Number.isSafeInteger(nextStart))
    throw new Error('Zotero pagination exceeds the supported offset range; narrow the search')
  return {
    records: body,
    total_results: total,
    start,
    limit,
    next_start: more ? nextStart : null,
    library_version: headers.get('Last-Modified-Version'),
    // A caller paging a changing library can compare versions and restart if consistency matters.
    records_returned: body.length
  }
}

const pageReturns =
  '{records, total_results (null if unavailable), start, limit, next_start (null at end), library_version (string or null if unavailable), records_returned}. One page only; repeat with next_start. Compare non-null library_version values across pages and restart if they change. Missing versions, including on group listings, cannot establish a consistent snapshot.'

export const ZOTERO_TOOLS: ToolDescriptor[] = [
  {
    id: 'zotero_list_groups',
    connector: 'zotero',
    description:
      'List publicly visible Zotero groups for a user. Membership does not imply that a group library or its notes are public. User ID is numeric, not a username.',
    input: input({ user_id: numericId, ...pagingProperties }, ['user_id']),
    required: ['user_id'],
    returns: pageReturns,
    example: 'const result = await host.mcp("zotero", "zotero_list_groups", {"user_id": "475425"})',
    run: (ctx, a) => page(ctx, `/users/${a.user_id}/groups`, a)
  },
  {
    id: 'zotero_list_collections',
    example:
      'const result = await host.mcp("zotero", "zotero_list_collections", {"library_type": "user", "library_id": "475425"})',
    connector: 'zotero',
    description:
      'List top-level collections in a public user or group Zotero library, or immediate subcollections of collection_key. Use returned collection keys with search_items.',
    input: input(
      { ...libraryProperties, collection_key: key, ...pagingProperties },
      libraryRequired
    ),
    required: libraryRequired,
    returns: pageReturns,
    run: (ctx, a) =>
      page(
        ctx,
        `${libraryPath(a)}/collections/${a.collection_key ? `${a.collection_key}/collections` : 'top'}`,
        a
      )
  },
  {
    id: 'zotero_search_items',
    connector: 'zotero',
    description:
      'Search a public Zotero library by phrase (title/creator/year), tag search expression or item-type search expression (e.g. journalArticle). Optionally restrict to a collection. By default returns top-level items, excluding child notes/attachments and trash. Set include_children for all matching items, including notes/attachments. Only publicly accessible content is available. This is not a semantic or full-PDF search.',
    input: input(
      {
        ...libraryProperties,
        ...pagingProperties,
        collection_key: key,
        query: { type: 'string', minLength: 1, maxLength: 1000 },
        tag: {
          type: 'string',
          minLength: 1,
          maxLength: 1000,
          description: 'Zotero tag syntax: spaces are literal; || means OR; leading - means NOT.'
        },
        item_type: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Zotero itemType search expression, e.g. journalArticle, note, or -attachment.'
        },
        include_children: { type: 'boolean', default: false },
        sort: {
          type: 'string',
          enum: ['dateModified', 'dateAdded', 'title', 'creator', 'date'],
          default: 'dateModified'
        },
        direction: { type: 'string', enum: ['asc', 'desc'], default: 'desc' }
      },
      libraryRequired
    ),
    required: libraryRequired,
    returns: pageReturns,
    example:
      'const result = await host.mcp("zotero", "zotero_search_items", {"library_type": "user", "library_id": "475425", "query": "single cell", "limit": 25})',
    run: (ctx, a) => {
      const params: Record<string, string> = {
        sort: String(a.sort ?? 'dateModified'),
        direction: String(a.direction ?? 'desc'),
        qmode: 'titleCreatorYear'
      }
      if (a.query) params.q = String(a.query)
      if (a.tag) params.tag = String(a.tag)
      if (a.item_type) params.itemType = String(a.item_type)
      const collection = a.collection_key ? `/collections/${a.collection_key}` : ''
      return page(
        ctx,
        `${libraryPath(a)}${collection}/items${a.include_children ? '' : '/top'}`,
        a,
        params
      )
    }
  },
  {
    id: 'zotero_get_item',
    example:
      'const result = await host.mcp("zotero", "zotero_get_item", {"library_type": "user", "library_id": "475425", "item_key": "7VLLCTW7"})',
    connector: 'zotero',
    description:
      'Read a publicly accessible Zotero item by its eight-character key, including bibliographic fields, abstract, creators, DOI, tags and links. Note HTML is returned as data. Attachments return metadata only; linked local files are not accessible through this API.',
    input: input({ ...libraryProperties, item_key: key }, [...libraryRequired, 'item_key']),
    required: [...libraryRequired, 'item_key'],
    returns:
      'Zotero item JSON: {key, version, library, links, meta, data}. Fields depend on itemType; note HTML and attachment metadata remain in data.',
    run: async (ctx, a) => {
      const body = await ctx.fetchJson(
        urlFor(`${libraryPath(a)}/items/${a.item_key}`, { format: 'json' })
      )
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !('key' in body) ||
        !('data' in body)
      )
        throw new Error('Invalid Zotero item response')
      return body
    }
  },
  {
    id: 'zotero_get_item_children',
    example:
      'const result = await host.mcp("zotero", "zotero_get_item_children", {"library_type": "user", "library_id": "475425", "item_key": "7VLLCTW7"})',
    connector: 'zotero',
    description:
      'Read a public reference’s accessible child notes and attachment metadata (filename, contentType, linkMode and links where supplied). Note HTML is returned as data, not rendered. Does not download PDFs; local linked files and unsynced attachments may be unavailable. Only publicly accessible notes and metadata are available.',
    input: input({ ...libraryProperties, item_key: key, ...pagingProperties }, [
      ...libraryRequired,
      'item_key'
    ]),
    required: [...libraryRequired, 'item_key'],
    returns: pageReturns,
    run: (ctx, a) => page(ctx, `${libraryPath(a)}/items/${a.item_key}/children`, a)
  }
]
