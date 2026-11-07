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
import { modelFacingAppMcpToolName } from '../agent-framework/app-mcp-names'

/** Connection ownership and permission UX are host policy, not package loop policy. */
export async function connectHarnessMcp(input: {
  servers: readonly McpServer[]
  sessionId: string
  context: AgentContext
  signal: AbortSignal
  beforePermission(): Promise<void>
}): Promise<{
  tools: AgentTool[]
  toolNames: ReadonlyMap<string, string>
  close(): Promise<void>
  reconcile(session: AgentSession): Promise<void>
}> {
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
      const url = new URL(server.url)
      if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
      )
        throw new Error('Invalid MCP endpoint')
      const client = new Client({ name: 'open-science-agent', version: '0.1.0' })
      clients.push(client)
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
            redirect: 'error'
          }
        }),
        { signal: input.signal }
      )
      const receipts =
        client.getServerCapabilities()?.experimental?.[HARNESS_RECEIPTS] !== undefined
      const validator = new AjvJsonSchemaValidator()
      const outputValidators = new Map<string, (value: Json) => void>()
      const discovered = await loadMcpTools({
        signal: input.signal,
        client: {
          listTools: (cursor, signal) => client.listTools(cursor ? { cursor } : {}, { signal }),
          callTool: (name, args, context) =>
            client.callTool(
              {
                name,
                arguments: args,
                ...(receipts ? { _meta: { [HARNESS_INVOCATION]: context.invocationId } } : {})
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
        },
        bind(definition) {
          const validate = validator.getValidator<Json>(
            definition.inputSchema as Record<string, unknown>
          )
          const output =
            definition.outputSchema === undefined
              ? undefined
              : validator.getValidator<Json>(definition.outputSchema as Record<string, unknown>)
          if (output)
            outputValidators.set(definition.name, (value) => {
              if (!output(value).valid) throw new Error('Invalid MCP tool output')
            })
          return {
            validate(value) {
              const result = validate(value)
              if (!result.valid) {
                // Expose schema-owned field names only, never raw validator text or argument values.
                const schema = definition.inputSchema as Record<string, Json>
                const missing = Array.isArray(schema.required)
                  ? schema.required.filter(
                      (key): key is string =>
                        typeof key === 'string' &&
                        !!value &&
                        typeof value === 'object' &&
                        !Array.isArray(value) &&
                        !Object.hasOwn(value, key)
                    )
                  : []
                throw new ToolValidationError(
                  missing.length
                    ? missing.map((key) => ({ path: `$.${key}`, expected: 'required field' }))
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
                    kind: 'other',
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
              return result.outcome.outcome === 'selected' && result.outcome.optionId === 'allow'
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
