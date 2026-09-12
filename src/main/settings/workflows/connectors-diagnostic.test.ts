import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { describe, expect, it, vi } from 'vitest'
import {
  ConnectorSettingsWorkflows,
  type ConnectorSettingsWorkflowStore,
  type ConnectorSettingsWorkflowEffects
} from './connectors'

const serverScript = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'example', inputSchema: { type: 'object' } }] };
  else process.exit(42);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`

const makeWorkflow = (
  command: string,
  args: string[]
): {
  workflow: ConnectorSettingsWorkflows
  getConnectors: () => Promise<{ customMcpServers: Array<{ enabled: boolean }> }>
} => {
  const getConnectors = vi.fn(async () => ({
    customMcpServers: [
      {
        id: 'fixture',
        name: 'fixture',
        displayName: 'Fixture',
        transport: 'stdio',
        command,
        args,
        enabled: false
      }
    ]
  }))
  const workflow = new ConnectorSettingsWorkflows(
    {
      getConnectors,
      saveCustomServerOAuthState: vi.fn()
    } as unknown as ConnectorSettingsWorkflowStore,
    {} as ConnectorSettingsWorkflowEffects
  )
  return { workflow, getConnectors }
}

describe('Connector diagnostics', () => {
  it('discovers real stdio tools without enabling the disabled Connector', async () => {
    const { workflow, getConnectors } = makeWorkflow(process.execPath, ['-e', serverScript])
    await expect(workflow.testCustomServer({ id: 'fixture' })).resolves.toMatchObject({
      success: true,
      toolCount: 1
    })
    expect((await getConnectors()).customMcpServers[0].enabled).toBe(false)
  })

  it('reports an exited server as a diagnostic failure', async () => {
    const { workflow } = makeWorkflow(process.execPath, ['-e', 'process.exit(1)'])
    await expect(workflow.testCustomServer({ id: 'fixture' })).resolves.toMatchObject({
      success: false
    })
  })

  it('does not pretend a missing or bundled Connector was tested', async () => {
    const { workflow } = makeWorkflow(process.execPath, [])
    await expect(workflow.testCustomServer({ id: 'unknown' })).resolves.toMatchObject({
      success: false
    })
  })
})

it('honors cancellation before starting a probe', async () => {
  const { workflow } = makeWorkflow(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const controller = new AbortController()
  const pending = workflow.testCustomServer({ id: 'fixture' }, controller.signal)
  controller.abort()
  await expect(pending).resolves.toMatchObject({ success: false })
})

it.each(['streamable_http', 'sse'] as const)(
  'discovers tools through real %s transport',
  async (transportKind) => {
    const mcp = new McpServer({ name: 'diagnostic-fixture', version: '1' })
    const call = vi.fn(async () => ({ content: [] }))
    mcp.registerTool('example', { inputSchema: {} }, call)
    let transport: StreamableHTTPServerTransport | SSEServerTransport
    const server = createServer(async (request, response) => {
      try {
        if (transportKind === 'streamable_http') {
          await (transport as StreamableHTTPServerTransport).handleRequest(request, response)
        } else if (request.method === 'GET') {
          transport = new SSEServerTransport('/messages', response)
          await mcp.connect(transport)
        } else {
          await (transport as SSEServerTransport).handlePostMessage(request, response)
        }
      } catch {
        response.writeHead(500).end()
      }
    })
    if (transportKind === 'streamable_http') {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
      await mcp.connect(transport)
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const workflow = new ConnectorSettingsWorkflows(
      {
        getConnectors: async () => ({
          customMcpServers: [
            {
              id: 'remote',
              name: 'remote',
              displayName: 'Remote',
              enabled: false,
              transport: transportKind,
              url: `http://127.0.0.1:${address.port}/mcp`
            }
          ]
        }),
        saveCustomServerOAuthState: vi.fn()
      } as unknown as ConnectorSettingsWorkflowStore,
      {} as ConnectorSettingsWorkflowEffects
    )
    try {
      expect(await workflow.testCustomServer({ id: 'remote' })).toMatchObject({
        success: true,
        toolCount: 1
      })
      expect(call).not.toHaveBeenCalled()
    } finally {
      await mcp.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  15_000
)

it('bounds a stalled stdio server by the diagnostic timeout', async () => {
  const { workflow } = makeWorkflow(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  await expect(workflow.testCustomServer({ id: 'fixture' })).resolves.toEqual({
    success: false,
    message: 'MCP connection timed out.',
    stage: 'handshake',
    code: 'timeout'
  })
}, 15_000)

it('distinguishes a missing executable without exposing its path', async () => {
  const missing =
    process.platform === 'win32'
      ? 'C:\\missing\\m07-secret-command'
      : '/private/missing/m07-secret-command'
  const { workflow } = makeWorkflow(missing, [])
  const result = await workflow.testCustomServer({ id: 'fixture' })
  expect(result).toMatchObject({ success: false, stage: 'startup', code: 'startup_failed' })
  expect(JSON.stringify(result)).not.toContain('m07-secret-command')
})

it('reports malformed initialization separately from tool discovery', async () => {
  const { workflow } = makeWorkflow(process.execPath, [
    '-e',
    serverScript.replace("protocolVersion: '2024-11-05'", "protocolVersion: 'invalid'")
  ])
  expect(await workflow.testCustomServer({ id: 'fixture' })).toMatchObject({
    success: false,
    stage: 'handshake',
    code: 'handshake_failed'
  })
})

it('reports malformed tool catalogs after a successful handshake', async () => {
  const { workflow } = makeWorkflow(process.execPath, [
    '-e',
    serverScript.replace(
      "tools: [{ name: 'example', inputSchema: { type: 'object' } }]",
      "tools: 'not-an-array'"
    )
  ])
  expect(await workflow.testCustomServer({ id: 'fixture' })).toMatchObject({
    success: false,
    stage: 'discovery',
    code: 'discovery_failed'
  })
})

it('accepts an empty tool catalog without claiming tool execution', async () => {
  const { workflow } = makeWorkflow(process.execPath, [
    '-e',
    serverScript.replace(
      "tools: [{ name: 'example', inputSchema: { type: 'object' } }]",
      'tools: []'
    )
  ])
  expect(await workflow.testCustomServer({ id: 'fixture' })).toMatchObject({
    success: true,
    toolCount: 0,
    stage: 'discovery',
    code: 'ok',
    message: 'MCP connection and tool discovery succeeded. Business tools were not executed.'
  })
})
