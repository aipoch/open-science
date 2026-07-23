import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookRuntimeService } from './runtime-service'
import { NotebookRunRepository } from './repository'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-rpc-'))
  return storageRoot
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('notebook local RPC server', () => {
  it('requires a bearer token and dispatches notebook execute calls', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: '2\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: [],
          workingFiles: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const server = new NotebookLocalRpcServer(service, { token: 'secret-token' })
    const connection = await server.ensureStarted()

    try {
      const unauthorized = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'state',
          params: { sessionId: 'session-1', workspaceCwd: '/workspace' }
        })
      })

      expect(unauthorized.status).toBe(401)

      const authorized = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'execute',
          params: {
            projectName: 'default-project',
            sessionId: 'session-1',
            workspaceCwd: '/workspace',
            code: 'print(1 + 1)'
          }
        })
      })
      const payload = (await authorized.json()) as {
        result: { status: string; text: { stdout: string } }
      }

      expect(authorized.status).toBe(200)
      expect(payload.result).toMatchObject({
        status: 'completed',
        text: {
          stdout: '2\n'
        }
      })
    } finally {
      await server.close()
    }
  })

  it('maps pre-start notebook session aliases to the final ACP session id', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: 'ok\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: [],
          workingFiles: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const server = new NotebookLocalRpcServer(service, { token: 'secret-token' })
    const connection = await server.ensureStarted()

    server.registerSessionAlias('notebook-session-1', 'real-session-1')

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'execute',
          params: {
            projectName: 'default-project',
            sessionId: 'notebook-session-1',
            workspaceCwd: '/workspace',
            code: 'print("ok")'
          }
        })
      })

      expect(response.status).toBe(200)
      await expect(
        readFile(join(root, 'notebooks', 'default-project', 'real-session-1', 'run.json'), 'utf8')
      ).resolves.toContain('"sessionId": "real-session-1"')
    } finally {
      await server.close()
    }
  })

  it('dispatches managePackages to the runtime service', async () => {
    const root = await createStorageRoot()
    const calls: unknown[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      installPackagesImpl: async (request) => {
        calls.push(request)
        return { ok: true, needsRestart: false, log: 'installed' }
      }
    })
    const server = new NotebookLocalRpcServer(service, { token: 'secret-token' })
    const connection = await server.ensureStarted()

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'managePackages',
          params: {
            sessionId: 'session-1',
            workspaceCwd: '/workspace',
            language: 'python',
            packages: ['numpy']
          }
        })
      })
      const payload = (await response.json()) as { result: { ok: boolean; log: string } }

      expect(response.status).toBe(200)
      expect(payload.result).toEqual({ ok: true, needsRestart: false, log: 'installed' })
      expect(calls).toEqual([expect.objectContaining({ language: 'python', packages: ['numpy'] })])
    } finally {
      await server.close()
    }
  })

  it('dispatches manageEnvironments to the runtime service', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentManager: {
        createNamedEnvironment: async (name, language) => ({
          name,
          language,
          ready: true,
          isDefault: false
        }),
        listEnvironments: () => [
          { name: 'default-python', language: 'python', ready: true, isDefault: true }
        ],
        removeEnvironment: () => []
      }
    })
    const server = new NotebookLocalRpcServer(service, { token: 'secret-token' })
    const connection = await server.ensureStarted()

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'manageEnvironments',
          params: {
            sessionId: 'session-1',
            workspaceCwd: '/workspace',
            action: 'list'
          }
        })
      })
      const payload = (await response.json()) as {
        result: { environments: Array<{ name: string }> }
      }

      expect(response.status).toBe(200)
      expect(payload.result.environments.map((env) => env.name)).toEqual(['default-python'])
    } finally {
      await server.close()
    }
  })

  it('list_compute op returns the enabled hosts for the given session', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    // Inject a fake compute service with the minimal surface the dispatch needs.
    const fakeComputeService = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: true }),
      appendDetails: async () => {},
      replaceDetails: async () => {},
      download: async () => ({}),
      submitJob: async () => ({}),
      getJobStatus: async () => ({}),
      getJobResult: async () => ({}),
      // Returns pre-configured enabled hosts for the session under test.
      getEnabledComputeHosts: (sessionId: string): string[] => {
        if (sessionId === 'my-session') return ['ssh:cluster-1']
        return []
      },
      setSessionConcurrencyLimit: async () => {},
      getSessionConcurrencyStatus: async () => ({
        session_limit: null,
        active_count: 0,
        queued_count: 0,
        provider_ceilings: {}
      })
    }
    const server = new NotebookLocalRpcServer(service, {
      token: 'secret-token',
      computeService: fakeComputeService
    })
    const connection = await server.ensureStarted()

    try {
      // Known session → returns the registered host list.
      const withHosts = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'computeCall',
          params: { op: 'list_compute', session_id: 'my-session' }
        })
      })
      const withHostsPayload = (await withHosts.json()) as { result: string[] }

      expect(withHosts.status).toBe(200)
      expect(withHostsPayload.result).toEqual(['ssh:cluster-1'])

      // Unknown session → empty array.
      const noHosts = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'computeCall',
          params: { op: 'list_compute', session_id: 'other-session' }
        })
      })
      const noHostsPayload = (await noHosts.json()) as { result: string[] }

      expect(noHosts.status).toBe(200)
      expect(noHostsPayload.result).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('set_concurrency_limit op calls setSessionConcurrencyLimit with session_id and limit', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const calls: Array<{ sessionId: string; limit: number }> = []
    const fakeComputeService = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: true }),
      appendDetails: async () => {},
      replaceDetails: async () => {},
      download: async () => ({}),
      submitJob: async () => ({}),
      getJobStatus: async () => ({}),
      getJobResult: async () => ({}),
      getEnabledComputeHosts: () => [],
      setSessionConcurrencyLimit: async (sessionId: string, limit: number) => {
        calls.push({ sessionId, limit })
      },
      getSessionConcurrencyStatus: async () => ({
        session_limit: null,
        active_count: 0,
        queued_count: 0,
        provider_ceilings: {}
      })
    }
    const server = new NotebookLocalRpcServer(service, {
      token: 'secret-token',
      computeService: fakeComputeService
    })
    const connection = await server.ensureStarted()

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'computeCall',
          params: { op: 'set_concurrency_limit', session_id: 'my-session', limit: 10 }
        })
      })

      expect(response.status).toBe(200)
      expect(calls).toEqual([{ sessionId: 'my-session', limit: 10 }])
    } finally {
      await server.close()
    }
  })

  it('concurrency_status op calls getSessionConcurrencyStatus and returns the status dict', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const fakeComputeService = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: true }),
      appendDetails: async () => {},
      replaceDetails: async () => {},
      download: async () => ({}),
      submitJob: async () => ({}),
      getJobStatus: async () => ({}),
      getJobResult: async () => ({}),
      getEnabledComputeHosts: () => [],
      setSessionConcurrencyLimit: async () => {},
      getSessionConcurrencyStatus: async (sessionId: string) => ({
        session_limit: sessionId === 'my-session' ? 5 : null,
        active_count: 2,
        queued_count: 1,
        provider_ceilings: { 'ssh:cluster-a': 10 }
      })
    }
    const server = new NotebookLocalRpcServer(service, {
      token: 'secret-token',
      computeService: fakeComputeService
    })
    const connection = await server.ensureStarted()

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'computeCall',
          params: { op: 'concurrency_status', session_id: 'my-session' }
        })
      })
      const payload = (await response.json()) as {
        result: {
          session_limit: number
          active_count: number
          queued_count: number
          provider_ceilings: Record<string, number>
        }
      }

      expect(response.status).toBe(200)
      expect(payload.result).toEqual({
        session_limit: 5,
        active_count: 2,
        queued_count: 1,
        provider_ceilings: { 'ssh:cluster-a': 10 }
      })
    } finally {
      await server.close()
    }
  })
})
