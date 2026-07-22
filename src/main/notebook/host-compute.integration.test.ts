import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { NotebookKernelExecutor } from './kernel-executor'

// host.compute lives ONLY in the control-plane repl kernel (a Node process), reached via the same
// loopback computeCall RPC as host.mcp. Node is always available under vitest, so the sole gate is
// RUN_KERNEL — no provisioned python/r env is needed.
// Run with: RUN_KERNEL=1 npx vitest run src/main/notebook/host-compute.integration.test.ts
const gate = process.env.RUN_KERNEL ? describe : describe.skip

// The real repl loop script the app ships, spawned under process.execPath with ELECTRON_RUN_AS_NODE=1
// exactly as production does.
const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

const makeExecutor = (): NotebookKernelExecutor =>
  new NotebookKernelExecutor({ replLoopPath: REPL_LOOP })

// Minimal stub computeCall RPC endpoint that captures the last params and returns a fixed ExecResult,
// mirroring the main-process ComputeService's call_command result shape.
const startStub = async (): Promise<{
  endpoint: string
  close: () => void
  received: () => { params?: Record<string, unknown> }
}> => {
  const { createServer } = await import('node:http')
  let last: { params?: Record<string, unknown> } = {}
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      last = body ? JSON.parse(body) : {}
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ result: { exit_code: 0, stdout: 'ok', stderr: '', truncated: false } })
        )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  return {
    endpoint: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
    received: () => last
  }
}

// Base repl-cell request; kind 'repl' routes to the control-plane kernel, the only kind buildEnv
// forwards the connector RPC endpoint/token AND the session/project identity to.
const baseRequest = (
  overrides: Partial<{
    code: string
    mcpRpcEndpoint: string
    mcpRpcToken: string
    sessionId: string
    projectName: string
  }>
): Parameters<NotebookKernelExecutor['execute']>[0] => ({
  code: '',
  cwd: process.cwd(),
  kind: 'repl',
  notebookSessionRoot: '',
  dataRoot: '',
  runtimeRoot: '',
  ...overrides
})

gate('repl kernel host.compute', () => {
  it('call_command posts to the computeCall RPC endpoint and returns the ExecResult', async () => {
    const stub = await startStub()
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "const r = await host.compute.create('ssh:x').call_command('id','probe'); console.log(r.stdout)",
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok'
      })
    )
    await exec.shutdown()
    stub.close()
    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('ok')
    expect(stub.received().params?.op).toBe('call_command')
    expect(stub.received().params?.provider_id).toBe('ssh:x')
  })

  it('forwards the request session/project identity into the call_command payload (buildEnv)', async () => {
    const stub = await startStub()
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "await host.compute.create('ssh:x').call_command('id','probe'); console.log('done')",
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok',
        sessionId: 'session-7',
        projectName: 'proj-x'
      })
    )
    await exec.shutdown()
    stub.close()
    expect(result.status).toBe('completed')
    expect(stub.received().params?.session_id).toBe('session-7')
    expect(stub.received().params?.project_id).toBe('proj-x')
  })
})
