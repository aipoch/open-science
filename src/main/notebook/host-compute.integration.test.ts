import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

const notebookRoots: string[] = []
afterEach(() => {
  for (const root of notebookRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const makeNotebookRoots = (): {
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
} => {
  const root = mkdtempSync(join(tmpdir(), 'os-host-compute-'))
  notebookRoots.push(root)
  return {
    cwd: process.cwd(),
    notebookSessionRoot: join(root, 'nb'),
    dataRoot: join(root, 'nb', 'data'),
    runtimeRoot: join(root, 'runtime')
  }
}

// Minimal stub computeCall RPC endpoint that captures params and returns representative unchanged
// snake_case result projections.
const startStub = async (
  options: {
    dropFirstSubmitResponse?: boolean
    dropFirstSubmitBody?: boolean
    rejectSubmit?: boolean
  } = {}
): Promise<{
  endpoint: string
  close: () => void
  received: () => Array<{ params?: Record<string, unknown> }>
}> => {
  const { createServer } = await import('node:http')
  const requests: Array<{ params?: Record<string, unknown> }> = []
  let droppedFirstSubmitResponse = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const request = body ? JSON.parse(body) : {}
      requests.push(request)
      const op = request.params?.op
      if (op === 'submit_job' && options.dropFirstSubmitResponse && !droppedFirstSubmitResponse) {
        droppedFirstSubmitResponse = true
        res.destroy()
        return
      }
      if (op === 'submit_job' && options.dropFirstSubmitBody && !droppedFirstSubmitResponse) {
        droppedFirstSubmitResponse = true
        const responseBody = JSON.stringify({
          result: { job_id: 'job-1', provider_id: 'ssh:x', status: 'submitted' }
        })
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(responseBody)
        })
        res.flushHeaders()
        res.write(responseBody.slice(0, -1))
        setImmediate(() => res.destroy())
        return
      }
      if (op === 'submit_job' && options.rejectSubmit) {
        res
          .writeHead(409, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'submission rejected' }))
        return
      }
      const result =
        op === 'submit_job'
          ? { job_id: 'job-1', provider_id: 'ssh:x', status: 'submitted' }
          : op === 'list_compute'
            ? ['ssh:x']
            : op === 'details'
              ? { doc: 'details', is_skeleton: false }
              : { exit_code: 0, stdout: 'ok', stderr: '', truncated: false }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  return {
    endpoint: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
    received: () => requests
  }
}

// Base repl-cell request; kind 'repl' routes to the control-plane kernel, the only kind buildEnv
// forwards the connector RPC endpoint/token AND the session/project identity to. Spawn still
// prepares the Notebook workload cache from runtimeRoot, so these cases use a disposable root.
const baseRequest = (
  overrides: Partial<{
    code: string
    mcpRpcEndpoint: string
    mcpRpcToken: string
    sessionId: string
    projectId: string
  }>
): Parameters<NotebookKernelExecutor['execute']>[0] => ({
  code: '',
  kind: 'repl',
  ...makeNotebookRoots(),
  ...overrides
})

gate('repl kernel host.compute', () => {
  it('callCommand posts unchanged call_command wire params and returns the ExecResult', async () => {
    const stub = await startStub()
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "const r = await host.compute.create('ssh:x').callCommand('id', 'probe', { loginShell: false, timeoutSeconds: 30 }); console.log(JSON.stringify(r))",
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok'
      })
    )
    await exec.shutdown()
    stub.close()
    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('ok')
    expect(result.stdout).toContain('"exit_code":0')
    expect(stub.received()[0]?.params).toMatchObject({
      op: 'call_command',
      provider_id: 'ssh:x',
      login_shell: false,
      timeout_seconds: 30
    })
  })

  it('forwards the request session/project identity into the call_command payload (buildEnv)', async () => {
    const stub = await startStub()
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "await host.compute.create('ssh:x').callCommand('id','probe'); console.log('done')",
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok',
        sessionId: 'session-7',
        projectId: 'proj-x'
      })
    )
    await exec.shutdown()
    stub.close()
    expect(result.status).toBe('completed')
    expect(stub.received()[0]?.params?.session_id).toBe('session-7')
    expect(stub.received()[0]?.params?.project_id).toBe('proj-x')
  })

  it('maps listCompute, details, submitJob, attachJob, and setConcurrencyLimit to unchanged wire params', async () => {
    const stub = await startStub()
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code:
          "const c = host.compute.create('ssh:x'); " +
          'await host.compute.listCompute(); ' +
          "await host.compute.details('ssh:x', { mode: 'replace', text: 'new', oldText: 'old' }); " +
          "const job = await c.submitJob('analyze', 'run', { timeoutSeconds: 60, " +
          "inputs: [{ src: 'in.dat', dstFilename: 'input.dat' }, { remotePath: '/remote/ref.dat', dstFilename: 'ref.dat' }], " +
          "outputs: ['*.csv'], harvest: { exclude: ['tmp/**'], maxFileMb: 10, maxTotalMb: 20 } }); " +
          'await c.attachJob(job.job_id).status(); await c.attachJob(job.job_id).result(); ' +
          'await c.setConcurrencyLimit(2); console.log(JSON.stringify(job))',
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok',
        sessionId: 'session-7',
        projectId: 'proj-x'
      })
    )
    await exec.shutdown()
    stub.close()

    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('"job_id":"job-1"')
    expect(stub.received().map((request) => request.params)).toEqual([
      { op: 'list_compute', session_id: 'session-7' },
      {
        op: 'details',
        provider_id: 'ssh:x',
        mode: 'replace',
        text: 'new',
        old_text: 'old'
      },
      {
        op: 'submit_job',
        invocation_id: expect.any(String),
        provider_id: 'ssh:x',
        intent: 'analyze',
        command: 'run',
        inputs: [
          { src: 'in.dat', dst_filename: 'input.dat' },
          { remote_path: '/remote/ref.dat', dst_filename: 'ref.dat' }
        ],
        outputs: ['*.csv'],
        timeout_seconds: 60,
        harvest: { exclude: ['tmp/**'], max_file_mb: 10, max_total_mb: 20 },
        session_id: 'session-7',
        project_id: 'proj-x',
        workspace_cwd: process.cwd()
      },
      { op: 'job_status', provider_id: 'ssh:x', job_id: 'job-1' },
      { op: 'job_result', provider_id: 'ssh:x', job_id: 'job-1' },
      { op: 'set_concurrency_limit', session_id: 'session-7', limit: 2 }
    ])
  })

  it('retries a lost submitJob response with the same invocation id', async () => {
    const stub = await startStub({ dropFirstSubmitResponse: true })
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code:
          "const job = await host.compute.create('ssh:x').submitJob('analyze', 'run'); " +
          'console.log(JSON.stringify(job))',
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok',
        sessionId: 'session-7',
        projectId: 'proj-x'
      })
    )
    await exec.shutdown()
    stub.close()

    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('"job_id":"job-1"')
    const submissions = stub
      .received()
      .map((request) => request.params)
      .filter((params) => params?.op === 'submit_job')
    expect(submissions).toHaveLength(2)
    expect(submissions[0]?.invocation_id).toEqual(expect.any(String))
    expect(submissions[1]?.invocation_id).toBe(submissions[0]?.invocation_id)
  })

  it('retries a lost submitJob response body with the same invocation id', async () => {
    const stub = await startStub({ dropFirstSubmitBody: true })
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code:
          "const job = await host.compute.create('ssh:x').submitJob('analyze', 'run'); " +
          'console.log(JSON.stringify(job))',
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok',
        sessionId: 'session-7',
        projectId: 'proj-x'
      })
    )
    await exec.shutdown()
    stub.close()

    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('"job_id":"job-1"')
    const submissions = stub
      .received()
      .map((request) => request.params)
      .filter((params) => params?.op === 'submit_job')
    expect(submissions).toHaveLength(2)
    expect(submissions[0]?.invocation_id).toEqual(expect.any(String))
    expect(submissions[1]?.invocation_id).toBe(submissions[0]?.invocation_id)
  })

  it('does not retry submitJob HTTP errors', async () => {
    const stub = await startStub({ rejectSubmit: true })
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "await host.compute.create('ssh:x').submitJob('analyze', 'run')",
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok',
        sessionId: 'session-7',
        projectId: 'proj-x'
      })
    )
    await exec.shutdown()
    stub.close()

    expect(result.status).toBe('failed')
    expect(stub.received().filter((request) => request.params?.op === 'submit_job')).toHaveLength(1)
  })

  it('rejects every old compute input key before RPC', async () => {
    const stub = await startStub()
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code:
          "const c = host.compute.create('ssh:x'); const errors = []; " +
          'for (const call of [' +
          "() => c.callCommand('id', 'probe', { login_shell: true }), " +
          "() => c.callCommand('id', 'probe', { timeout_seconds: 1 }), " +
          "() => host.compute.details('ssh:x', { old_text: 'old' }), " +
          "() => c.submitJob('i', 'c', { timeout_seconds: 1 }), " +
          "() => c.submitJob('i', 'c', { inputs: [{ src: 'a', dst_filename: 'a' }] }), " +
          "() => c.submitJob('i', 'c', { inputs: [{ remote_path: '/a' }] }), " +
          "() => c.submitJob('i', 'c', { harvest: { max_file_mb: 1 } }), " +
          "() => c.submitJob('i', 'c', { harvest: { max_total_mb: 1 } })]) " +
          '{ try { await call() } catch (error) { errors.push(error.message) } } ' +
          'console.log(JSON.stringify(errors))',
        mcpRpcEndpoint: stub.endpoint,
        mcpRpcToken: 'tok'
      })
    )
    await exec.shutdown()
    stub.close()

    expect(result.status).toBe('completed')
    expect(JSON.parse(result.stdout.trim())).toEqual([
      'host.compute.callCommand options unknown option: login_shell',
      'host.compute.callCommand options unknown option: timeout_seconds',
      'host.compute.details options unknown option: old_text',
      'host.compute.submitJob options unknown option: timeout_seconds',
      'host.compute.submitJob input unknown option: dst_filename',
      'host.compute.submitJob input unknown option: remote_path',
      'host.compute.submitJob harvest unknown option: max_file_mb',
      'host.compute.submitJob harvest unknown option: max_total_mb'
    ])
    expect(stub.received()).toEqual([])
  })
})
