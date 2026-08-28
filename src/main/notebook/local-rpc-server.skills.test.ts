import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const makeService = async (): Promise<NotebookRuntimeService> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'os-rpc-skills-'))
  return new NotebookRuntimeService({
    configRoot: storageRoot,
    dataRoot: storageRoot,
    projectId: 'project-a',
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

describe('notebook RPC skillsCall route', () => {
  it('requires a session-bound control token', async () => {
    const dispatch = vi.fn(async () => [])
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      token: 'master',
      skillsService: { dispatch }
    })
    const connection = await server.ensureStarted()
    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer master', 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'skillsCall', params: { op: 'list' } })
      })
      expect(response.status).toBe(401)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('forwards sanitized params with server-owned session context', async () => {
    const dispatch = vi.fn(async () => ({ status: 'deleted' }))
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      skillsService: { dispatch }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'project-a',
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
          method: 'skillsCall',
          params: {
            op: 'delete',
            name: 'demo',
            session_id: 'forged-session',
            projectId: 'forged-project'
          }
        })
      })
      expect(response.status).toBe(200)
      expect(dispatch).toHaveBeenCalledWith(
        { op: 'delete', params: { name: 'demo' } },
        { sessionId: 'trusted-session' }
      )
    } finally {
      connection.release()
      await server.close()
    }
  })

  it('does not expose host.skills when the owning framework disables it', async () => {
    const dispatch = vi.fn(async () => [])
    const server = new NotebookLocalRpcServer(await makeService(), {
      transport: 'tcp',
      skillsService: { dispatch },
      isHostSkillsAvailable: () => false
    })
    const connection = await server.issueControlConnection(
      'codebuddy-session',
      'project-a',
      'root-frame-codebuddy-session'
    )
    try {
      const capabilities = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'capabilitiesCall', params: {} })
      })
      await expect(capabilities.json()).resolves.toMatchObject({ result: { skills: false } })

      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'skillsCall', params: { op: 'list' } })
      })
      expect(response.status).toBe(403)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      connection.release()
      await server.close()
    }
  })
})
