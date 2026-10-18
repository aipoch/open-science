import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureTestRuntimeNetwork } from '../../../../test/runtime-host'
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

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

it.each(['timeout', 'cancelled'] as const)(
  'waits for a stalled stdio server to exit after diagnostic %s',
  async (reason) => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-diagnostic-cleanup-'))
    const pidFile = join(directory, 'server.pid')
    const { workflow } = makeWorkflow(process.execPath, [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       setInterval(() => {}, 1000)`
    ])
    const controller = new AbortController()
    const pending = workflow.testCustomServer({ id: 'fixture' }, controller.signal)
    let pid: number | undefined
    try {
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(pidFile, 'utf8'))
          expect(pid).toBeGreaterThan(0)
        },
        { timeout: 5_000 }
      )
      if (reason === 'cancelled') controller.abort()
      await expect(pending).resolves.toMatchObject({
        success: false,
        stage: 'handshake',
        code: reason
      })
      expect(isProcessAlive(pid!)).toBe(false)
    } finally {
      controller.abort()
      await pending
      // Assert before fixture cleanup: killing a leaked fixture must not turn the test green.
      if (pid && isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000
)

it('distinguishes a missing executable without exposing its path', async () => {
  const missing =
    process.platform === 'win32'
      ? 'C:\\missing\\m07-secret-command'
      : '/private/missing/m07-secret-command'
  const { workflow } = makeWorkflow(missing, [])
  const result = await workflow.testCustomServer({ id: 'fixture' })
  expect(result.success).toBe(false)
  expect(['startup', 'handshake']).toContain(result.stage)
  if (process.platform !== 'win32') {
    expect(result).toMatchObject({ stage: 'startup', code: 'startup_failed' })
  }
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

configureTestRuntimeNetwork()

it('retains the original OAuth write guard during a diagnostic refresh', async () => {
  // The installed Connector package uses the SDK's CommonJS client.
  const { Client } = createRequire(import.meta.url)(
    '@modelcontextprotocol/sdk/client/index.js'
  ) as typeof import('@modelcontextprotocol/sdk/client/index.js')
  const { customServerSecurityFingerprint } = await import('../custom-server-identity')
  const server = {
    id: 'guarded',
    name: 'guarded',
    displayName: 'Guarded',
    enabled: false,
    transport: 'streamable_http' as const,
    url: 'https://example.test/mcp',
    oauth: {},
    oauthClientSecretRef: 'enc:original',
    oauthClientSecret: 'fixture-secret'
  }
  const fingerprint = customServerSecurityFingerprint(server)
  const saveCustomServerOAuthState = vi.fn(async () => undefined)
  const tokens = { access_token: 'refreshed', token_type: 'Bearer' }
  const workflow = new ConnectorSettingsWorkflows(
    {
      getConnectors: async () => ({ customMcpServers: [server] }),
      saveCustomServerOAuthState
    } as unknown as ConnectorSettingsWorkflowStore,
    {} as ConnectorSettingsWorkflowEffects
  )
  vi.spyOn(Client.prototype, 'connect').mockImplementation(async (transport) => {
    // A concurrent settings change must not replace the guard captured by this diagnostic.
    server.url = 'https://changed.example/mcp'
    server.oauthClientSecretRef = 'enc:changed'
    const provider = (
      transport as unknown as {
        _authProvider: import('@aipoch/connector-mcp-client').PersistentOAuthClientProvider
      }
    )._authProvider
    await provider.saveTokens(tokens)
  })
  vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] })
  try {
    expect(await workflow.testCustomServer({ id: server.id })).toMatchObject({ success: true })
    expect(saveCustomServerOAuthState).toHaveBeenCalledWith(
      server.id,
      { tokens },
      fingerprint,
      'enc:original'
    )
  } finally {
    vi.restoreAllMocks()
  }
})
