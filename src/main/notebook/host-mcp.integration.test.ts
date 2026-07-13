import { describe, it, expect } from 'vitest'
import { NotebookPythonExecutor } from './python-executor'

// Requires python3 on PATH. Run with: RUN_KERNEL=1 npx vitest run <file>
describe.skipIf(!process.env.RUN_KERNEL)('kernel host.mcp', () => {
  it('host.mcp posts to the RPC endpoint and returns the parsed dict', async () => {
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
    const exec = new NotebookPythonExecutor()
    const result = await exec.execute({
      code: 'r = host.mcp("chemistry","pubchem_get_properties", cids=[1]); print(r["ok"])',
      cwd: process.cwd(),
      notebookSessionRoot: '',
      dataRoot: '',
      runtimeRoot: '',
      // test-only fields consumed by the executor env wiring:
      mcpRpcEndpoint: `http://127.0.0.1:${addr.port}`,
      mcpRpcToken: 'tok'
    } as never)
    await exec.shutdown()
    server.close()
    expect(result.stdout).toContain('True')
  })

  it('host.mcp accepts a positional args dict (MCP-idiomatic style)', async () => {
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
    const exec = new NotebookPythonExecutor()
    const result = await exec.execute({
      code: 'r = host.mcp("chemistry","pubchem_get_properties", {"cids": [1, 2]}); print(r["echoedArgs"]["cids"])',
      cwd: process.cwd(),
      notebookSessionRoot: '',
      dataRoot: '',
      runtimeRoot: '',
      mcpRpcEndpoint: `http://127.0.0.1:${addr.port}`,
      mcpRpcToken: 'tok'
    } as never)
    await exec.shutdown()
    server.close()
    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('[1, 2]')
    expect(received.params?.args).toEqual({ cids: [1, 2] })
  })

  it('host.mcp rejects mixing a positional args dict with keyword arguments', async () => {
    // The guard fires in Python before any HTTP call, so no live RPC endpoint is needed.
    const exec = new NotebookPythonExecutor()
    const result = await exec.execute({
      code: 'host.mcp("chemistry","pubchem_get_properties", {"cids": [1]}, retmax=5)',
      cwd: process.cwd(),
      notebookSessionRoot: '',
      dataRoot: '',
      runtimeRoot: '',
      mcpRpcEndpoint: 'http://127.0.0.1:9',
      mcpRpcToken: 'tok'
    } as never)
    await exec.shutdown()
    expect(result.status).toBe('failed')
    expect(result.traceback).toContain('not both')
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
    const exec = new NotebookPythonExecutor()
    const result = await exec.execute({
      code: 'host.mcp("chemistry","pubchem_get_properties", cids=[1])',
      cwd: process.cwd(),
      notebookSessionRoot: '',
      dataRoot: '',
      runtimeRoot: '',
      mcpRpcEndpoint: `http://127.0.0.1:${addr.port}`,
      mcpRpcToken: 'tok'
    } as never)
    await exec.shutdown()
    server.close()
    expect(result.status).toBe('failed')
    expect(result.traceback).toContain('connector not enabled: chemistry')
  })
})
