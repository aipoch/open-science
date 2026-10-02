import { createHmac } from 'node:crypto'
import type { ToolContext, ToolDescriptor } from '../types'

const DEFAULT_BASE = 'https://api.labarchives.com'
type JsonObject = Record<string, unknown>

const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {})
})

const attributeMap = (raw: string): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const match of raw.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g)) {
    values[match[1]] = match[2]
  }
  return values
}

const tags = (xml: string, name: string): Record<string, string>[] => {
  const values: Record<string, string>[] = []
  for (const match of xml.matchAll(new RegExp(`<${name}\\b([^>]*?)(?:\\/\\s*>|>)`, 'gi'))) {
    values.push(attributeMap(match[1] ?? ''))
  }
  return values
}

const required = (values: Record<string, string>, key: string, subject: string): string => {
  const value = values[key]
  if (!value) throw new Error(`Invalid LabArchives response: missing ${subject} ${key}`)
  return value
}

const parseNotebooks = (xml: string): JsonObject => {
  const notebooks = tags(xml, 'notebook').map((notebook) => ({
    id: required(notebook, 'id', 'notebook'),
    name: required(notebook, 'name', 'notebook'),
    is_default: notebook['is-default'] === 'true' || notebook['is_default'] === 'true'
  }))
  if (notebooks.length === 0) {
    throw new Error('Invalid LabArchives response: missing notebook')
  }
  return { notebooks }
}

const parseEntries = (xml: string): JsonObject => ({
  entries: tags(xml, 'entry').map((entry) => ({
    id: required(entry, 'id', 'entry'),
    name: required(entry, 'name', 'entry'),
    created: entry.created ?? null
  }))
})

const parseEntry = (xml: string): JsonObject => {
  const entry = tags(xml, 'entry')[0]
  if (!entry) throw new Error('Invalid LabArchives response: missing entry')
  return {
    id: required(entry, 'id', 'entry'),
    name: required(entry, 'name', 'entry'),
    created: entry.created ?? null
  }
}

const epochFrom = (xml: string): string => {
  const match = /<epoch>\s*([0-9]+)\s*<\/epoch>/i.exec(xml)
  if (!match?.[1]) throw new Error('Invalid LabArchives response: missing server epoch')
  return match[1]
}

const signatureFor = (
  accessKeyId: string,
  accessPassword: string,
  method: string,
  expires: string
): string =>
  createHmac('sha1', accessPassword).update(`${accessKeyId}${method}${expires}`).digest('base64')

export const buildLabArchivesSignedUrl = (
  baseUrl: string,
  path: string,
  method: string,
  accessKeyId: string,
  accessPassword: string,
  expires: string,
  params: Record<string, string>
): string => {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  url.searchParams.set('akid', accessKeyId)
  url.searchParams.set('expires', expires)
  url.searchParams.set('sig', signatureFor(accessKeyId, accessPassword, method, expires))
  return url.toString()
}

const credentialsFor = (
  ctx: ToolContext
): NonNullable<ToolContext['credentials']['labArchives']> => {
  const credentials = ctx.credentials.labArchives
  if (!credentials?.accessKeyId || !credentials.accessPassword) {
    throw new Error(
      'connector_unauthenticated: LabArchives credentials are unavailable. Configure the LabArchives API key in Settings > Connectors before retrying.'
    )
  }
  return credentials
}

const signedRequest = async (
  ctx: ToolContext,
  path: string,
  method: string,
  params: Record<string, string>,
  body?: URLSearchParams
): Promise<string> => {
  const credentials = credentialsFor(ctx)
  const baseUrl = credentials.apiBaseUrl || DEFAULT_BASE
  const epochUrl = new URL(`${baseUrl.replace(/\/$/, '')}/api/utilities/epoch_time`)
  epochUrl.searchParams.set('akid', credentials.accessKeyId)
  const epoch = epochFrom(await ctx.fetchText(epochUrl.toString()))
  const signed = buildLabArchivesSignedUrl(
    baseUrl,
    path,
    method,
    credentials.accessKeyId,
    credentials.accessPassword,
    epoch,
    params
  )
  if (body) {
    if (!ctx.postUrlEncodedText) {
      throw new Error('connector_runtime_unavailable: URL-encoded requests are not available')
    }
    return ctx.postUrlEncodedText(signed, body)
  }
  return ctx.fetchText(signed)
}

const id = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }

export const LABARCHIVES_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_notebook_info',
    connector: 'labarchives',
    description:
      'Read LabArchives notebook metadata for the configured account and notebook ID. Requests use the API signing scheme and never place the access password in the URL.',
    input: objectSchema({ uid: id, nbid: id }, ['uid', 'nbid']),
    returns: '{ notebooks: [{ id, name, is_default }] }',
    example: 'await host.mcp("labarchives", "get_notebook_info", { uid: "42", nbid: "123.4" })',
    run: async (ctx, args) =>
      parseNotebooks(
        await signedRequest(ctx, '/api/notebooks/notebook_info', 'notebook_info', {
          uid: String(args.uid),
          nbid: String(args.nbid)
        })
      )
  },
  {
    id: 'list_entries',
    connector: 'labarchives',
    description:
      'List entries in a LabArchives notebook. The response is mapped to bounded entry identity and metadata; credentials are never included in the result.',
    input: objectSchema({ uid: id, nbid: id }, ['uid', 'nbid']),
    returns: '{ entries: [{ id, name, created }] }',
    example: 'await host.mcp("labarchives", "list_entries", { uid: "42", nbid: "123.4" })',
    run: async (ctx, args) =>
      parseEntries(
        await signedRequest(ctx, '/api/notebooks/notebook_entries', 'notebook_entries', {
          uid: String(args.uid),
          nbid: String(args.nbid)
        })
      )
  },
  {
    id: 'create_entry',
    connector: 'labarchives',
    approvalClass: 'write-back',
    description:
      'Create a LabArchives notebook entry. This mutates an external system of record; the host requires explicit preview/approval and never retries the mutation automatically.',
    input: objectSchema(
      {
        uid: id,
        nbid: id,
        name: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
        content: { type: 'string', maxLength: 100000 },
        entry_type: { type: 'string', minLength: 1, maxLength: 100 }
      },
      ['uid', 'nbid', 'name']
    ),
    returns: 'The created notebook entry metadata.',
    example:
      'await host.mcp("labarchives", "create_entry", { uid: "42", nbid: "123.4", name: "New result", content: "Result body" })',
    run: async (ctx, args) => {
      const body = new URLSearchParams({
        uid: String(args.uid),
        nbid: String(args.nbid),
        name: String(args.name)
      })
      if (args.content !== undefined) body.set('content', String(args.content))
      if (args.entry_type !== undefined) body.set('entry_type', String(args.entry_type))
      return parseEntry(
        await signedRequest(
          ctx,
          '/api/entries/create_entry',
          'create_entry',
          { uid: String(args.uid), nbid: String(args.nbid) },
          body
        )
      )
    }
  }
]
