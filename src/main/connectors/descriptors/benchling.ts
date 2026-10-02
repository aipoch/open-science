import type { ToolContext, ToolDescriptor } from '../types'

const BASE = 'https://api.benchling.com'
const WRITE = { retry: false } as const
type JsonObject = Record<string, unknown>

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Benchling response: expected ${label} to be an object`)
  }
  return value as JsonObject
}

const string = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid Benchling response: missing ${name}`)
  }
  return value
}

const optionalString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const objectId = (value: unknown): string | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? optionalString((value as JsonObject).id)
    : null

const entrySummary = (raw: unknown): JsonObject => {
  const entry = object(raw, 'entry')
  return {
    id: string(entry.id, 'entry id'),
    name: string(entry.name, 'entry name'),
    display_id: optionalString(entry.displayId),
    created_at: optionalString(entry.createdAt),
    modified_at: optionalString(entry.modifiedAt),
    archived: typeof entry.archived === 'boolean' ? entry.archived : null,
    folder_id: objectId(entry.folder),
    schema_id: objectId(entry.schema),
    version_id:
      entry.versionMetadata && typeof entry.versionMetadata === 'object'
        ? optionalString((entry.versionMetadata as JsonObject).versionId)
        : null,
    parts_url: optionalString(entry.parts)
  }
}

const page = (
  raw: unknown,
  collection: string,
  item: (value: unknown) => JsonObject
): { items: JsonObject[]; next_token: string | null } => {
  const body = object(raw, 'list response')
  const values = body[collection]
  if (!Array.isArray(values)) {
    throw new Error(`Invalid Benchling response: missing ${collection}`)
  }
  return {
    items: values.map(item),
    next_token: optionalString(body.nextToken)
  }
}

const authJson = async (
  ctx: ToolContext,
  url: string,
  init: RequestInit = {},
  options?: { retry?: false }
): Promise<unknown> => {
  const token = ctx.credentials.oauthTokens?.benchling
  if (!token) {
    throw new Error(
      'connector_unauthenticated: Benchling OAuth token is unavailable. Sign in again from Settings > Connectors before retrying.'
    )
  }
  if (!ctx.requestJson)
    throw new Error('connector_runtime_unavailable: requestJson is not available')
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    authorization: `Bearer ${token}`,
    accept: 'application/json'
  }
  const result = await ctx.requestJson(url, { ...init, headers }, options)
  return result.body
}

const query = (values: Array<[string, unknown]>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of values) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {})
})

const id = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }
const pageSize = { type: 'integer', minimum: 1, maximum: 100, default: 50 }
const nextToken = { type: 'string', minLength: 1, maxLength: 4096, pattern: '\\S' }

export const BENCHLING_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_entry',
    connector: 'benchling',
    description:
      'Read one Benchling notebook entry by its stable API ID, including the entry metadata and the URL of its paginated document parts. Requires the Benchling OAuth token configured for this connector; read calls are retry-safe.',
    input: objectSchema({ entry_id: id }, ['entry_id']),
    returns:
      '{ id, name, display_id, created_at, modified_at, archived, folder_id, schema_id, version_id, parts_url }',
    example: 'await host.mcp("benchling", "get_entry", { entry_id: "etr_8rVKW0g7" })',
    run: async (ctx, args) =>
      entrySummary(
        await authJson(ctx, `${BASE}/api/v3/entry/${encodeURIComponent(String(args.entry_id))}`)
      )
  },
  {
    id: 'list_custom_entities',
    connector: 'benchling',
    description:
      'List Benchling Registry custom entities with optional name and schema filters. Pagination uses the upstream nextToken; pass it back unchanged to retrieve the next page.',
    input: objectSchema({
      name: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
      schema_id: id,
      page_size: pageSize,
      next_token: nextToken
    }),
    returns: '{ items: [{ id, name, schema_id }], next_token }',
    example:
      'await host.mcp("benchling", "list_custom_entities", { name: "Sample 1", page_size: 25 })',
    run: async (ctx, args) => {
      const url =
        `${BASE}/api/v2/custom-entities` +
        query([
          ['name', args.name],
          ['schemaId', args.schema_id],
          ['pageSize', args.page_size ?? 50],
          ['nextToken', args.next_token]
        ])
      return page(await authJson(ctx, url), 'customEntities', (raw) => {
        const entity = object(raw, 'custom entity')
        return {
          id: string(entity.id, 'custom entity id'),
          name: string(entity.name, 'custom entity name'),
          schema_id: optionalString(entity.schemaId)
        }
      })
    }
  },
  {
    id: 'list_assay_results',
    connector: 'benchling',
    description:
      'List Benchling assay results with optional schema and project filters. Pagination uses nextToken; result fields are returned as stored by Benchling.',
    input: objectSchema({
      schema_id: id,
      project_id: id,
      page_size: pageSize,
      next_token: nextToken
    }),
    returns: '{ items: [{ id, schema_id, project_id, fields }], next_token }',
    example:
      'await host.mcp("benchling", "list_assay_results", { schema_id: "assaysch_FL4k8H51" })',
    run: async (ctx, args) => {
      const url =
        `${BASE}/api/v2/assay-results` +
        query([
          ['schemaId', args.schema_id],
          ['projectId', args.project_id],
          ['pageSize', args.page_size ?? 50],
          ['nextToken', args.next_token]
        ])
      return page(await authJson(ctx, url), 'assayResults', (raw) => {
        const result = object(raw, 'assay result')
        return {
          id: string(result.id, 'assay result id'),
          schema_id: string(result.schemaId, 'assay result schemaId'),
          project_id: optionalString(result.projectId),
          fields: result.fields && typeof result.fields === 'object' ? result.fields : {}
        }
      })
    }
  },
  {
    id: 'create_entry',
    connector: 'benchling',
    approvalClass: 'write-back',
    description:
      'Create a Benchling notebook entry in an existing folder. This mutates the external system of record; the host requires explicit preview/approval and never retries the mutation automatically.',
    input: objectSchema(
      {
        name: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
        folder_id: id,
        schema_id: id,
        parts: {
          type: 'array',
          maxItems: 100,
          items: { type: 'object', additionalProperties: true }
        }
      },
      ['name', 'folder_id']
    ),
    returns: 'The created Benchling entry summary, including id and version_id.',
    example:
      'await host.mcp("benchling", "create_entry", { name: "Protein assay", folder_id: "lib_abc123" })',
    run: async (ctx, args) => {
      const body: JsonObject = { name: args.name, folderId: args.folder_id }
      if (args.schema_id) body.schemaId = args.schema_id
      if (args.parts) body.parts = args.parts
      return entrySummary(
        await authJson(
          ctx,
          `${BASE}/api/v3/entry`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          },
          WRITE
        )
      )
    }
  },
  {
    id: 'update_entry',
    connector: 'benchling',
    approvalClass: 'write-back',
    description:
      'Update Benchling entry metadata or apply an explicit document parts mutation. This mutates the external system of record; the host requires explicit preview/approval and never retries the mutation automatically.',
    input: objectSchema(
      {
        entry_id: id,
        name: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
        parts_mutation: { type: 'object', additionalProperties: true }
      },
      ['entry_id']
    ),
    returns: 'The updated Benchling entry summary, including the resulting version_id.',
    example:
      'await host.mcp("benchling", "update_entry", { entry_id: "etr_8rVKW0g7", name: "Updated assay" })',
    run: async (ctx, args) => {
      if (args.name === undefined && args.parts_mutation === undefined) {
        throw new Error('update_entry requires name or parts_mutation')
      }
      const body: JsonObject = {}
      if (args.name !== undefined) body.name = args.name
      if (args.parts_mutation !== undefined) body.partsMutation = args.parts_mutation
      return entrySummary(
        await authJson(
          ctx,
          `${BASE}/api/v3/entry/${encodeURIComponent(String(args.entry_id))}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          },
          WRITE
        )
      )
    }
  },
  {
    id: 'create_assay_results',
    connector: 'benchling',
    approvalClass: 'write-back',
    description:
      'Create one or more Benchling assay results against an assay schema and project. This mutates the external system of record; the host requires explicit preview/approval and never retries the mutation automatically.',
    input: objectSchema(
      {
        schema_id: id,
        project_id: id,
        fields: { type: 'object', additionalProperties: true },
        field_validation: { type: 'object', additionalProperties: true }
      },
      ['schema_id', 'project_id', 'fields']
    ),
    returns: '{ items: [{ id, schema_id, project_id, fields }] }',
    example:
      'await host.mcp("benchling", "create_assay_results", { schema_id: "assaysch_FL4k8H51", project_id: "src_wMsnz0ru", fields: { ct: 11.115 } })',
    run: async (ctx, args) => {
      const result: JsonObject = {
        schemaId: args.schema_id,
        projectId: args.project_id,
        fields: args.fields
      }
      if (args.field_validation !== undefined) result.fieldValidation = args.field_validation
      const raw = await authJson(
        ctx,
        `${BASE}/api/v2/assay-results`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assayResults: [result] })
        },
        WRITE
      )
      const values = Array.isArray(raw) ? raw : object(raw, 'assay result response').assayResults
      if (!Array.isArray(values))
        throw new Error('Invalid Benchling response: missing assayResults')
      return {
        items: values.map((value) => {
          const item = object(value, 'assay result')
          return {
            id: string(item.id, 'assay result id'),
            schema_id: string(item.schemaId, 'assay result schemaId'),
            project_id: optionalString(item.projectId),
            fields: item.fields && typeof item.fields === 'object' ? item.fields : {}
          }
        })
      }
    }
  }
]
