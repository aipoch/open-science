import { describe, it, expect, afterEach } from 'vitest'
import { NotebookLocalRpcServer } from './local-rpc-server'

const fakeConnector = {
  call: async (s: string, m: string, a: Record<string, unknown>) => ({ s, m, a })
}
let server: NotebookLocalRpcServer | undefined
const sessionConnection = (
  target: NotebookLocalRpcServer,
  sessionId = 's-42',
  projectId = 'project-1'
): ReturnType<NotebookLocalRpcServer['issueSessionConnection']> =>
  target.issueSessionConnection(sessionId, projectId, `root-frame-${sessionId}`)

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('mcpCall RPC', () => {
  it('keeps Settings management outside the Notebook local RPC surface', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp'
    })
    const { endpoint, token } = await sessionConnection(server)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'settingsCall', params: { workspaceCwd: process.cwd() } })
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Unknown notebook RPC method: settingsCall'
    })
  })

  it('rejects privileged calls made with the server-wide bootstrap token', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: fakeConnector as never
    })
    const { endpoint, token } = await server.ensureStarted()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'mcpCall',
        params: { server: 'chemistry', method: 'pubchem_get_properties', args: {} }
      })
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: 'A session-bound notebook RPC token is required.'
    })
  })

  it('issues a scoped control connection without invalidating the Agent session connection', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: fakeConnector as never
    })
    const agentConnection = await sessionConnection(server)
    const controlConnection = await server.issueControlConnection(
      's-42',
      'project-1',
      'root-frame-s-42'
    )
    const callMcp = (token: string): Promise<Response> =>
      fetch(controlConnection.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'mcpCall',
          params: { server: 'pubmed', method: 'search_articles', args: {} }
        })
      })

    await expect((await callMcp(controlConnection.token)).json()).resolves.toEqual({
      result: { s: 'pubmed', m: 'search_articles', a: {} }
    })
    await expect((await callMcp(agentConnection.token)).json()).resolves.toEqual({
      result: { s: 'pubmed', m: 'search_articles', a: {} }
    })

    const disallowed = await fetch(controlConnection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controlConnection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ method: 'state', params: { sessionId: 's-42' } })
    })
    expect(disallowed.status).toBe(403)

    controlConnection.release()
    const revoked = await callMcp(controlConnection.token)
    expect(revoked.status).toBe(401)
  })

  it('routes mcpCall to the connector service', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: fakeConnector as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(`${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'mcpCall',
        params: { server: 'chemistry', method: 'pubchem_get_properties', args: { cids: [1] } }
      })
    })
    expect(await res.json()).toEqual({
      result: { s: 'chemistry', m: 'pubchem_get_properties', a: { cids: [1] } }
    })
  })

  it('uses the session-bound owner and ignores forged RPC owner fields', async () => {
    let seenContext: { sessionId?: string; projectId?: string } | undefined
    const capturing = {
      call: async (
        _s: string,
        _m: string,
        _a: Record<string, unknown>,
        context?: { sessionId?: string; projectId?: string }
      ) => {
        seenContext = context
        return { ok: true }
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: capturing as never
    })
    const { endpoint, token } = await sessionConnection(server)
    await fetch(`${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'mcpCall',
        params: {
          server: 'molecule',
          method: 'preview_molecule',
          args: {},
          sessionId: 'forged-session',
          projectId: 'forged-project'
        }
      })
    })
    expect(seenContext).toEqual({
      sessionId: 's-42',
      projectId: 'project-1',
      origin: 'agent'
    })
  })

  it('uses the registered Specialist scope rather than RPC-supplied identity data', async () => {
    let seenContext:
      | {
          sessionId?: string
          projectId?: string
          origin?: 'agent' | 'internal'
          specialistId?: string
        }
      | undefined
    const capturing = {
      call: async (
        _s: string,
        _m: string,
        _a: Record<string, unknown>,
        context?: {
          sessionId?: string
          projectId?: string
          origin?: 'agent' | 'internal'
          specialistId?: string
        }
      ) => {
        seenContext = context
        return { ok: true }
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: capturing
    })
    server.registerSessionSpecialist('real-session', 'specialist-1')
    server.registerSessionAlias('notebook-session', 'real-session')
    const { endpoint, token } = await sessionConnection(server, 'notebook-session', 'project-1')
    await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'mcpCall',
        params: {
          server: 'molecule',
          method: 'preview_molecule',
          args: {},
          sessionId: 'notebook-session',
          specialistId: 'forged-specialist'
        }
      })
    })
    expect(seenContext).toEqual({
      sessionId: 'real-session',
      projectId: 'project-1',
      origin: 'agent',
      specialistId: 'specialist-1'
    })
  })
})

describe('computeCall RPC', () => {
  it('routes computeCall op=call_command to the compute service', async () => {
    const fakeResult = { exit_code: 0, stdout: 'hello', stderr: '', truncated: false }
    const fakeCompute = {
      callCommand: async (
        providerId: string,
        cmd: string,
        intent: string,
        loginShell: boolean,
        timeoutSeconds?: number,
        context?: { sessionId: string; projectId: string }
      ) => ({
        ...fakeResult,
        _args: { providerId, cmd, intent, loginShell, timeoutSeconds, context }
      })
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: {
          op: 'call_command',
          provider_id: 'ssh:biowulf',
          cmd: 'echo hi',
          intent: 'test',
          login_shell: true,
          timeout_seconds: 30,
          session_id: 'forged-session',
          project_id: 'forged-project'
        }
      })
    })
    const body = (await res.json()) as {
      result: { exit_code: number; stdout: string; _args: Record<string, unknown> }
    }
    expect(res.status).toBe(200)
    expect(body.result.exit_code).toBe(0)
    expect(body.result.stdout).toBe('hello')
    expect(body.result._args.providerId).toBe('ssh:biowulf')
    expect(body.result._args.loginShell).toBe(true)
    expect(body.result._args.timeoutSeconds).toBe(30)
    expect(body.result._args.context).toEqual({
      sessionId: 's-42',
      projectId: 'project-1'
    })
  })

  it('returns 401 without Bearer token', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: {} as never
    })
    const { endpoint } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'computeCall', params: { op: 'call_command' } })
    })
    expect(res.status).toBe(401)
  })

  it('returns 500 when compute service is not configured', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp'
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'computeCall', params: { op: 'call_command' } })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/compute service is not configured/i)
  })

  it('returns 500 with structured error JSON when computeCallError is thrown', async () => {
    const callErr = new Error('approval denied') as Error & { computeCallError: unknown }
    callErr.computeCallError = {
      error_code: 'approval_denied',
      message: 'Approval denied.',
      retry_after_user_action: false
    }
    const fakeCompute = {
      callCommand: async () => {
        throw callErr
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'call_command', provider_id: 'ssh:x', cmd: 'ls', intent: 'test' }
      })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    const parsed = JSON.parse(body.error)
    expect(parsed.error_code).toBe('approval_denied')
  })

  it('returns 500 for unknown op', async () => {
    const fakeCompute = { callCommand: async () => ({}) }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'computeCall', params: { op: 'unknown_op' } })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/unknown computecall op/i)
  })

  it('routes computeCall op=download to compute service download (session-cache)', async () => {
    const fakeLocalFile = {
      path: '/tmp/cs-session-abc/results.csv',
      name: 'results.csv',
      size: 1024,
      mimeType: 'text/csv'
    }
    const fakeCompute = {
      callCommand: async () => ({}),
      download: async (
        providerId: string,
        remotePath: string,
        dest: { kind: string },
        context?: { sessionId: string; projectId: string }
      ) => ({
        ...fakeLocalFile,
        _args: { providerId, remotePath, destKind: dest.kind, context }
      })
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: {
          op: 'download',
          provider_id: 'ssh:biowulf',
          remote_path: '/remote/results.csv',
          session_id: 'forged-session',
          project_id: 'forged-project'
        }
      })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: typeof fakeLocalFile & { _args: Record<string, unknown> }
    }
    expect(body.result.name).toBe('results.csv')
    expect(body.result._args.providerId).toBe('ssh:biowulf')
    expect(body.result._args.remotePath).toBe('/remote/results.csv')
    expect(body.result._args.destKind).toBe('session-cache')
    expect(body.result._args.context).toEqual({
      sessionId: 's-42',
      projectId: 'project-1'
    })
  })

  it('returns 500 with download_denied error when download is denied', async () => {
    const err = new Error('Download denied') as Error & { code: string }
    err.code = 'download_denied'
    const fakeCompute = {
      callCommand: async () => ({}),
      download: async () => {
        throw err
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'download', provider_id: 'ssh:biowulf', remote_path: '/remote/secret.key' }
      })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/download.denied|denied/i)
  })

  it('routes computeCall op=list to the compute service', async () => {
    const fakeHosts = [
      { providerId: 'ssh:biowulf', displayName: 'biowulf', shape: 'direct_ssh', probeResult: null }
    ]
    const fakeCompute = {
      callCommand: async () => ({}),
      list: async () => fakeHosts,
      getDetails: async () => ({ doc: '', isSkeleton: false }),
      appendDetails: async () => {},
      replaceDetails: async () => {}
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'computeCall', params: { op: 'list' } })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: typeof fakeHosts }
    expect(body.result).toEqual(fakeHosts)
  })

  it('routes computeCall op=details mode=read to getDetails', async () => {
    const fakeCompute = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async (providerId: string) => ({
        doc: `doc for ${providerId}`,
        isSkeleton: false
      }),
      appendDetails: async () => {},
      replaceDetails: async () => {}
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'details', provider_id: 'ssh:biowulf', mode: 'read' }
      })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { doc: string; isSkeleton: boolean } }
    expect(body.result.doc).toBe('doc for ssh:biowulf')
    expect(body.result.isSkeleton).toBe(false)
  })

  it('routes computeCall op=details mode=append to appendDetails with author=agent', async () => {
    let capturedArgs: unknown
    const fakeCompute = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: false }),
      appendDetails: async (providerId: string, args: unknown) => {
        capturedArgs = { providerId, ...((args ?? {}) as object) }
      },
      replaceDetails: async () => {}
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'details', provider_id: 'ssh:biowulf', mode: 'append', text: '## Note\nhi' }
      })
    })
    expect(res.status).toBe(200)
    expect(capturedArgs).toMatchObject({
      providerId: 'ssh:biowulf',
      text: '## Note\nhi',
      author: 'agent'
    })
  })

  it('routes computeCall op=details mode=replace to replaceDetails with author=agent', async () => {
    let capturedArgs: unknown
    const fakeCompute = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: false }),
      appendDetails: async () => {},
      replaceDetails: async (providerId: string, args: unknown) => {
        capturedArgs = { providerId, ...((args ?? {}) as object) }
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: {
          op: 'details',
          provider_id: 'ssh:biowulf',
          mode: 'replace',
          text: 'new doc',
          old_text: 'old doc'
        }
      })
    })
    expect(res.status).toBe(200)
    expect(capturedArgs).toMatchObject({
      providerId: 'ssh:biowulf',
      text: 'new doc',
      oldText: 'old doc',
      author: 'agent'
    })
  })

  it('returns 500 for unknown details mode', async () => {
    const fakeCompute = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: false }),
      appendDetails: async () => {},
      replaceDetails: async () => {}
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'details', provider_id: 'ssh:biowulf', mode: 'zap' }
      })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/unknown details mode/i)
  })

  it('routes computeCall op=submit_job with canonical arguments and trusted context', async () => {
    const captured: unknown[] = []
    const fakeJob = { job_id: 'job-42', status: 'queued' }
    const fakeCompute = {
      submitJob: async (...args: unknown[]) => {
        captured.push(...args)
        return fakeJob
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: {
          op: 'submit_job',
          provider_id: 'ssh:biowulf',
          intent: 'analyze data',
          command: 'python analyze.py',
          environment: 'module load python',
          resources: { cpus: 4, memory_gb: 16 },
          inputs: ['data/input.csv'],
          outputs: [{ path: 'results.csv', featured: true }],
          harvest: { mode: 'manifest' },
          timeout_seconds: 600,
          workspace_cwd: 'workspace/project',
          session_id: 'forged-session',
          project_id: 'forged-project'
        }
      })
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ result: fakeJob })
    expect(captured).toEqual([
      'ssh:biowulf',
      'analyze data',
      'python analyze.py',
      {
        environment: 'module load python',
        resourceRequest: JSON.stringify({ cpus: 4, memory_gb: 16 }),
        inputs: ['data/input.csv'],
        outputManifest: JSON.stringify([{ path: 'results.csv', featured: true }]),
        harvestConfig: JSON.stringify({ mode: 'manifest' }),
        timeoutSeconds: 600,
        workspaceCwd: 'workspace/project'
      },
      { sessionId: 's-42', projectId: 'project-1' }
    ])
  })

  it('serializes submit_job compute call errors', async () => {
    const submitErr = new Error('approval denied') as Error & { computeCallError: unknown }
    submitErr.computeCallError = {
      error_code: 'approval_denied',
      message: 'Approval denied.',
      retry_after_user_action: false
    }
    const fakeCompute = {
      submitJob: async () => {
        throw submitErr
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: {
          op: 'submit_job',
          provider_id: 'ssh:biowulf',
          intent: 'analyze data',
          command: 'python analyze.py'
        }
      })
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(JSON.parse(body.error)).toEqual(submitErr.computeCallError)
  })

  it('routes computeCall op=job_status to the compute service', async () => {
    const fakeStatus = { job_id: 'job-42', status: 'running' }
    const seenJobIds: string[] = []
    const fakeCompute = {
      getJobStatus: async (jobId: string) => {
        seenJobIds.push(jobId)
        return fakeStatus
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'job_status', job_id: 'job-42' }
      })
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ result: fakeStatus })
    expect(seenJobIds).toEqual(['job-42'])
  })

  it('routes computeCall op=job_result to getJobResult', async () => {
    const fakeResult = {
      job_id: 'job-42',
      status: 'success',
      exit_code: 0,
      featured_files: ['hpc/job-42/featured/out.result'],
      hidden_files: [],
      output_files: ['hpc/job-42/featured/out.result'],
      left_on_remote: [],
      remote_workdir: '~/.openscience/jobs/job-42',
      stdout_tail: 'done\n',
      stderr_tail: ''
    }
    const fakeCompute = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: false }),
      appendDetails: async () => {},
      replaceDetails: async () => {},
      submitJob: async () => ({}),
      getJobStatus: async () => ({}),
      getJobResult: async (jobId: string) => ({ ...fakeResult, job_id: jobId }),
      getEnabledComputeHosts: () => []
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'job_result', job_id: 'job-42' }
      })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: typeof fakeResult }
    expect(body.result.job_id).toBe('job-42')
    expect(body.result.featured_files).toContain('hpc/job-42/featured/out.result')
    expect(body.result.output_files).toContain('hpc/job-42/featured/out.result')
  })

  it('routes computeCall op=job_result errors through computeError serialization', async () => {
    const fakeCompute = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: false }),
      appendDetails: async () => {},
      replaceDetails: async () => {},
      submitJob: async () => ({}),
      getJobStatus: async () => ({}),
      getJobResult: async () => {
        throw new Error('No compute job found with id "missing".')
      },
      getEnabledComputeHosts: () => []
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await sessionConnection(server)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'job_result', job_id: 'missing' }
      })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/No compute job/)
  })
})
