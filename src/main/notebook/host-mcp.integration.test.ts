import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ConnectorService } from '../connectors/service'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookLocalRpcServer } from './local-rpc-server'

// host.mcp now lives ONLY in the control-plane repl kernel (a Node process). Node is always available
// under vitest, so the sole gate is RUN_KERNEL — no provisioned python/r env is needed.
// Run with: RUN_KERNEL=1 npx vitest run src/main/notebook/host-mcp.integration.test.ts
const gate = process.env.RUN_KERNEL ? describe : describe.skip

// The real repl loop script, so host.mcp() runs against the actual bridge the app ships. The executor
// spawns it under process.execPath with ELECTRON_RUN_AS_NODE=1 exactly as production does.
const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

const makeExecutor = (): NotebookKernelExecutor =>
  new NotebookKernelExecutor({ replLoopPath: REPL_LOOP })

// Base repl-cell request; the notebook roots are unused by these host.mcp cases. kind 'repl' routes to
// the control-plane kernel, the only kind buildEnv forwards the connector RPC endpoint/token to.
const baseRequest = (
  overrides: Partial<{
    code: string
    mcpRpcEndpoint: string
    mcpRpcSocketPath: string
    mcpRpcToken: string
    sessionId: string
    projectId: string
  }>
): {
  code: string
  cwd: string
  kind: 'repl'
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  mcpRpcEndpoint?: string
  mcpRpcSocketPath?: string
  mcpRpcToken?: string
  sessionId?: string
  projectId?: string
} => ({
  code: '',
  cwd: process.cwd(),
  kind: 'repl',
  notebookSessionRoot: '',
  dataRoot: '',
  runtimeRoot: '',
  ...overrides
})

gate('repl kernel host.mcp', () => {
  it('keeps the persistent control capability across ACP session cleanup', async () => {
    const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService: {
        call: async (server, method, args, context) => ({ server, method, args, context })
      }
    })
    const connection = await rpcServer.issueControlConnection(
      'session-42',
      'project-1',
      'root-frame-session-42'
    )
    const exec = makeExecutor()

    try {
      const request = baseRequest({
        code: `
            const result = await host.mcp('pubmed', 'search_articles', { query: 'tumor immunology' })
            console.log(JSON.stringify(result))
          `,
        mcpRpcEndpoint: connection.endpoint,
        mcpRpcSocketPath: connection.socketPath,
        mcpRpcToken: connection.token,
        sessionId: 'session-42',
        projectId: 'project-1'
      })
      const first = await exec.execute(request)

      rpcServer.releaseSessionCapabilities('session-42')

      const second = await exec.execute(request)

      for (const result of [first, second]) {
        expect(result.status).toBe('completed')
        expect(JSON.parse(result.stdout.trim())).toEqual({
          server: 'pubmed',
          method: 'search_articles',
          args: { query: 'tumor immunology' },
          context: { sessionId: 'session-42', projectId: 'project-1', origin: 'agent' }
        })
      }
    } finally {
      await exec.shutdown()
      connection.release()
      await rpcServer.close()
    }
  })

  it('host.mcp posts to the RPC endpoint and returns the parsed result', async () => {
    // Minimal stub RPC endpoint returning a fixed dict for any mcpCall.
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: { ok: true } }))
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "const r = await host.mcp('chemistry','pubchem_get_properties',{ cids: [1] }); console.log(r.ok)",
        mcpRpcEndpoint: `http://127.0.0.1:${addr.port}`,
        mcpRpcToken: 'tok'
      })
    )
    await exec.shutdown()
    server.close()
    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('true')
  })

  it('host.mcp forwards a positional args object to the RPC server', async () => {
    // Stub RPC endpoint that echoes back the args it received so the test can assert forwarding.
    const { createServer } = await import('node:http')
    let received: {
      params?: { args?: unknown; sessionId?: string; projectId?: string }
    } = {}
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received = JSON.parse(body)
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: { echoedArgs: received.params?.args } }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "const r = await host.mcp('chemistry','pubchem_get_properties',{ cids: [1, 2] }); console.log(JSON.stringify(r.echoedArgs.cids))",
        mcpRpcEndpoint: `http://127.0.0.1:${addr.port}`,
        mcpRpcToken: 'tok',
        sessionId: 'session-42',
        projectId: 'project-1'
      })
    )
    await exec.shutdown()
    server.close()
    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('[1,2]')
    expect(received.params?.args).toEqual({ cids: [1, 2] })
    expect(received.params).toMatchObject({ sessionId: 'session-42', projectId: 'project-1' })
  })

  it('tells the agent how to recover when host.mcp names an unavailable connector', async () => {
    const connectorService = new ConnectorService({
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [], disabledConnectorIds: [] }),
      resolveApiKey: () => undefined
    })
    const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService
    })
    const connection = await rpcServer.issueControlConnection(
      'session-42',
      'project-1',
      'root-frame-session-42'
    )
    const exec = makeExecutor()

    const result = await exec.execute(
      baseRequest({
        code: "await host.mcp('cancer_models','cbioportal_list_studies',{})",
        mcpRpcEndpoint: connection.endpoint,
        mcpRpcSocketPath: connection.socketPath,
        mcpRpcToken: connection.token,
        sessionId: 'session-42',
        projectId: 'project-1'
      })
    )

    await exec.shutdown()
    connection.release()
    await rpcServer.close()
    expect(result.status).toBe('failed')
    expect(result.traceback).toContain('Connector "cancer_models" is unavailable.')
    expect(result.traceback).toContain('Do not retry with guessed Connector names.')
    expect(result.traceback).toContain(
      'Use only Connector names and methods documented by a loaded'
    )
    expect(result.traceback).toContain('mcp-* Skill')
    expect(result.traceback).toContain('Settings > Connectors')
  })

  it('tells the agent to wait for sign-in when a Connector requires authentication', async () => {
    const connectorService = new ConnectorService({
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        customMcpServers: [
          {
            id: 'oauth-server-id',
            name: 'oauth-server',
            displayName: 'OAuth server',
            transport: 'streamable_http',
            url: 'https://mcp.example.test',
            oauth: {},
            enabled: true
          }
        ]
      }),
      resolveApiKey: () => undefined
    })
    const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService
    })
    const connection = await rpcServer.issueControlConnection(
      'session-42',
      'project-1',
      'root-frame-session-42'
    )
    const exec = makeExecutor()

    try {
      const result = await exec.execute(
        baseRequest({
          code: "await host.mcp('oauth-server','lookup',{})",
          mcpRpcEndpoint: connection.endpoint,
          mcpRpcSocketPath: connection.socketPath,
          mcpRpcToken: connection.token,
          sessionId: 'session-42',
          projectId: 'project-1'
        })
      )

      expect(result.status).toBe('failed')
      expect(result.traceback).toContain('connector_unauthenticated')
      expect(result.traceback).toContain('Do not retry until the user signs in')
      expect(result.traceback).toContain('Settings > Connectors')
      expect(result.traceback).toContain('retry the same call')
    } finally {
      await exec.shutdown()
      connection.release()
      await rpcServer.close()
    }
  })
})
