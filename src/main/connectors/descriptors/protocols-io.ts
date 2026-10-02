import type { ToolContext, ToolDescriptor } from '../types'

const BASE = 'https://www.protocols.io/api/v3'
const WRITE = { retry: false } as const
type JsonObject = Record<string, unknown>

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid protocols.io response: expected ${label} to be an object`)
  }
  return value as JsonObject
}

const requiredString = (value: unknown, name: string): string => {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) {
    throw new Error(`Invalid protocols.io response: missing ${name}`)
  }
  return String(value)
}

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null
const optionalNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const protocolSummary = (raw: unknown): JsonObject => {
  const protocol = object(raw, 'protocol')
  const steps = Array.isArray(protocol.steps) ? protocol.steps.length : null
  return {
    id: requiredString(protocol.id, 'protocol id'),
    title: requiredString(protocol.title, 'protocol title'),
    description: optionalString(protocol.description),
    doi: optionalString(protocol.doi),
    url: optionalString(protocol.url),
    created_on: optionalNumber(protocol.created_on),
    updated_on: optionalNumber(protocol.updated_on),
    step_count: steps
  }
}

const runSummary = (raw: unknown): JsonObject => {
  const run = object(raw, 'run')
  return {
    id: requiredString(run.id, 'run id'),
    protocol_id: requiredString(run.protocol_id, 'run protocol_id'),
    title: requiredString(run.title, 'run title'),
    started_at: optionalString(run.started_at),
    completed_at: optionalString(run.completed_at),
    notes: optionalString(run.notes),
    status: optionalString(run.status)
  }
}

const authJson = async (
  ctx: ToolContext,
  url: string,
  init: RequestInit = {},
  options?: { retry?: false }
): Promise<unknown> => {
  const token = ctx.credentials.oauthTokens?.['protocols-io']
  if (!token) {
    throw new Error(
      'connector_unauthenticated: protocols.io OAuth token is unavailable. Sign in again from Settings > Connectors before retrying.'
    )
  }
  if (!ctx.requestJson)
    throw new Error('connector_runtime_unavailable: requestJson is not available')
  const result = await ctx.requestJson(
    url,
    {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
        accept: 'application/json'
      }
    },
    options
  )
  return result.body
}

const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {})
})

const id = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[1-9][0-9]*$' }

export const PROTOCOLS_IO_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_protocol',
    connector: 'protocols-io',
    description:
      'Read one protocols.io protocol by numeric ID and return stable metadata plus the step count. Requires the protocols.io OAuth token configured for this connector.',
    input: objectSchema({ protocol_id: id }, ['protocol_id']),
    returns: '{ id, title, description, doi, url, created_on, updated_on, step_count }',
    example: 'await host.mcp("protocols-io", "get_protocol", { protocol_id: "12345" })',
    run: async (ctx, args) =>
      protocolSummary(
        await authJson(ctx, `${BASE}/protocols/${encodeURIComponent(String(args.protocol_id))}`)
      )
  },
  {
    id: 'list_protocol_runs',
    connector: 'protocols-io',
    description:
      'List recorded runs for a protocols.io protocol. Pagination is server-driven; pass the returned next_page back as page on the next call.',
    input: objectSchema(
      {
        protocol_id: id,
        page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
      },
      ['protocol_id']
    ),
    returns:
      '{ runs: [{ id, protocol_id, title, started_at, completed_at, notes, status }], next_page }',
    example:
      'await host.mcp("protocols-io", "list_protocol_runs", { protocol_id: "12345", page_size: 25 })',
    run: async (ctx, args) => {
      const params = new URLSearchParams({
        page: String(args.page ?? 1),
        page_size: String(args.page_size ?? 25)
      })
      const raw = object(
        await authJson(
          ctx,
          `${BASE}/protocols/${encodeURIComponent(String(args.protocol_id))}/runs?${params}`
        ),
        'run list'
      )
      if (!Array.isArray(raw.runs)) {
        throw new Error('Invalid protocols.io response: missing runs')
      }
      return {
        runs: raw.runs.map(runSummary),
        next_page: typeof raw.next_page === 'number' ? raw.next_page : null
      }
    }
  },
  {
    id: 'create_run',
    connector: 'protocols-io',
    approvalClass: 'write-back',
    description:
      'Record a run against a protocols.io protocol. This mutates an external system of record; the host requires explicit preview/approval and never retries the mutation automatically.',
    input: objectSchema(
      {
        protocol_id: id,
        title: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
        started_at: { type: 'string', minLength: 1, maxLength: 100 },
        completed_at: { type: 'string', minLength: 1, maxLength: 100 },
        notes: { type: 'string', maxLength: 10000 }
      },
      ['protocol_id', 'title']
    ),
    returns: 'The created run record.',
    example:
      'await host.mcp("protocols-io", "create_run", { protocol_id: "12345", title: "Run A" })',
    run: async (ctx, args) => {
      const body: JsonObject = { title: args.title }
      if (args.started_at) body.started_at = args.started_at
      if (args.completed_at) body.completed_at = args.completed_at
      if (args.notes !== undefined) body.notes = args.notes
      return runSummary(
        await authJson(
          ctx,
          `${BASE}/protocols/${encodeURIComponent(String(args.protocol_id))}/runs`,
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
    id: 'update_run',
    connector: 'protocols-io',
    approvalClass: 'write-back',
    description:
      'Update a protocols.io run title, completion time, notes, or status. This mutates an external system of record; the host requires explicit preview/approval and never retries the mutation automatically.',
    input: objectSchema(
      {
        protocol_id: id,
        run_id: id,
        title: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
        completed_at: { type: 'string', minLength: 1, maxLength: 100 },
        notes: { type: 'string', maxLength: 10000 },
        status: { type: 'string', minLength: 1, maxLength: 100 }
      },
      ['protocol_id', 'run_id']
    ),
    returns: 'The updated run record.',
    example:
      'await host.mcp("protocols-io", "update_run", { protocol_id: "12345", run_id: "7", status: "complete" })',
    run: async (ctx, args) => {
      const body: JsonObject = {}
      for (const key of ['title', 'completed_at', 'notes', 'status'] as const) {
        if (args[key] !== undefined) body[key] = args[key]
      }
      if (Object.keys(body).length === 0) {
        throw new Error('update_run requires at least one mutable field')
      }
      return runSummary(
        await authJson(
          ctx,
          `${BASE}/protocols/${encodeURIComponent(String(args.protocol_id))}/runs/${encodeURIComponent(String(args.run_id))}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          },
          WRITE
        )
      )
    }
  }
]
