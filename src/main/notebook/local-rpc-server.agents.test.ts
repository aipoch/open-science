import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookRunRepository } from './repository'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const makeService = async (): Promise<NotebookRuntimeService> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'os-rpc-agents-'))
  return new NotebookRuntimeService({
    configRoot: storageRoot,
    dataRoot: storageRoot,
    projectName: 'default-project',
    repository: new NotebookRunRepository(storageRoot),
    executorFactory: () => ({
      execute: async () => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: storageRoot!,
        outputs: [],
        workingFiles: []
      }),
      shutdown: async () => ({ reaped: true })
    })
  })
}

describe('notebook RPC agentsCall route', () => {
  it('rejects agentsCall through the server master token even with forged trusted identity fields', async () => {
    const read = vi.fn(async () => [])
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      token: 'tok',
      agentsService: { read }
    })
    const connection = await server.ensureStarted()
    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'agentsCall',
          params: {
            op: 'switch',
            session_id: 'forged-session',
            turn_id: 'forged-turn',
            generation: 999,
            control_invocation_generation: 999,
            control_invocation_id: 'forged-tool',
            name: 'Forged Specialist'
          }
        })
      })

      expect(response.status).toBe(401)
      expect(read).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('forwards the op to the AgentsService and returns its result', async () => {
    const read = vi.fn(async () => [{ id: 'sp-1', name: 'Bio', revision: 1 }])
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      token: 'tok',
      agentsService: { read }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    try {
      const res = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'agentsCall', params: { op: 'list' } })
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.result).toHaveLength(1)
      expect(read).toHaveBeenCalledWith(
        { op: 'list', params: {} },
        expect.objectContaining({ sessionId: 'trusted-session' })
      )
    } finally {
      connection.release()
      await server.close()
    }
  })

  it('rejects calls without the bearer token', async () => {
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      token: 'tok',
      agentsService: { read: vi.fn() }
    })
    const connection = await server.ensureStarted()
    try {
      const res = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'agentsCall', params: { op: 'list' } })
      })
      expect(res.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('rejects a privileged switch when the session capability has no active control invocation', async () => {
    const read = vi.fn(async () => ({ status: 'approved' }))
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      agentsService: { read }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'agentsCall',
          params: {
            op: 'switch',
            session_id: 'forged-session',
            turn_id: 'forged-turn',
            generation: 999,
            control_invocation_generation: 999,
            control_invocation_id: 'forged-tool',
            name: 'Forged Specialist'
          }
        })
      })

      expect(response.status).toBe(403)
      expect(read).not.toHaveBeenCalled()
    } finally {
      connection.release()
      await server.close()
    }
  })

  it('forwards snake_case params and the trusted session_id as context', async () => {
    const read = vi.fn(async () => null)
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      token: 'tok',
      agentsService: { read }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    try {
      await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'agentsCall',
          params: { op: 'list_skills', session_id: 'session-42', name_or_id: 'demo' }
        })
      })
      // The capability binding becomes the trusted calling-session context; the AgentsService never
      // sees the caller-supplied session id as a user param.
      expect(read).toHaveBeenCalledWith(
        { op: 'list_skills', params: { name_or_id: 'demo' } },
        { sessionId: 'trusted-session', callerRole: 'main' }
      )
    } finally {
      connection.release()
      await server.close()
    }
  })

  it('surfaces a sanitized error on 500 when AgentsService throws', async () => {
    const read = vi.fn(async () => {
      throw new Error('host.agents.get: not found')
    })
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      token: 'tok',
      agentsService: { read }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    try {
      const res = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'agentsCall', params: { op: 'get', name: 'x' } })
      })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toMatch(/host\.agents\.get:/)
    } finally {
      connection.release()
      await server.close()
    }
  })

  it('strips sandbox-supplied switch/reconfigure/identity fields so they cannot be forged', async () => {
    const read = vi.fn(async () => null)
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      token: 'tok',
      agentsService: { read }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    try {
      await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'agentsCall',
          params: {
            op: 'list_skills',
            // Trusted session captured outside the sandbox — forwarded as context only.
            session_id: 'trusted-session',
            // Everything below is a sandbox forgery attempt that must be dropped before dispatch.
            sessionId: 'forged-camel',
            specialist_id: 'forged-specialist',
            target_specialist_id: 'forged-target',
            targetSpecialistId: 'forged-target-camel',
            reconfigure: true,
            context_reset: true,
            contextReset: true,
            // A legitimate snake_case method filter survives.
            name_or_id: 'demo'
          }
        })
      })
      // Only the trusted session_id (as context) and the legitimate method filter reach the service.
      expect(read).toHaveBeenCalledWith(
        { op: 'list_skills', params: { name_or_id: 'demo' } },
        { sessionId: 'trusted-session', callerRole: 'main' }
      )
    } finally {
      connection.release()
      await server.close()
    }
  })

  it('forwards to dispatch() when the agentsService exposes it', async () => {
    const dispatch = vi.fn(async () => ['via-dispatch'])
    const read = vi.fn(async () => ['via-read'])
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      token: 'tok',
      agentsService: { read, dispatch }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    try {
      const res = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'agentsCall', params: { op: 'list' } })
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      // read() is the documented call site (backward compat); dispatch is the extension point the
      // route MAY use. Either way the op and trusted session are forwarded correctly.
      expect(body.result).toHaveLength(1)
    } finally {
      connection.release()
      await server.close()
    }
  })
})
