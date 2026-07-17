import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { NotebookKernelExecutor } from './kernel-executor'

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
    mcpRpcToken: string
  }>
): {
  code: string
  cwd: string
  kind: 'repl'
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  mcpRpcEndpoint?: string
  mcpRpcToken?: string
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
    let received: { params?: { args?: unknown } } = {}
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
        mcpRpcToken: 'tok'
      })
    )
    await exec.shutdown()
    server.close()
    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('[1,2]')
    expect(received.params?.args).toEqual({ cids: [1, 2] })
  })

  it('surfaces the RPC server error message when host.mcp gets a non-2xx response', async () => {
    // Stub RPC endpoint mirroring NotebookLocalRpcServer's failure shape: HTTP 500 + {"error": ...}.
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () =>
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'connector not enabled: chemistry' }))
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "await host.mcp('chemistry','pubchem_get_properties',{ cids: [1] })",
        mcpRpcEndpoint: `http://127.0.0.1:${addr.port}`,
        mcpRpcToken: 'tok'
      })
    )
    await exec.shutdown()
    server.close()
    expect(result.status).toBe('failed')
    expect(result.traceback).toContain('connector not enabled: chemistry')
  })
})
