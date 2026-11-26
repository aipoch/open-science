import { createHash } from 'node:crypto'
import type { AgentContext, McpServer } from '@agentclientprotocol/sdk'
import { methods } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { AgentTool, AgentSession, PendingTool, Json } from '@aipoch/agent-harness'
import { ToolValidationError } from '@aipoch/agent-harness'
import { loadMcpTools, mcpToolResult } from '@aipoch/agent-harness/mcp'
import {
  HARNESS_RECEIPTS,
  HARNESS_INVOCATION,
  HARNESS_RECEIPT_METHOD,
  receiptResponseSchema
} from './tool-receipts'
import {
  SCHEDULE_MCP_NAME,
  SCHEDULE_TURN_META,
  SCHEDULE_INVOCATION_META
} from '../../shared/session-schedules'
import { modelFacingAppMcpToolName } from '../agent-framework/app-mcp-names'
import { fetchOverSocket } from '../local-rpc-transport'
import { readReviewerMcpSocketPath } from '../agent-framework/reviewer-mcp-transport'

/** Connection ownership and permission UX are host policy, not package loop policy. */
export async function connectHarnessMcp(input: {
  servers: readonly McpServer[]
  sessionId: string
  context: AgentContext
  signal: AbortSignal
  beforePermission(): Promise<void>
}): Promise<{
  setScheduleTurn(ref: string | undefined): void
  tools: AgentTool[]
  toolNames: ReadonlyMap<string, string>
  close(): Promise<void>
  reconcile(session: AgentSession): Promise<void>
}> {
  let scheduleTurn: string | undefined
  const scheduleInvocations = new Map<string, string>()
  const clients: Client[] = []
  const tools: AgentTool[] = []
  const toolNames = new Map<string, string>()
  const recoveries = new Map<
    string,
    (pending: PendingTool, session: AgentSession) => Promise<void>
  >()
  const close = async (): Promise<void> => {
    const results = await Promise.allSettled(clients.map((client) => client.close()))
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length) throw new AggregateError(errors, 'Built-in Agent MCP cleanup failed')
  }
  try {
    for (const server of input.servers) {
      input.signal.throwIfAborted()
      if (!('type' in server) || server.type !== 'http')
        throw new Error('Built-in Agent requires host-provided HTTP MCP servers')
      const socketPath = readReviewerMcpSocketPath(server)
      const url = new URL(server.url)
      if (
        url.username ||
        url.password ||
        url.hash ||
        (!socketPath &&
          url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
      )
        throw new Error('Invalid MCP endpoint')
      const client = new Client({ name: 'open-science-agent', version: '0.1.0' })
      clients.push(client)
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          ...(socketPath ? { fetch: fetchOverSocket(socketPath) } : {}),
          requestInit: {
            headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
            redirect: 'error'
          }
        }),
        { signal: input.signal }
      )
      const receipts =
        client.getServerCapabilities()?.experimental?.[HARNESS_RECEIPTS] !== undefined
      const schedule = server.name.replace(/_/g, '-') === SCHEDULE_MCP_NAME
      const validator = new AjvJsonSchemaValidator()
      const outputValidators = new Map<string, (value: Json) => void>()
      const discovered = await loadMcpTools({
        signal: input.signal,
        client: {
          listTools: (cursor, signal) => client.listTools(cursor ? { cursor } : {}, { signal }),
          callTool: async (name, args, context) => {
            const captured = scheduleInvocations.get(context.invocationId)
            if (schedule && !captured)
              throw new Error('Schedule invocation has no authorized turn.')
            try {
              return await client.callTool(
                {
                  name,
                  arguments: args,
                  ...(receipts || schedule
                    ? {
                        _meta: {
                          ...(receipts ? { [HARNESS_INVOCATION]: context.invocationId } : {}),
                          ...(schedule
                            ? {
                                [SCHEDULE_TURN_META]: captured,
                                [SCHEDULE_INVOCATION_META]: context.invocationId
                              }
                            : {})
                        }
                      }
                    : {})
                },
                undefined,
                {
                  signal: context.signal,
                  resetTimeoutOnProgress: true,
                  onprogress: (progress) => {
                    if (progress.message) context.update([{ type: 'text', text: progress.message }])
                  }
                }
              )
            } finally {
              if (schedule) scheduleInvocations.delete(context.invocationId)
            }
          }
        },
        bind(definition) {
          const parameters = structuredClone(definition.inputSchema) as Record<string, Json>
          if (schedule) {
            const properties = parameters.properties as Record<string, Json>
            delete properties.turnRef
            delete properties.requestId
            if (Array.isArray(parameters.required))
              parameters.required = parameters.required.filter(
                (key) => key !== 'turnRef' && key !== 'requestId'
              )
          }
          const validate = validator.getValidator<Json>(parameters)
          const output =
            definition.outputSchema === undefined
              ? undefined
              : validator.getValidator<Json>(definition.outputSchema as Record<string, unknown>)
          if (output)
            outputValidators.set(definition.name, (value) => {
              if (!output(value).valid) throw new Error('Invalid MCP tool output')
            })
          return {
            parameters,
            ...(schedule
              ? {
                  description:
                    definition.description +
                    ' This host supplies turnRef and requestId automatically; do not include them.'
                }
              : {}),
            validate(value) {
              const result = validate(value)
              if (!result.valid) {
                // Expose schema-owned field names only, never raw validator text or argument values.
                const missing: { path: string; expected: string }[] = []
                const collectMissing = (
                  schema: Json,
                  input: Json,
                  path: string,
                  depth: number
                ): void => {
                  if (
                    depth > 16 ||
                    missing.length >= 8 ||
                    !schema ||
                    typeof schema !== 'object' ||
                    Array.isArray(schema) ||
                    !input ||
                    typeof input !== 'object' ||
                    Array.isArray(input)
                  )
                    return
                  if (Array.isArray(schema.required)) {
                    for (const key of schema.required) {
                      if (
                        typeof key === 'string' &&
                        !Object.hasOwn(input, key) &&
                        missing.length < 8
                      )
                        missing.push({ path: `${path}.${key}`, expected: 'required field' })
                    }
                  }
                  const properties = schema.properties
                  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
                    for (const [key, child] of Object.entries(properties)) {
                      if (Object.hasOwn(input, key))
                        collectMissing(child, input[key], `${path}.${key}`, depth + 1)
                    }
                  }
                }
                collectMissing(parameters, value, '$', 0)
                throw new ToolValidationError(
                  missing.length
                    ? missing
                    : [{ path: '$', expected: 'arguments matching the tool schema' }]
                )
              }
              return result.data
            },
            ...(output
              ? {
                  validateOutput(value: Json): void {
                    if (!output(value).valid) throw new Error('Invalid MCP tool output')
                  }
                }
              : {}),
            async authorize(args, context) {
              const captured = scheduleTurn
              if (schedule && !captured) return false
              // The broker correlates this request with the preceding tool-call notification.
              await input.beforePermission()
              context.signal.throwIfAborted()
              const result = await input.context.request(
                methods.client.session.requestPermission,
                {
                  sessionId: input.sessionId,
                  toolCall: {
                    toolCallId: context.invocationId,
                    title: modelFacingAppMcpToolName(
                      'open-science-agent',
                      server.name,
                      definition.name
                    ),
                    _meta: {
                      toolName: modelFacingAppMcpToolName(
                        'open-science-agent',
                        server.name,
                        definition.name
                      )
                    },
                    kind:
                      server.name === 'open-science-web' && definition.name === 'web_fetch'
                        ? 'fetch'
                        : server.name === 'open-science-web' && definition.name === 'web_search'
                          ? 'search'
                          : 'other',
                    status: 'pending',
                    rawInput: args
                  },
                  options: [
                    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'deny', name: 'Reject', kind: 'reject_once' }
                  ]
                },
                { cancellationSignal: context.signal }
              )
              context.signal.throwIfAborted()
              const allowed =
                result.outcome.outcome === 'selected' && result.outcome.optionId === 'allow'
              if (schedule && allowed && captured)
                scheduleInvocations.set(context.invocationId, captured)
              return allowed
            }
          }
        }
      })
      for (const tool of discovered) {
        const canonical = modelFacingAppMcpToolName('open-science-agent', server.name, tool.name)
        const name =
          canonical.length <= 64
            ? canonical
            : `${canonical.slice(0, 47)}_${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
        if (toolNames.has(name)) throw new Error('Ambiguous MCP tool identity')
        toolNames.set(name, canonical)
        tools.push({ ...tool, name })
        if (receipts)
          recoveries.set(name, async (pending, session) => {
            if (pending.definition?.version !== tool.version) return
            const receipt = await client.request(
              {
                method: HARNESS_RECEIPT_METHOD,
                params: {
                  invocationId: pending.invocationId,
                  name: tool.name,
                  arguments: pending.call.arguments
                }
              },
              receiptResponseSchema,
              { signal: input.signal }
            )
            if (receipt.status === 'completed' && receipt.result) {
              tool.validate(pending.call.arguments)
              const validateOutput = outputValidators.get(tool.name)
              if (validateOutput && !receipt.result.isError) {
                if (receipt.result.structuredContent === undefined)
                  throw new Error('Missing MCP structured output')
                validateOutput(receipt.result.structuredContent as Json)
              }
              await session.reconcile(pending.invocationId, mcpToolResult(receipt.result))
            }
          })
      }
    }
    return {
      setScheduleTurn(ref) {
        scheduleTurn = ref
        scheduleInvocations.clear()
      },
      tools,
      toolNames,
      close,
      async reconcile(session) {
        for (const pending of (await session.inspect()).pending) {
          if (pending.status === 'unknown')
            await recoveries.get(pending.call.name)?.(pending, session)
        }
      }
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Built-in Agent MCP startup failed')
    }
    throw error
  }
}
