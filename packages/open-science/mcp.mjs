/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  agentErrorDetails,
  agentGuide,
  agentGuideUri,
  agentInputSchema,
  invokeAgentCapability,
  listAgentCapabilities
} from './agent-adapter.mjs'
import { connectToOpenScience, OpenScienceApiError } from './index.mjs'

const outputSchema = {
  type: 'object',
  oneOf: [
    { required: ['result'], properties: { result: {} }, additionalProperties: false },
    { required: ['error'], properties: { error: { type: 'object' } }, additionalProperties: false }
  ]
}

const toolResult = (structuredContent, isError = false) => ({
  ...(isError ? { isError } : {}),
  content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  structuredContent
})

export const createResearchMcpServer = ({
  configRoot,
  version,
  connect = connectToOpenScience,
  probe = connect
}) => {
  const server = new McpServer({ name: 'open-science', version })
  const lifetime = new AbortController()
  const tools = listAgentCapabilities('mcp').map((entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: agentInputSchema(entry),
    outputSchema,
    annotations: entry.annotations
  }))
  // Validate in the adapter so invalid arguments get the same structured errors as CLI.
  server.server.registerCapabilities({ tools: {} })
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const signal = AbortSignal.any([lifetime.signal, extra.signal])
    try {
      const result = await invokeAgentCapability(params.name, params.arguments ?? {}, {
        exposure: 'mcp',
        configRoot,
        signal,
        connect,
        probe
      })
      return toolResult({ result: result ?? null })
    } catch (error) {
      return toolResult({ error: agentErrorDetails(error) }, true)
    }
  })
  server.registerResource(
    'agent_guide',
    agentGuideUri,
    { description: 'Local Open-Science guide for external agents.', mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: agentGuide }]
    })
  )
  const onclose = server.server.onclose
  server.server.onclose = () => {
    lifetime.abort()
    onclose?.()
  }
  return server
}

export const runResearchMcpServer = async ({ configRoot, version, startService }) => {
  // The handshake and tool catalog stay responsive while the standalone backend starts.
  const lifetime = new AbortController()
  let startup
  const serviceRoot = () => (startup ??= startService(lifetime.signal))
  const server = createResearchMcpServer({
    configRoot,
    version,
    probe: connectToOpenScience,
    connect: async ({ signal }) => {
      const attempt = serviceRoot()
      let runningRoot
      try {
        runningRoot = await attempt
      } catch {
        // A later call may retry startup. No business operation has been submitted yet.
        if (startup === attempt) startup = undefined
        throw new OpenScienceApiError('Could not confirm startup.', { code: 'startup_unconfirmed' })
      }
      signal.throwIfAborted()
      return connectToOpenScience({ configRoot: runningRoot, signal })
    }
  })
  server.server.oninitialized = () => {
    // Tool calls that need a running service observe startup failure through the error envelope.
    void serviceRoot().catch(() => {})
  }
  const transport = new StdioServerTransport()
  let closing
  const close = () => {
    lifetime.abort()
    closing ??= server.close().finally(() => {
      process.stdin.off('end', close)
      process.off('SIGINT', close)
      process.off('SIGTERM', close)
    })
    return closing
  }
  process.stdin.once('end', close)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  try {
    await server.connect(transport)
    if (process.stdin.readableEnded) await close()
  } catch (error) {
    await close()
    throw error
  }
}
