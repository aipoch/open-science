import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest, type Server } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ABOUT_YOU_MEMORY_CATEGORY_ID } from '../../shared/memory'
import type { NotebookRunInputFile, NotebookRunProvenanceContext } from '../../shared/notebook'
import { PlanCommandError } from '../../shared/session-plan/contract'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { migrateApplicationDatabase } from '../database/migration-service'
import { fetchLocalRpc } from '../local-rpc-transport'
import { MemoryRepository } from '../memory/repository'
import { MemoryService } from '../memory/service'
import { createProjectDbClient } from '../projects/prisma-client'
import {
  acceptMissingDataRoot,
  initializeDataRootWriteAvailability
} from '../storage/migration-state'
import { createNotebookArtifactSourceScopeProvider } from './artifact-source-scope'
import { NotebookLocalRpcServer } from './local-rpc-server'
import {
  NotebookControlCompletionCapturedError,
  NotebookRuntimeService,
  type NotebookExecutionRequest
} from './runtime-service'
import { NotebookRunRepository, getRuntimeRoot } from './repository'
import type { NotebookInputRunLease } from './input-registry'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  envPrefix,
  pythonBin,
  writeReadyMarker
} from './runtime-paths'

let storageRoot: string | undefined

const helperDigest = (source: string): string => createHash('sha256').update(source).digest('hex')

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-rpc-'))
  return storageRoot
}

const createDeferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const registeredInput = {
  inputFileVersionId: 'upload-version-1',
  sourceKind: 'upload-version' as const,
  sourceFileId: 'upload-1',
  sourceVersionNumber: 1,
  sourceProjectId: 'default-project',
  sourceSessionId: 'source-session',
  filename: 'groups.csv',
  sizeBytes: 10,
  checksum: 'a'.repeat(64),
  storageKey: 'uploads/default-project/source-session/upload-version-1/content',
  association: 'turn-attached' as const
}

const artifactCapabilityBinding = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactStorageSessionId: 'artifact-session-1',
  artifactRunId: 'artifact-run-1',
  rootFrameId: 'frame-root',
  agentFrameId: 'frame-root',
  messageBranchId: 'branch-root',
  messageBranchAncestry: ['branch-parent', 'branch-root'],
  messageAncestry: ['message-parent', 'message-user-1'],
  runtimeSegmentId: 'runtime-1',
  promptMessageId: 'message-user-1',
  agentName: 'Claude Code',
  notebookSessionId: 'notebook-session-1'
} as const

afterEach(async () => {
  initializeDataRootWriteAvailability(false)
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('notebook local RPC server', () => {
  it('does not recreate a missing data root before empty-folder acceptance', async () => {
    const parentRoot = await createStorageRoot()
    const missingDataRoot = join(parentRoot, 'missing-data-root')
    initializeDataRootWriteAvailability(true)
    const service = new NotebookRuntimeService({
      configRoot: parentRoot,
      dataRoot: missingDataRoot,
      projectId: 'default-project',
      repository: new NotebookRunRepository(missingDataRoot)
    })
    const server = new NotebookLocalRpcServer(service, { transport: 'tcp' })
    const connection = await server.issueSessionConnection(
      'session-1',
      'default-project',
      'root-frame-session-1'
    )
    const response = fetchLocalRpc(
      connection,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'state',
          params: { sessionId: 'session-1', workspaceCwd: '/workspace' }
        })
      },
      'missing data root Notebook gate test'
    )

    try {
      let recreated = false
      for (let attempt = 0; attempt < 20 && !recreated; attempt += 1) {
        recreated = await stat(missingDataRoot).then(
          () => true,
          () => false
        )
        if (!recreated) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(recreated).toBe(false)

      await acceptMissingDataRoot()
      await expect(response.then((result) => result.status)).resolves.toBe(200)
    } finally {
      await acceptMissingDataRoot()
      await response.catch(() => undefined)
      connection.release?.()
      await server.close()
      await service.dispose()
    }
  })

  it('canonicalizes caller-controlled notebook run sources to Agent authority', async () => {
    const beginCodeCell = vi.fn(async (request: unknown) => request)
    const runCell = vi.fn(async (request: unknown) => request)
    const execute = vi.fn(async (request: unknown) => request)
    const server = new NotebookLocalRpcServer({ beginCodeCell, runCell, execute } as never, {
      transport: 'tcp'
    })
    const connection = await server.issueSessionConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )

    try {
      for (const [method, methodParams] of [
        ['beginCodeCell', {}],
        ['runCell', { cellId: 'cell-1' }],
        ['execute', { code: 'print(1)' }]
      ] as const) {
        const response = await fetchLocalRpc(
          connection,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${connection.token}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              method,
              params: {
                sessionId: 'session-1',
                workspaceCwd: '/workspace',
                source: 'user',
                ...methodParams
              }
            })
          },
          'Notebook source authority test'
        )
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({ result: { source: 'agent' } })
      }
      expect(beginCodeCell).toHaveBeenCalledWith(expect.objectContaining({ source: 'agent' }))
      expect(runCell).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent' }),
        expect.any(AbortSignal)
      )
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent' }),
        expect.any(AbortSignal)
      )
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('routes memory search through a main-only capability after trusted session binding', async () => {
    const memoryResult = {
      id: 'entry-1',
      categoryId: 'category-1',
      categoryName: 'Research',
      scope: 'project' as const,
      content: 'trusted result',
      revision: 1,
      provenance: { origin: 'agent' as const, agentId: 'specialist-1' },
      updatedAt: 1
    }
    const memorySearch = vi.fn(async () => [memoryResult])
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      memoryService: {
        listCategoriesForAgent: vi.fn(async () => []),
        searchForAgent: memorySearch,
        rememberForAgent: vi.fn(async () => ({
          status: 'created' as const,
          memory: { ...memoryResult, content: 'saved' }
        }))
      }
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'project-1',
      'root-frame-trusted-session'
    )
    server.registerSessionSpecialist('trusted-session', 'specialist-1')

    try {
      const response = await fetch(control.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'memorySearch',
          params: {
            query: 'microscopy',
            limit: 4,
            projectId: 'forged-project',
            sessionId: 'forged'
          }
        })
      })

      expect(response.status).toBe(200)
      expect(memorySearch).toHaveBeenCalledWith(
        {
          query: 'microscopy',
          categoryIds: undefined,
          limit: 4
        },
        {
          projectId: 'project-1',
          sessionId: 'trusted-session',
          agentId: 'specialist-1'
        }
      )
    } finally {
      control.release()
      await server.close()
    }
  })

  it('rejects Memory RPC through a Session capability issued with Memory disabled', async () => {
    const memorySearch = vi.fn(async () => [])
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      memoryService: {
        listCategoriesForAgent: vi.fn(async () => []),
        searchForAgent: memorySearch,
        rememberForAgent: vi.fn()
      }
    })
    const connection = await server.issueSessionConnection(
      'session-off',
      'project-1',
      'root-frame-session-off',
      false
    )

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'memorySearch', params: { query: 'private' } })
      })

      expect(response.status).toBe(403)
      expect(memorySearch).not.toHaveBeenCalled()
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('uses the current Session gate when Memory is enabled after capability issue', async () => {
    let memoryEnabled = false
    const memorySearch = vi.fn(async () => [])
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      isMemoryEnabledForSession: async () => memoryEnabled,
      memoryService: {
        listCategoriesForAgent: vi.fn(async () => []),
        searchForAgent: memorySearch,
        rememberForAgent: vi.fn()
      }
    })
    const connection = await server.issueSessionConnection(
      'session-toggle',
      'project-1',
      'root-frame-session-toggle',
      false
    )
    const request = (): Promise<Response> =>
      fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'memorySearch', params: { query: 'remembered' } })
      })

    try {
      expect((await request()).status).toBe(403)
      memoryEnabled = true
      expect((await request()).status).toBe(200)
      expect(memorySearch).toHaveBeenCalledOnce()
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('rejects Memory RPC when the current Main-owned Session gate is disabled', async () => {
    const memorySearch = vi.fn(async () => [])
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      isMemoryEnabledForSession: async () => false,
      memoryService: {
        listCategoriesForAgent: vi.fn(async () => []),
        searchForAgent: memorySearch,
        rememberForAgent: vi.fn()
      }
    })
    const control = await server.issueControlConnection(
      'session-off',
      'project-1',
      'root-frame-session-off'
    )

    try {
      const response = await fetch(control.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'memorySearch', params: { query: 'private' } })
      })

      expect(response.status).toBe(403)
      expect(memorySearch).not.toHaveBeenCalled()
    } finally {
      control.release()
      await server.close()
    }
  })

  it('recalls an Agent memory after reopen from another session and Agent', async () => {
    const root = await createStorageRoot()
    let client: PrismaClient = createProjectDbClient(root)
    const createMemoryService = (): MemoryService =>
      new MemoryService(new MemoryRepository(async () => client), { publish: vi.fn() })

    try {
      await migrateApplicationDatabase(client)
      await client.project.createMany({
        data: [
          { id: 'project-a', name: 'Project A' },
          { id: 'project-b', name: 'Project B' }
        ]
      })
      const firstMemoryService = createMemoryService()
      await firstMemoryService.setEnabled({ enabled: true })
      const firstServer = new NotebookLocalRpcServer({} as never, {
        transport: 'tcp',
        memoryService: firstMemoryService
      })
      const firstControl = await firstServer.issueControlConnection(
        'session-a',
        'project-a',
        'root-frame-session-a'
      )
      firstServer.registerSessionSpecialist('session-a', 'agent-a')

      try {
        const response = await fetch(firstControl.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${firstControl.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'memoryRemember',
            params: {
              categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
              content: 'Always report migration checks before delivery.',
              analysis: {
                scope: 'project',
                durability: 'cross-session',
                evidence: 'user-stated',
                subject: 'Delivery checks',
                reason: 'Future sessions in this project need the same delivery check.',
                categoryReason: 'This is a stable user preference.'
              },
              projectId: 'forged-project',
              sessionId: 'forged-session',
              agentId: 'forged-agent'
            }
          })
        })

        expect(response.status).toBe(200)
      } finally {
        firstControl.release()
        await firstServer.close()
      }

      await client.$disconnect()
      client = createProjectDbClient(root)
      await migrateApplicationDatabase(client)
      const secondMemoryService = createMemoryService()

      await expect(
        secondMemoryService.recallForPrompt('Continue with an unrelated task.', {
          projectId: 'project-a'
        })
      ).resolves.toContain('Always report migration checks before delivery.')
      await expect(
        secondMemoryService.recallForPrompt('Continue with an unrelated task.', {
          projectId: 'project-b'
        })
      ).resolves.toBeUndefined()

      const secondServer = new NotebookLocalRpcServer({} as never, {
        transport: 'tcp',
        memoryService: secondMemoryService
      })
      const secondControl = await secondServer.issueControlConnection(
        'session-b',
        'project-a',
        'root-frame-session-b'
      )
      secondServer.registerSessionSpecialist('session-b', 'agent-b')

      try {
        const response = await fetch(secondControl.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secondControl.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'memorySearch',
            params: { query: 'migration checks', limit: 5 }
          })
        })
        const payload = (await response.json()) as {
          result: Array<{ content: string; provenance: { origin: string; agentId?: string } }>
        }

        expect(response.status).toBe(200)
        expect(payload.result).toEqual([
          expect.objectContaining({
            content: 'Always report migration checks before delivery.',
            provenance: { origin: 'agent', agentId: 'agent-a' }
          })
        ])
      } finally {
        secondControl.release()
        await secondServer.close()
      }
    } finally {
      await client.$disconnect()
    }
  })

  it('does not authorize memory tools for delegated control capabilities', async () => {
    const memoryResult = {
      id: 'entry-1',
      categoryId: 'category-1',
      categoryName: 'Research',
      scope: 'project' as const,
      content: 'saved',
      revision: 1,
      provenance: { origin: 'agent' as const },
      updatedAt: 1
    }
    const memorySearch = vi.fn(async () => [])
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      memoryService: {
        listCategoriesForAgent: vi.fn(async () => []),
        searchForAgent: memorySearch,
        rememberForAgent: vi.fn(async () => ({ status: 'created' as const, memory: memoryResult }))
      }
    })
    const control = await server.issueControlConnection(
      'delegate-session',
      'project-1',
      'delegate-frame',
      { role: 'delegate', attemptId: 'attempt-1' }
    )

    try {
      const response = await fetch(control.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'memorySearch', params: { query: 'private' } })
      })

      expect(response.status).toBe(403)
      expect(memorySearch).not.toHaveBeenCalled()
    } finally {
      control.release()
      await server.close()
    }
  })

  it('reports malformed authenticated JSON as a bad request', async () => {
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      token: 'secret-token'
    })
    const connection = await server.ensureStarted()

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: '{'
      })

      expect(response.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('rejects an authenticated request body above the local RPC budget', async () => {
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      token: 'secret-token',
      requestBytes: 2
    })
    const connection = await server.ensureStarted()

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: '{} '
      })

      expect(response.status).toBe(413)
      expect(response.headers.get('connection')).toBe('close')
    } finally {
      await server.close()
    }
  })

  it('binds viewImage to the trusted active control invocation and execution workspace', async () => {
    const stage = vi.fn(async (_source, _options, trusted) => trusted)
    const isAvailable = vi.fn(async () => true)
    const discard = vi.fn()
    const discardSession = vi.fn()
    const shutdown = vi.fn()
    const server = new NotebookLocalRpcServer({} as never, {
      hostViewImage: {
        isAvailable,
        stage,
        complete: vi.fn(async () => []),
        discard,
        discardSession,
        shutdown
      }
    })
    const connection = await server.issueControlConnection(
      'session-1',
      'project-1',
      'root-frame-session-1',
      { role: 'main' },
      '/trusted/workspace'
    )
    const call = (params: Record<string, unknown>): Promise<Response> =>
      fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ method: 'viewImageCall', params })
        },
        'host.viewImage capability test'
      )
    const capabilities = (): Promise<Response> =>
      fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ method: 'capabilitiesCall', params: {} })
        },
        'host.capabilities viewImage test'
      )
    const help = (): Promise<Response> =>
      fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'hostSdkHelp',
            params: { query: 'viewImage', view_image_available: true }
          })
        },
        'host.help viewImage availability test'
      )

    try {
      await expect(capabilities().then((response) => response.json())).resolves.toMatchObject({
        result: { viewImage: false }
      })
      await expect(help().then((response) => response.json())).resolves.toMatchObject({
        result: { availability: { status: 'unavailable' } }
      })
      await expect(call({ source: { path: 'plot.png' }, options: {} })).resolves.toMatchObject({
        status: 403
      })
      const release = connection.beginControlInvocation({
        turnId: 'turn-1',
        controlInvocationGeneration: 3,
        toolInvocationId: 'run-1'
      })
      await expect(capabilities().then((response) => response.json())).resolves.toMatchObject({
        result: { viewImage: true }
      })
      await expect(help().then((response) => response.json())).resolves.toMatchObject({
        result: { availability: { status: 'available' } }
      })
      const response = await call({ source: { path: 'plot.png' }, options: {} })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        result: {
          projectId: 'project-1',
          sessionId: 'session-1',
          executionCwd: '/trusted/workspace',
          controlInvocationId: 'run-1',
          signal: {}
        }
      })
      expect(stage).toHaveBeenCalledWith(
        { path: 'plot.png' },
        {},
        expect.objectContaining({
          projectId: 'project-1',
          sessionId: 'session-1',
          executionCwd: '/trusted/workspace',
          controlInvocationId: 'run-1'
        })
      )
      await expect(
        call({ source: { path: 'plot.png' }, options: {}, projectId: 'forged' })
      ).resolves.toMatchObject({ status: 400 })
      release()
      connection.release()
      expect(discard).toHaveBeenCalledWith('run-1')
    } finally {
      connection.release()
      await server.close()
    }
    expect(discardSession).not.toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('releases only the unfinished viewImage invocations owned by one control connection', async () => {
    const discard = vi.fn()
    const server = new NotebookLocalRpcServer({} as never, {
      hostViewImage: {
        isAvailable: vi.fn(async () => true),
        stage: vi.fn(),
        complete: vi.fn(async () => []),
        discard,
        discardSession: vi.fn(),
        shutdown: vi.fn()
      }
    })
    const left = await server.issueControlConnection(
      'session-1',
      'project-1',
      'frame-left',
      { role: 'main' },
      '/workspace-left'
    )
    const right = await server.issueControlConnection(
      'session-1',
      'project-1',
      'frame-right',
      { role: 'main' },
      '/workspace-right'
    )
    const endLeft = left.beginControlInvocation({
      turnId: 'turn-left',
      controlInvocationGeneration: 1,
      toolInvocationId: 'run-left'
    })
    const endRight = right.beginControlInvocation({
      turnId: 'turn-right',
      controlInvocationGeneration: 1,
      toolInvocationId: 'run-right'
    })

    try {
      endLeft()
      endRight()
      left.release()
      expect(discard).toHaveBeenCalledTimes(1)
      expect(discard).toHaveBeenLastCalledWith('run-left')

      right.release()
      expect(discard).toHaveBeenCalledTimes(2)
      expect(discard).toHaveBeenLastCalledWith('run-right')
    } finally {
      left.release()
      right.release()
      await server.close()
    }
  })

  it('rejects an invalid token before reading the request body', async () => {
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      token: 'secret-token'
    })
    const connection = await server.ensureStarted()
    const underlying = (server as unknown as { server?: Server }).server
    if (!underlying) throw new Error('Expected the local RPC server to be listening.')
    const accepted = once(underlying, 'request')
    let responseStatus: number | undefined
    let responseConnection: string | undefined
    const request = httpRequest(
      connection.endpoint,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer invalid-token',
          'content-type': 'application/json',
          'content-length': 1024
        }
      },
      (response) => {
        responseStatus = response.statusCode
        responseConnection = response.headers.connection
        response.resume()
      }
    )
    request.once('error', () => undefined)

    try {
      request.write('{')
      await accepted
      await vi.waitFor(() => expect(responseStatus).toBe(401), { timeout: 500 })
      expect(responseConnection).toBe('close')
    } finally {
      request.destroy()
      await server.close()
    }
  })

  it('rejects malformed notebook method params before calling the runtime capability', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }))
    const server = new NotebookLocalRpcServer({ execute } as never, { transport: 'tcp' })
    const connection = await server.issueSessionConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )

    try {
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: {
              sessionId: 'session-1',
              workspaceCwd: '/workspace',
              code: 'print(1)',
              language: 'julia'
            }
          })
        },
        'Notebook RPC request validation test'
      )

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: expect.stringContaining('Invalid notebook RPC params for execute')
      })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('injects only a fresh unambiguous app-owned execution authorization', async () => {
    const server = new NotebookLocalRpcServer({
      execute: vi.fn(async (request: unknown) => request),
      executeControl: vi.fn(async (request: unknown) => request),
      executeShell: vi.fn(async (request: unknown) => request)
    } as never)
    const connections: Array<Awaited<ReturnType<typeof server.issueSessionConnection>>> = []
    const dispatch = async (
      sessionId: string,
      code = 'print(1)',
      kernelSkillIds?: string[]
    ): Promise<Record<string, unknown>> => {
      const connection = await server.issueSessionConnection(
        sessionId,
        'project-1',
        `root-frame-${sessionId}`
      )
      connections.push(connection)
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: {
              sessionId: 'forged',
              workspaceCwd: '/workspace',
              code,
              ...(kernelSkillIds ? { kernelSkillIds } : {}),
              executionInvocationId: 'caller-controlled',
              registeredHelperSkillIds: ['forged-skill']
            }
          })
        },
        'Notebook execution authorization test'
      )
      expect(response.status).toBe(200)
      const payload = (await response.json()) as { result: Record<string, unknown> }
      return payload.result
    }

    const setTurn = (sessionId: string, promptMessageId = 'prompt-1'): void =>
      server.setArtifactTurnBinding(sessionId, {
        ownerExecutionId: `execution-${sessionId}`,
        projectId: 'project-1',
        provenanceContext: {
          rootFrameId: `root-frame-${sessionId}`,
          agentFrameId: `root-frame-${sessionId}`,
          messageBranchId: 'branch-1',
          runtimeSegmentId: 'runtime-1',
          promptMessageId
        }
      })

    try {
      setTurn('fresh')
      const freshId = server.authorizeExecution({
        sessionId: 'fresh',
        toolCallId: 'tool-fresh',
        promptMessageId: 'prompt-1',
        method: 'execute',
        rawInput: { code: 'print(1)' }
      })
      expect(freshId).toEqual(expect.any(String))
      const fresh = await dispatch('fresh')
      expect(fresh).toMatchObject({ executionInvocationId: freshId })
      expect(fresh).not.toHaveProperty('registeredHelperSkillIds')

      setTurn('missing')
      expect(await dispatch('missing')).not.toHaveProperty('executionInvocationId')

      setTurn('stale', 'current-prompt')
      expect(
        server.authorizeExecution({
          sessionId: 'stale',
          toolCallId: 'tool-stale',
          promptMessageId: 'old-prompt',
          method: 'execute',
          rawInput: { code: 'print(1)' }
        })
      ).toBeUndefined()
      expect(await dispatch('stale')).not.toHaveProperty('executionInvocationId')

      setTurn('duplicate')
      const firstId = server.authorizeExecution({
        sessionId: 'duplicate',
        toolCallId: 'tool-1',
        promptMessageId: 'prompt-1',
        method: 'execute',
        rawInput: { code: 'print(1)' }
      })
      expect(
        server.authorizeExecution({
          sessionId: 'duplicate',
          toolCallId: 'tool-1',
          promptMessageId: 'prompt-1',
          method: 'execute',
          rawInput: { code: 'print(1)' }
        })
      ).toBe(firstId)
      expect(
        server.authorizeExecution({
          sessionId: 'duplicate',
          toolCallId: 'tool-2',
          promptMessageId: 'prompt-1',
          method: 'execute',
          rawInput: { code: 'print(2)' }
        })
      ).toBeUndefined()
      expect(await dispatch('duplicate')).not.toHaveProperty('executionInvocationId')

      setTurn('mismatch')
      server.authorizeExecution({
        sessionId: 'mismatch',
        toolCallId: 'tool-mismatch',
        promptMessageId: 'prompt-1',
        method: 'execute',
        rawInput: { code: 'print(1)' }
      })
      expect(await dispatch('mismatch', 'print(2)')).not.toHaveProperty('executionInvocationId')
      expect(await dispatch('mismatch')).not.toHaveProperty('executionInvocationId')

      setTurn('helper-mismatch')
      server.authorizeExecution({
        sessionId: 'helper-mismatch',
        toolCallId: 'tool-helper-mismatch',
        promptMessageId: 'prompt-1',
        method: 'execute',
        rawInput: { code: 'print(1)', kernelSkillIds: ['helper-a'] }
      })
      expect(await dispatch('helper-mismatch', 'print(1)', ['helper-b'])).not.toHaveProperty(
        'executionInvocationId'
      )

      setTurn('helper-normalized')
      const normalizedHelperId = server.authorizeExecution({
        sessionId: 'helper-normalized',
        toolCallId: 'tool-helper-normalized',
        promptMessageId: 'prompt-1',
        method: 'execute',
        rawInput: { code: 'print(1)', kernelSkillIds: ['helper-a', 'helper-a'] }
      })
      expect(await dispatch('helper-normalized', 'print(1)', ['helper-a'])).toMatchObject({
        executionInvocationId: normalizedHelperId
      })

      setTurn('repl-default')
      const replId = server.authorizeExecution({
        sessionId: 'repl-default',
        toolCallId: 'tool-repl-default',
        promptMessageId: 'prompt-1',
        method: 'executeControl',
        rawInput: { code: 'return 1' }
      })
      const replConnection = await server.issueSessionConnection(
        'repl-default',
        'project-1',
        'root-frame-repl-default'
      )
      connections.push(replConnection)
      const replResponse = await fetchLocalRpc(
        replConnection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${replConnection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'executeControl',
            params: {
              sessionId: 'repl-default',
              workspaceCwd: '/workspace',
              code: 'return 1',
              timeoutMs: 1_815_000
            }
          })
        },
        'Notebook execution RPC'
      )
      expect(replResponse.status).toBe(200)
      expect(await replResponse.json()).toMatchObject({
        result: { executionInvocationId: replId }
      })

      setTurn('shell-default')
      const shellId = server.authorizeExecution({
        sessionId: 'shell-default',
        toolCallId: 'tool-shell-default',
        promptMessageId: 'prompt-1',
        method: 'executeShell',
        rawInput: { command: 'echo hi' }
      })
      const shellConnection = await server.issueSessionConnection(
        'shell-default',
        'project-1',
        'root-frame-shell-default'
      )
      connections.push(shellConnection)
      const shellResponse = await fetchLocalRpc(
        shellConnection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${shellConnection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'executeShell',
            params: {
              sessionId: 'shell-default',
              workspaceCwd: '/workspace',
              command: 'echo hi',
              timeoutMs: 120_000
            }
          })
        },
        'Notebook execution RPC'
      )
      expect(shellResponse.status).toBe(200)
      expect(await shellResponse.json()).toMatchObject({
        result: { executionInvocationId: shellId }
      })
    } finally {
      for (const connection of connections) connection.release?.()
      await server.close()
    }
  })

  it('does not claim a delayed execution authorization after the owning turn is replaced', async () => {
    const execute = vi.fn(async (request: unknown) => request)
    const server = new NotebookLocalRpcServer({ execute } as never, { transport: 'tcp' })
    const connection = await server.issueSessionConnection('session-1', 'project-1', 'root-frame-1')
    const provenanceContext: NotebookRunProvenanceContext = {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'root-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'shared-prompt'
    }
    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'project-1',
      provenanceContext
    })
    const staleInvocationId = server.authorizeExecution({
      sessionId: 'session-1',
      toolCallId: 'tool-from-execution-1',
      promptMessageId: 'shared-prompt',
      method: 'execute',
      rawInput: { code: 'print(1)' }
    })
    expect(staleInvocationId).toEqual(expect.any(String))

    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-2',
      projectId: 'project-1',
      provenanceContext
    })

    try {
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: {
              sessionId: 'session-1',
              workspaceCwd: '/workspace',
              code: 'print(1)'
            }
          })
        },
        'delayed stale execution authorization test'
      )

      expect(response.status).toBe(200)
      const payload = (await response.json()) as { result: Record<string, unknown> }
      expect(payload.result).not.toHaveProperty('executionInvocationId')
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('fails closed when a Session capability omits its Frame owner', async () => {
    const server = new NotebookLocalRpcServer({} as never)

    await expect(server.issueSessionConnection('session-1', 'project-1', '')).rejects.toThrow(
      'Notebook RPC capabilities require an explicit Agent Frame owner.'
    )
  })

  it('does not let a root Frame capability write through another active Frame lane', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const execute = vi.spyOn(service, 'execute')
    const server = new NotebookLocalRpcServer(service, { token: 'master-token' })
    const connection = await server.issueSessionConnection(
      'session-1',
      'default-project',
      'root-frame-session-1'
    )
    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'default-project',
      provenanceContext: {
        rootFrameId: 'root-frame-session-1',
        agentFrameId: 'child-frame-1',
        messageBranchId: 'branch-child',
        runtimeSegmentId: 'runtime-child',
        promptMessageId: 'message-child'
      }
    })

    try {
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: { sessionId: 'forged', workspaceCwd: '/workspace', code: 'forged = True' }
          })
        },
        'Notebook Frame capability test'
      )

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: 'Notebook RPC capability does not match active Agent Frame.'
      })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('binds Plan calls to the issued Session capability and rejects the master token', async () => {
    const root = await createStorageRoot()
    const call = vi.fn(async (input: unknown) => input)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      token: 'master-token',
      planService: { call }
    })
    const connection = await server.issuePlanConnection('session-1', 'project-1')
    const request = (token: string): Promise<Response> =>
      fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            method: 'planCall',
            params: {
              projectId: 'forged-project',
              sessionId: 'forged-session',
              operation: 'approve'
            }
          })
        },
        'Notebook Plan capability RPC'
      )

    try {
      expect((await request('master-token')).status).toBe(401)
      expect((await request(connection.token)).status).toBe(200)
      expect(call).toHaveBeenCalledWith({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve',
        input: undefined,
        signal: expect.any(AbortSignal)
      })

      call.mockRejectedValueOnce(
        new PlanCommandError('dependency-not-satisfied', 'A previous step is unfinished.')
      )
      const rejected = await request(connection.token)
      expect(rejected.status).toBe(500)
      await expect(rejected.json()).resolves.toEqual({
        error: {
          code: 'dependency-not-satisfied',
          message: 'A previous step is unfinished.'
        }
      })
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('keeps the Plan signal active after a complete response and closes idle TCP promptly', async () => {
    const root = await createStorageRoot()
    let callSignal: AbortSignal | undefined
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      planService: {
        call: async (input) => {
          callSignal = input.signal
          return { approval: 'approved' }
        }
      }
    })
    const connection = await server.issuePlanConnection('session-1', 'project-1')
    let close: Promise<void> | undefined

    try {
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ method: 'planCall', params: { operation: 'approve' } })
        },
        'Notebook Plan capability RPC'
      )
      expect(response.status).toBe(200)
      expect(callSignal).toBeInstanceOf(AbortSignal)
      expect(callSignal?.aborted).toBe(false)

      close = server.close()
      const closeSettled = vi.fn()
      void close.then(closeSettled)
      await vi.waitFor(() => expect(closeSettled).toHaveBeenCalledTimes(1), {
        timeout: 250,
        interval: 10
      })
      expect(callSignal?.aborted).toBe(false)
    } finally {
      await close?.catch(() => undefined)
      connection.release?.()
      await server.close()
    }
  })

  it.each(['tcp', 'pipe'] as const)(
    'aborts the Plan signal when its client disconnects over %s',
    async (transport) => {
      const root = await createStorageRoot()
      const callStarted = createDeferred<AbortSignal>()
      const pendingCall = createDeferred<unknown>()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root)
      })
      const server = new NotebookLocalRpcServer(service, {
        transport,
        planService: {
          call: async (input) => {
            callStarted.resolve(input.signal)
            return pendingCall.promise
          }
        }
      })
      const connection = await server.issuePlanConnection('session-1', 'project-1')
      const disconnect = new AbortController()

      try {
        const request = fetchLocalRpc(
          connection,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${connection.token}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              method: 'planCall',
              params: { operation: 'generate', input: { schema_version: 1 } }
            }),
            signal: disconnect.signal
          },
          'Notebook Plan capability RPC'
        )
        const signal = await callStarted.promise
        expect(signal.aborted).toBe(false)
        disconnect.abort()
        await expect(request).rejects.toMatchObject({ cause: expect.any(Error) })
        await vi.waitFor(() => expect(signal.aborted).toBe(true))
      } finally {
        pendingCall.resolve(undefined)
        connection.release?.()
        await server.close()
      }
    }
  )

  it.each(['tcp', 'pipe'] as const)(
    'aborts notebook data execution when its client disconnects over %s',
    async (transport) => {
      const callStarted = createDeferred<AbortSignal>()
      const pendingCall = createDeferred<unknown>()
      const server = new NotebookLocalRpcServer(
        {
          execute: async (_request: unknown, signal?: AbortSignal) => {
            if (!signal) throw new Error('Expected a notebook execution signal.')
            callStarted.resolve(signal)
            return pendingCall.promise
          }
        } as never,
        { transport }
      )
      const connection = await server.ensureStarted()
      const disconnect = new AbortController()

      try {
        const request = fetchLocalRpc(
          connection,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${connection.token}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              method: 'execute',
              params: { sessionId: 'session-1', workspaceCwd: '/workspace', code: 'long()' }
            }),
            signal: disconnect.signal
          },
          'Notebook execution RPC'
        )
        const signal = await callStarted.promise
        expect(signal.aborted).toBe(false)
        disconnect.abort()
        await expect(request).rejects.toMatchObject({ cause: expect.any(Error) })
        await vi.waitFor(() => expect(signal.aborted).toBe(true))
      } finally {
        pendingCall.resolve(undefined)
        await server.close()
      }
    }
  )

  it('aborts an in-flight Plan call before promptly closing the server', async () => {
    const root = await createStorageRoot()
    const callStarted = createDeferred<AbortSignal>()
    const pendingCall = createDeferred<unknown>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      planService: {
        call: async (input) => {
          callStarted.resolve(input.signal)
          input.signal.addEventListener('abort', () => pendingCall.resolve(undefined), {
            once: true
          })
          return pendingCall.promise
        }
      }
    })
    const connection = await server.issuePlanConnection('session-1', 'project-1')
    let request: Promise<Response> | undefined
    let close: Promise<void> | undefined

    try {
      request = fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'planCall',
            params: { operation: 'generate', input: { schema_version: 1 } }
          })
        },
        'Notebook Plan capability RPC'
      )
      const signal = await callStarted.promise
      close = server.close()
      const closeSettled = vi.fn()
      void close.then(closeSettled)

      await vi.waitFor(() => expect(signal.aborted).toBe(true))
      await vi.waitFor(() => expect(closeSettled).toHaveBeenCalledTimes(1), {
        timeout: 250,
        interval: 10
      })
      await expect(request).resolves.toMatchObject({ status: 200 })
    } finally {
      pendingCall.resolve(undefined)
      await Promise.allSettled([request ?? Promise.resolve(), close ?? Promise.resolve()])
      connection.release?.()
      await server.close()
    }
  })

  it('aborts a Plan call registered after graceful shutdown has started', async () => {
    const root = await createStorageRoot()
    const callStarted = createDeferred<AbortSignal>()
    const pendingCall = createDeferred<unknown>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      planService: {
        call: async (input) => {
          callStarted.resolve(input.signal)
          if (input.signal.aborted) pendingCall.resolve(undefined)
          else
            input.signal.addEventListener('abort', () => pendingCall.resolve(undefined), {
              once: true
            })
          return pendingCall.promise
        }
      }
    })
    const connection = await server.issuePlanConnection('session-1', 'project-1')
    const bindings = (
      server as unknown as {
        sessionRpcCapabilities: Map<string, unknown>
      }
    ).sessionRpcCapabilities
    const getBinding = bindings.get.bind(bindings)
    let request: Promise<Response> | undefined
    let close: Promise<void> | undefined
    vi.spyOn(bindings, 'get').mockImplementation((token) => {
      const binding = getBinding(token)
      if (token === connection.token && !close) close = server.close()
      return binding
    })

    try {
      request = fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'planCall',
            params: { operation: 'generate', input: { schema_version: 1 } }
          })
        },
        'Notebook Plan capability RPC'
      )
      const signal = await callStarted.promise
      expect(signal.aborted).toBe(true)
      await expect(request).resolves.toMatchObject({ status: 200 })
      await expect(close).resolves.toBeUndefined()
    } finally {
      pendingCall.resolve(undefined)
      await Promise.allSettled([request ?? Promise.resolve(), close ?? Promise.resolve()])
      connection.release?.()
      await server.close()
    }
  })

  it('destroys a partial Plan body before waiting for graceful shutdown', async () => {
    const root = await createStorageRoot()
    const call = vi.fn(async () => undefined)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      planService: { call }
    })
    const connection = await server.issuePlanConnection('session-1', 'project-1')
    const underlying = (server as unknown as { server?: Server }).server
    if (!underlying) throw new Error('Expected the local RPC server to be listening.')
    const payload = JSON.stringify({
      method: 'planCall',
      params: { operation: 'generate', input: { schema_version: 1 } }
    })
    const accepted = once(underlying, 'request')
    let request!: ClientRequest
    const outcome = new Promise<number | Error>((resolve) => {
      request = httpRequest(
        connection.endpoint,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload)
          }
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 500)
        }
      )
      request.once('error', resolve)
    })
    let close: Promise<void> | undefined

    try {
      request.write(payload.slice(0, -1))
      await accepted
      close = server.close()
      const closeSettled = vi.fn()
      void close.then(closeSettled)
      await vi.waitFor(() => expect(closeSettled).toHaveBeenCalledTimes(1))
      await expect(outcome).resolves.toBeInstanceOf(Error)
      expect(call).not.toHaveBeenCalled()
    } finally {
      request.destroy()
      await Promise.allSettled([outcome, close ?? Promise.resolve()])
      connection.release?.()
      await server.close()
    }
  })

  it('waits for the current server to close before restarting the same instance', async () => {
    const root = await createStorageRoot()
    const callStarted = createDeferred<AbortSignal>()
    const pendingCall = createDeferred<unknown>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      planService: {
        call: async (input) => {
          callStarted.resolve(input.signal)
          return pendingCall.promise
        }
      }
    })
    const connection = await server.issuePlanConnection('session-1', 'project-1')
    let request: Promise<Response> | undefined
    let close: Promise<void> | undefined
    let restart: ReturnType<typeof server.ensureStarted> | undefined

    try {
      request = fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'planCall',
            params: { operation: 'generate', input: { schema_version: 1 } }
          })
        },
        'Notebook Plan capability RPC'
      )
      await callStarted.promise
      close = server.close()
      restart = server.ensureStarted()
      expect((server as unknown as { server?: Server }).server).toBeUndefined()

      pendingCall.resolve(undefined)
      await expect(request).resolves.toMatchObject({ status: 200 })
      await expect(close).resolves.toBeUndefined()
      await expect(restart).resolves.toEqual(
        expect.objectContaining({ endpoint: expect.any(String) })
      )
    } finally {
      pendingCall.resolve(undefined)
      await Promise.allSettled([
        request ?? Promise.resolve(),
        close ?? Promise.resolve(),
        restart ?? Promise.resolve()
      ])
      connection.release?.()
      await server.close()
    }
  })

  it('allows an identified non-Plan RPC to finish during graceful shutdown', async () => {
    const root = await createStorageRoot()
    const callStarted = createDeferred<void>()
    const pendingCall = createDeferred<unknown>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      connectorService: {
        call: async () => {
          callStarted.resolve()
          return pendingCall.promise
        }
      }
    })
    const connection = await server.issueControlConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )
    let request: Promise<Response> | undefined
    let close: Promise<void> | undefined

    try {
      request = fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'mcpCall',
            params: { server: 'test', method: 'wait', args: {} }
          })
        },
        'Notebook control capability RPC'
      )
      await callStarted.promise
      close = server.close()
      pendingCall.resolve({ completed: true })

      const response = await request
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ result: { completed: true } })
      await expect(close).resolves.toBeUndefined()
    } finally {
      pendingCall.resolve(undefined)
      await Promise.allSettled([request ?? Promise.resolve(), close ?? Promise.resolve()])
      connection.release()
      await server.close()
    }
  })

  it.each(['tcp', 'pipe'] as const)(
    'force-closes an unresolved non-Plan RPC after the graceful drain window over %s',
    async (transport) => {
      const root = await createStorageRoot()
      const callStarted = createDeferred<void>()
      const pendingCall = createDeferred<unknown>()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root)
      })
      const server = new NotebookLocalRpcServer(service, {
        transport,
        connectorService: {
          call: async () => {
            callStarted.resolve()
            return pendingCall.promise
          }
        }
      })
      const connection = await server.issueControlConnection(
        'session-1',
        'project-1',
        'root-frame-session-1'
      )
      let request: Promise<Response> | undefined
      let close: Promise<void> | undefined

      try {
        request = fetchLocalRpc(
          connection,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${connection.token}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              method: 'mcpCall',
              params: { server: 'test', method: 'wait', args: {} }
            })
          },
          'Notebook control capability RPC'
        )
        const requestOutcome = request.then(
          (response) => ({ status: 'resolved' as const, response }),
          (error: unknown) => ({ status: 'rejected' as const, error })
        )
        await callStarted.promise
        close = server.close()
        const closeSettled = vi.fn()
        void close.then(closeSettled)

        await vi.waitFor(() => expect(closeSettled).toHaveBeenCalledTimes(1), {
          timeout: 250,
          interval: 10
        })
        await expect(requestOutcome).resolves.toMatchObject({
          status: 'rejected',
          error: { cause: expect.any(Error) }
        })
      } finally {
        pendingCall.resolve(undefined)
        await Promise.allSettled([request ?? Promise.resolve(), close ?? Promise.resolve()])
        connection.release()
        await server.close()
      }
    }
  )

  it.each(['tcp', 'pipe'] as const)(
    'force-closes a partial-header socket after the graceful drain window over %s',
    async (transport) => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root)
      })
      const server = new NotebookLocalRpcServer(service, { transport })
      const connection = await server.ensureStarted()
      const underlying = (server as unknown as { server?: Server }).server
      if (!underlying) throw new Error('Expected the local RPC server to be listening.')
      const accepted = once(underlying, 'connection')
      let socket: Socket | undefined
      let close: Promise<void> | undefined

      try {
        if (transport === 'pipe') {
          if (!connection.socketPath) throw new Error('Expected a local RPC socket path.')
          socket = createConnection(connection.socketPath)
        } else {
          const endpoint = new URL(connection.endpoint)
          socket = createConnection({
            host: endpoint.hostname,
            port: Number(endpoint.port)
          })
        }
        const socketClosed = new Promise<void>((resolve) => {
          socket?.once('error', () => undefined)
          socket?.once('close', () => resolve())
        })
        await Promise.all([once(socket, 'connect'), accepted])
        socket.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n')

        close = server.close()
        const closeSettled = vi.fn()
        void close.then(closeSettled)

        await vi.waitFor(() => expect(closeSettled).toHaveBeenCalledTimes(1), {
          timeout: 250,
          interval: 10
        })
        await expect(socketClosed).resolves.toBeUndefined()
      } finally {
        socket?.destroy()
        await close?.catch(() => undefined)
        await server.close()
      }
    }
  )

  it('preserves structured Plan error codes across the session-bound RPC transport', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      token: 'master-token',
      planService: {
        call: async () => {
          throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
        }
      }
    })
    const connection = await server.issuePlanConnection('session-1', 'project-1')

    try {
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'planCall',
            params: { operation: 'updateStepStatus', input: { title: 'Old step' } }
          })
        },
        'Notebook Plan capability RPC'
      )

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        error: { code: 'stale-plan', message: 'A newer Plan is active.' }
      })
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('propagates a local socket through every issued capability connection', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, { transport: 'pipe' })
    const session = await server.issueSessionConnection(
      'session-1',
      'default-project',
      'root-frame-session-1'
    )
    const skillImport = await server.issueSkillImportConnection('session-1')
    const control = await server.issueControlConnection(
      'session-1',
      'default-project',
      'root-frame-session-1'
    )

    try {
      expect(session.socketPath).toBeTruthy()
      expect(skillImport.socketPath).toBe(session.socketPath)
      expect(control.socketPath).toBe(session.socketPath)

      const response = await fetchLocalRpc(
        session,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'state',
            params: { sessionId: 'session-1', workspaceCwd: root }
          })
        },
        'Notebook capability test RPC'
      )
      expect(response.status).toBe(200)
    } finally {
      control.release()
      await server.close()
    }
  })

  it('requires a bearer token and dispatches notebook execute calls', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      helperModuleCatalog: {
        resolve: async (id) => ({
          id,
          language: 'python',
          source: 'def public_add(value):\n    return value + 1',
          sourceDigest: helperDigest('def public_add(value):\n    return value + 1'),
          exports: ['public_add'],
          skillIdentity: 'skill:rpc-helper',
          packageOrigin: 'personal',
          interfaceRevision: '1',
          registeredGeneration: 'generation-1'
        })
      },
      executorFactory: () => ({
        execute: async (request) => {
          executions.push(request)
          return {
            status: 'completed' as const,
            stdout: '2\n',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [],
            workingFiles: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    const resolveSpecialistSkillIds = vi.fn(async () => ['registered-test-skill'])
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      resolveSpecialistSkillIds
    })
    server.registerSessionSpecialist('session-1', 'specialist-1')
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
            projectId: 'default-project',
            sessionId: 'session-1',
            workspaceCwd: '/workspace',
            code: 'print(1 + 1)',
            kernelSkillIds: ['registered-test-helper']
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
      expect(executions[0]).toMatchObject({
        code: 'print(1 + 1)',
        helperModules: [{ id: 'registered-test-helper', exports: ['public_add'] }]
      })
      expect(resolveSpecialistSkillIds).toHaveBeenCalledWith('specialist-1')
    } finally {
      await server.close()
    }
  })

  it('dispatches read-only package inspection calls to the runtime service', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const interpreter = pythonBin(envPrefix(runtimeRoot, DEFAULT_PY_ENV))
    await mkdir(dirname(interpreter), { recursive: true })
    await writeFile(interpreter, '', 'utf8')
    writeReadyMarker(runtimeRoot, DEFAULT_ENV_VERSION, 'ready')
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: {
        prepareRun: vi.fn(),
        captureCompletedRun: vi.fn(),
        inspectPackages: vi.fn().mockResolvedValue({
          inventory: { source: 'full-scan', validation: 'full-scan' },
          packages: [
            {
              requested: 'numpy',
              name: 'numpy',
              status: 'installed',
              version: '2.2.0',
              versionStatus: 'known'
            }
          ]
        }),
        markPackageMutationDirty: vi.fn(),
        refreshAfterPackageMutation: vi.fn()
      }
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token'
    })
    const connection = await server.ensureStarted()

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'inspectPackages',
          params: {
            projectId: 'default-project',
            sessionId: 'session-1',
            workspaceCwd: root,
            language: 'python',
            packages: ['numpy']
          }
        })
      })
      const payload = (await response.json()) as {
        result: { packages: Array<{ name: string; status: string; version?: string }> }
      }

      expect(response.status).toBe(200)
      expect(payload.result.packages).toEqual([
        expect.objectContaining({ name: 'numpy', status: 'installed', version: '2.2.0' })
      ])
    } finally {
      await server.close()
    }
  })

  it('maps pre-start notebook session aliases to the final ACP session id', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
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
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token'
    })
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
            projectId: 'default-project',
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

  it('revokes session RPC capabilities and removes aliases when their session is released', async () => {
    const root = await createStorageRoot()
    const connectorCall = vi.fn(async () => ({ ok: true }))
    const onSessionReleased = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      onSessionReleased,
      connectorService: { call: connectorCall }
    })
    const connection = await server.issueSessionConnection(
      'notebook-session-1',
      'default-project',
      'root-frame-notebook-session-1'
    )
    server.registerSessionAlias('notebook-session-1', 'real-session-1')

    try {
      server.releaseSessionCapabilities('real-session-1')

      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'mcpCall',
          params: { server: 'pubmed', method: 'search', args: {} }
        })
      })
      const payload = (await response.json()) as { error: string }

      expect(response.status).toBe(401)
      expect(payload.error).toMatch(/invalid notebook rpc token/i)
      expect(connectorCall).not.toHaveBeenCalled()
      expect(onSessionReleased).toHaveBeenCalledWith('real-session-1')
      expect(
        (
          server as unknown as {
            sessionAliases: Map<string, string>
          }
        ).sessionAliases.has('notebook-session-1')
      ).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('rotates Agent capabilities across a pre-start alias without revoking the control plane', async () => {
    const root = await createStorageRoot()
    const connectorCall = vi.fn(async () => ({ ok: true }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      connectorService: { call: connectorCall }
    })
    const initial = await server.issueSessionConnection(
      'notebook-session-1',
      'default-project',
      'root-frame-notebook-session-1'
    )
    server.registerSessionAlias('notebook-session-1', 'real-session-1')
    const control = await server.issueControlConnection(
      'real-session-1',
      'default-project',
      'root-frame-real-session-1'
    )
    const replacement = await server.issueSessionConnection(
      'real-session-1',
      'default-project',
      'root-frame-real-session-1'
    )

    const callConnector = (token: string): Promise<Response> =>
      fetch(replacement.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'mcpCall',
          params: { server: 'pubmed', method: 'search', args: {} }
        })
      })

    try {
      await expect(callConnector(initial.token)).resolves.toMatchObject({ status: 401 })
      await expect(callConnector(replacement.token)).resolves.toMatchObject({ status: 200 })
      await expect(callConnector(control.token)).resolves.toMatchObject({ status: 200 })
      expect(connectorCall).toHaveBeenCalledTimes(2)
    } finally {
      control.release()
      await server.close()
    }
  })

  it('adopts a pre-start alias for the persistent root control capability', async () => {
    const root = await createStorageRoot()
    const agentsRead = vi.fn(async () => ({ ok: true }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      agentsService: { read: agentsRead }
    })
    const control = await server.issueControlConnection(
      'notebook-session-1',
      'default-project',
      'root-frame-notebook-session-1'
    )

    server.registerSessionAlias('notebook-session-1', 'real-session-1')
    server.setArtifactTurnBinding('real-session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'default-project',
      provenanceContext: {
        rootFrameId: 'root-frame-real-session-1',
        agentFrameId: 'root-frame-real-session-1',
        messageBranchId: 'message-branch-real-session-1',
        runtimeSegmentId: 'runtime-segment-real-session-1',
        promptMessageId: 'prompt-1'
      }
    })

    try {
      const response = await fetch(control.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'agentsCall', params: { op: 'list' } })
      })

      expect(response.status).toBe(200)
      expect(agentsRead).toHaveBeenCalledWith(
        { op: 'list', params: {} },
        expect.objectContaining({
          sessionId: 'real-session-1'
        })
      )
    } finally {
      control.release()
      await server.close()
    }
  })

  it('canonicalizes a persistent root control capability issued after alias adoption', async () => {
    const root = await createStorageRoot()
    const agentsRead = vi.fn(async () => ({ ok: true }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      agentsService: { read: agentsRead }
    })

    server.registerSessionAlias('notebook-session-1', 'real-session-1')
    const control = await server.issueControlConnection(
      'notebook-session-1',
      'default-project',
      'root-frame-notebook-session-1'
    )
    server.setArtifactTurnBinding('real-session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'default-project',
      provenanceContext: {
        rootFrameId: 'root-frame-real-session-1',
        agentFrameId: 'root-frame-real-session-1',
        messageBranchId: 'message-branch-real-session-1',
        runtimeSegmentId: 'runtime-segment-real-session-1',
        promptMessageId: 'prompt-1'
      }
    })

    try {
      const response = await fetch(control.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'agentsCall', params: { op: 'list' } })
      })

      expect(response.status).toBe(200)
      expect(agentsRead).toHaveBeenCalledWith(
        { op: 'list', params: {} },
        expect.objectContaining({ sessionId: 'real-session-1' })
      )
    } finally {
      control.release()
      await server.close()
    }
  })

  it('does not adopt a stale or misscoped root capability through a Session alias', async () => {
    const root = await createStorageRoot()
    const agentsRead = vi.fn(async () => ({ ok: true }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      agentsService: { read: agentsRead }
    })
    const stale = await server.issueSessionConnection(
      'notebook-session-1',
      'default-project',
      'root-frame-stale-session'
    )
    server.registerSessionAlias('notebook-session-1', 'real-session-1')
    server.setArtifactTurnBinding('real-session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'default-project',
      provenanceContext: {
        rootFrameId: 'durable-root-frame',
        agentFrameId: 'durable-root-frame',
        messageBranchId: 'message-branch-real-session-1',
        runtimeSegmentId: 'runtime-segment-real-session-1',
        promptMessageId: 'prompt-1'
      }
    })

    try {
      const response = await fetch(stale.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${stale.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'state',
          params: { sessionId: 'notebook-session-1', workspaceCwd: root }
        })
      })

      expect(response.status).toBe(403)
      expect(agentsRead).not.toHaveBeenCalled()
    } finally {
      stale.release?.()
      await server.close()
    }
  })

  it('allows agentsCall through a session-bound control capability and derives its trusted context', async () => {
    const root = await createStorageRoot()
    const agentsRead = vi.fn(async () => ({ status: 'approved' }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      agentsService: { read: agentsRead },
      inputRegistry: {
        registerTurn: vi.fn(async () => []),
        getTurnInputs: vi.fn(() => [
          {
            inputFileVersionId: 'upload-version-1',
            sourceKind: 'upload-version' as const,
            sourceFileId: 'upload-1',
            sourceProjectId: 'default-project',
            sourceSessionId: 'trusted-session',
            filename: 'sample.csv',
            sizeBytes: 10,
            checksum: 'upload-checksum',
            storageKey: 'upload-key',
            association: 'turn-attached' as const
          },
          {
            inputFileVersionId: 'artifact-version-1',
            sourceKind: 'artifact-version' as const,
            sourceFileId: 'artifact-1',
            sourceProjectId: 'default-project',
            sourceSessionId: 'trusted-session',
            filename: 'prior.csv',
            sizeBytes: 20,
            checksum: 'artifact-checksum',
            storageKey: 'artifact-key',
            association: 'turn-attached' as const
          }
        ]),
        clearSession: vi.fn()
      }
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    server.setArtifactTurnBinding('trusted-session', {
      ownerExecutionId: 'execution-1',
      projectId: 'default-project',
      provenanceContext: {
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1'
      }
    })
    await server.registerNotebookTurnInputs({
      projectId: 'default-project',
      appSessionId: 'trusted-session',
      promptMessageId: 'prompt-1',
      uploads: [],
      references: []
    })
    const releaseInvocation = control.beginControlInvocation({
      turnId: 'trusted-turn-1',
      controlInvocationGeneration: 7,
      toolInvocationId: 'trusted-tool-1'
    })

    try {
      const response = await fetch(control.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.token}`,
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
            name: 'Approved Specialist'
          }
        })
      })

      expect(response.status).toBe(200)
      expect(agentsRead).toHaveBeenCalledWith(
        { op: 'switch', params: { name: 'Approved Specialist' } },
        {
          sessionId: 'trusted-session',
          callerRole: 'main',
          turnId: 'trusted-turn-1',
          controlInvocationGeneration: 7,
          toolInvocationId: 'trusted-tool-1',
          originatingTurnId: 'prompt-1',
          originatingUserMessageId: 'prompt-1',
          attachmentIds: ['upload-1'],
          artifactIds: ['artifact-1']
        }
      )
    } finally {
      releaseInvocation()
      control.release()
      await server.close()
    }
  })

  it('closes a captured control completion transport without serializing a legacy tool result', async () => {
    const server = new NotebookLocalRpcServer(
      {
        executeControl: async () => {
          throw new NotebookControlCompletionCapturedError()
        }
      } as unknown as NotebookRuntimeService,
      { transport: 'tcp', token: 'secret-token' }
    )
    const connection = await server.ensureStarted()

    try {
      await expect(
        fetch(connection.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'executeControl',
            params: { sessionId: 'session-1', workspaceCwd: '/workspace', code: 'return 1' }
          })
        })
      ).rejects.toThrow()
    } finally {
      await server.close()
    }
  })

  it('does not revoke a replacement capability when the prior connection releases late', async () => {
    const root = await createStorageRoot()
    const connectorCall = vi.fn(async () => ({ ok: true }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      connectorService: { call: connectorCall }
    })
    const prior = await server.issueSessionConnection(
      'stable-session',
      'default-project',
      'root-frame-stable-session'
    )
    const replacement = await server.issueSessionConnection(
      'stable-session',
      'default-project',
      'root-frame-stable-session'
    )

    try {
      expect(prior.release).toBeTypeOf('function')
      prior.release?.()

      const response = await fetch(replacement.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${replacement.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'mcpCall',
          params: { server: 'pubmed', method: 'search', args: {} }
        })
      })

      expect(response.status).toBe(200)
      expect(connectorCall).toHaveBeenCalledOnce()
    } finally {
      await server.close()
    }
  })

  it('dispatches Artifact Version creation through the authenticated main-process bridge', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const requests: unknown[] = []
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      artifactProvenance: {
        createVersion: async (request) => {
          requests.push(request)
          return {
            id: 'version-1',
            artifactId: 'artifact-1',
            versionId: 'version-1',
            versionNumber: 1,
            checksum: 'a'.repeat(64),
            createdAt: '2026-07-27T00:00:00.000Z',
            projectId: 'project-1',
            sessionId: 'session-1',
            runId: 'artifact-run-1',
            name: 'sin.png',
            path: '/managed/content',
            fileUrl: 'file:///managed/content',
            mimeType: 'image/png',
            size: 12,
            mtimeMs: 1
          }
        }
      }
    })
    const connection = await server.ensureStarted()
    const artifactToken = server.issueArtifactRunCapability(artifactCapabilityBinding)
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'b'.repeat(64),
      resourceReservationId: 'reservation-1',
      resourceSizeBytes: 12,
      resourceChecksum: 'a'.repeat(64),
      rootFrameId: 'frame-root',
      agentFrameId: 'frame-root',
      messageBranchId: 'branch-root',
      messageBranchAncestry: ['forged-branch'],
      messageAncestry: ['forged-message'],
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'message-user-1',
      agentName: 'forged-agent',
      notebookSessionId: 'forged-notebook-session',
      filename: 'sin.png',
      contentType: 'image/png'
    }

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${artifactToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'artifactCreateVersion', params: request })
      })
      const payload = (await response.json()) as {
        result: { artifactId: string; versionId: string }
      }

      expect(response.status).toBe(200)
      expect(payload.result).toMatchObject({ artifactId: 'artifact-1', versionId: 'version-1' })
      expect(requests).toEqual([
        {
          ...request,
          messageBranchAncestry: ['branch-parent', 'branch-root'],
          messageAncestry: ['message-parent', 'message-user-1'],
          agentName: 'Claude Code',
          notebookSessionId: 'notebook-session-1'
        }
      ])
    } finally {
      await server.close()
    }
  })

  it('binds Artifact reservations to the capability and releases ownership on revoke and close', async () => {
    const reserveWrite = vi.fn(async () => ({
      id: 'reservation-1',
      fileBytes: 12,
      expiresAt: Date.now() + 60_000
    }))
    const releaseWriteReservation = vi.fn(async () => undefined)
    const releaseRunWriteReservations = vi.fn(async () => undefined)
    const releaseAllWriteReservations = vi.fn(async () => undefined)
    const createVersion = vi.fn()
    const server = new NotebookLocalRpcServer({} as never, {
      transport: 'tcp',
      token: 'secret-token',
      artifactProvenance: {
        createVersion,
        reserveWrite,
        releaseWriteReservation,
        releaseRunWriteReservations,
        releaseAllWriteReservations
      }
    })
    const connection = await server.ensureStarted()
    const token = server.issueArtifactRunCapability(artifactCapabilityBinding)
    let closed = false
    const call = (method: string, params: Record<string, unknown>): Promise<Response> =>
      fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method, params })
      })

    try {
      const reserved = await call('artifactReserveWrite', {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-1',
        filename: 'sin.png',
        fileBytes: 12
      })
      await expect(reserved.json()).resolves.toEqual({
        result: expect.objectContaining({ id: 'reservation-1', fileBytes: 12 })
      })
      expect(reserveWrite).toHaveBeenCalledWith({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-1',
        filename: 'sin.png',
        fileBytes: 12
      })

      const released = await call('artifactReleaseWrite', {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        reservationId: 'reservation-1'
      })
      expect(released.status).toBe(200)
      expect(releaseWriteReservation).toHaveBeenCalledWith({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        reservationId: 'reservation-1'
      })

      const bypass = await call('artifactCreateVersion', {
        ...artifactCapabilityBinding,
        writeOperationId: 'write-without-reservation',
        writeRequestChecksum: 'a'.repeat(64),
        filename: 'bypass.txt'
      })
      expect(bypass.status).toBe(400)
      await expect(bypass.json()).resolves.toEqual({
        error: 'Artifact Version creation requires a write reservation.'
      })
      expect(createVersion).not.toHaveBeenCalled()

      await server.revokeArtifactRunCapability(token)
      expect(releaseRunWriteReservations).toHaveBeenCalledWith({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1'
      })
      await server.close()
      closed = true
      expect(releaseAllWriteReservations).toHaveBeenCalledOnce()
    } finally {
      if (!closed) await server.close()
    }
  })

  it('revokes new Artifact requests while draining one already-authorized write', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const createStarted = createDeferred()
    const releaseCreate = createDeferred()
    let now = 1_000
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      now: () => now,
      artifactProvenance: {
        createVersion: async () => {
          createStarted.resolve()
          await releaseCreate.promise
          return {
            id: 'version-1',
            artifactId: 'artifact-1',
            versionId: 'version-1',
            versionNumber: 1,
            checksum: 'a'.repeat(64),
            createdAt: '2026-07-27T00:00:00.000Z',
            projectId: 'project-1',
            sessionId: 'session-1',
            runId: 'artifact-run-1',
            name: 'sin.png',
            path: '/managed/content',
            fileUrl: 'file:///managed/content',
            mimeType: 'image/png',
            size: 12,
            mtimeMs: 1
          }
        }
      }
    })
    const connection = await server.ensureStarted()
    const token = server.issueArtifactRunCapability(artifactCapabilityBinding, 100)
    const call = (): Promise<Response> =>
      fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'artifactCreateVersion',
          params: {
            ...artifactCapabilityBinding,
            writeOperationId: 'write-drain',
            writeRequestChecksum: 'a'.repeat(64),
            resourceReservationId: 'reservation-drain',
            resourceSizeBytes: 12,
            resourceChecksum: 'a'.repeat(64),
            filename: 'sin.png'
          }
        })
      })

    try {
      const acceptedRequest = call()
      await createStarted.promise
      now = 1_101
      const expiredRequest = await call()
      expect(expiredRequest.status).toBe(401)
      await expect(expiredRequest.json()).resolves.toEqual({
        error: 'Artifact RPC capability expired.'
      })

      let drained = false
      const firstDrain = Promise.resolve(server.revokeArtifactRunCapability(token)).then(() => {
        drained = true
      })
      const repeatedDrain = Promise.resolve(server.revokeArtifactRunCapability(token))
      await Promise.resolve()
      expect(drained).toBe(false)

      const rejectedRequest = await call()
      expect(rejectedRequest.status).toBe(401)

      releaseCreate.resolve()
      await expect(acceptedRequest.then((response) => response.status)).resolves.toBe(200)
      await expect(Promise.all([firstDrain, repeatedDrain])).resolves.toEqual([
        undefined,
        undefined
      ])
      expect(drained).toBe(true)
    } finally {
      releaseCreate.resolve()
      await server.close()
    }
  })

  it('rejects an Artifact capability when the request names a different run', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const createVersion = vi.fn()
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      artifactProvenance: { createVersion }
    })
    const connection = await server.ensureStarted()
    const artifactToken = server.issueArtifactRunCapability(artifactCapabilityBinding)

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${artifactToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'artifactCreateVersion',
          params: {
            ...artifactCapabilityBinding,
            artifactRunId: 'artifact-run-forged',
            writeOperationId: 'write-forged',
            writeRequestChecksum: 'a'.repeat(64),
            filename: 'sin.png'
          }
        })
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: 'Artifact RPC capability does not match artifactRunId.'
      })
      expect(createVersion).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('rejects expired and revoked Artifact run capabilities', async () => {
    const root = await createStorageRoot()
    let now = 1_000
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const createVersion = vi.fn()
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      now: () => now,
      artifactProvenance: { createVersion }
    })
    const connection = await server.ensureStarted()
    const expiredToken = server.issueArtifactRunCapability(artifactCapabilityBinding, 100)
    now = 1_101

    const call = (token: string): Promise<Response> =>
      fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'artifactCreateVersion',
          params: {
            ...artifactCapabilityBinding,
            writeOperationId: 'write-1',
            writeRequestChecksum: 'a'.repeat(64),
            filename: 'sin.png'
          }
        })
      })

    try {
      const expired = await call(expiredToken)
      expect(expired.status).toBe(401)
      await expect(expired.json()).resolves.toEqual({ error: 'Artifact RPC capability expired.' })

      const replayOnlyToken = server.issueArtifactRunCapability({
        ...artifactCapabilityBinding,
        allowedMethods: ['artifactReplayVersion']
      })
      const disallowed = await call(replayOnlyToken)
      expect(disallowed.status).toBe(403)
      await expect(disallowed.json()).resolves.toEqual({
        error: 'Artifact RPC capability does not allow artifactCreateVersion.'
      })

      const revokedToken = server.issueArtifactRunCapability(artifactCapabilityBinding)
      server.revokeArtifactRunCapability(revokedToken)
      const revoked = await call(revokedToken)
      expect(revoked.status).toBe(401)
      await expect(revoked.json()).resolves.toEqual({ error: 'Invalid notebook RPC token.' })
      expect(createVersion).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('keeps the default Artifact capability valid throughout a long-running turn', async () => {
    const root = await createStorageRoot()
    let now = 1_000
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const createVersion = vi.fn().mockResolvedValue({ versionId: 'version-1' })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      now: () => now,
      artifactProvenance: { createVersion }
    })
    const connection = await server.ensureStarted()
    const token = server.issueArtifactRunCapability(artifactCapabilityBinding)
    now += 31 * 60 * 1_000

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'artifactCreateVersion',
          params: {
            ...artifactCapabilityBinding,
            writeOperationId: 'write-long-turn',
            writeRequestChecksum: 'a'.repeat(64),
            resourceReservationId: 'reservation-long-turn',
            resourceSizeBytes: 12,
            resourceChecksum: 'a'.repeat(64),
            filename: 'sin.png'
          }
        })
      })

      expect(response.status).toBe(200)
      expect(createVersion).toHaveBeenCalledOnce()
    } finally {
      await server.close()
    }
  })

  it('dispatches exact Artifact Version replays and reports an unconfigured replay bridge', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const replayRequests: unknown[] = []
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'b'.repeat(64),
      rootFrameId: 'frame-root',
      agentFrameId: 'frame-root',
      messageBranchId: 'branch-root',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'message-user-1'
    }
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      artifactProvenance: {
        createVersion: vi.fn(),
        replayVersion: async (replayRequest) => {
          replayRequests.push(replayRequest)
          return undefined
        }
      }
    })
    const connection = await server.ensureStarted()
    const replayToken = server.issueArtifactRunCapability(artifactCapabilityBinding)

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${replayToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'artifactReplayVersion', params: request })
      })
      await expect(response.json()).resolves.toEqual({})
      expect(response.status).toBe(200)
      expect(replayRequests).toEqual([request])
    } finally {
      await server.close()
    }

    const unconfigured = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      artifactProvenance: { createVersion: vi.fn() }
    })
    const unconfiguredConnection = await unconfigured.ensureStarted()
    const unconfiguredToken = unconfigured.issueArtifactRunCapability(artifactCapabilityBinding)
    try {
      const response = await fetch(unconfiguredConnection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${unconfiguredToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'artifactReplayVersion', params: request })
      })
      await expect(response.json()).resolves.toEqual({
        error: 'Artifact Provenance persistence is not configured.'
      })
      expect(response.status).toBe(500)
    } finally {
      await unconfigured.close()
    }
  })

  it('binds notebook runs to the trusted active Artifact conversation context', async () => {
    const root = await createStorageRoot()
    let rpcEndpoint = ''
    let rpcToken = ''
    const leasedInput: NotebookRunInputFile = { ...registeredInput }
    const workflowArtifact: NotebookRunInputFile = {
      inputFileVersionId: 'panel-a-v1',
      sourceKind: 'artifact-version',
      sourceFileId: 'panel-a',
      sourceVersionNumber: 1,
      sourceProjectId: 'default-project',
      sourceSessionId: 'panel-worker-1',
      filename: 'panel_A.png',
      contentType: 'image/png',
      sizeBytes: 20,
      checksum: 'b'.repeat(64),
      storageKey: 'artifacts/default-project/panel-worker-1/panel-a-v1/content',
      association: 'turn-attached'
    }
    const openRun = vi.fn(
      async () =>
        ({
          getRunInputFiles: () => [leasedInput, workflowArtifact],
          resolve: async () => {
            leasedInput.association = 'resolver-accessed'
            return '/managed/groups.csv'
          },
          close: () => [{ ...leasedInput }, { ...workflowArtifact }]
        }) as never
    )
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request) => {
          const resolved = await fetch(rpcEndpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${rpcToken}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              method: 'resolveNotebookInput',
              params: {
                sessionId: 'session-1',
                inputRunLeaseId: request.inputRunLeaseId,
                sourceKind: 'upload-version',
                inputFileVersionId: 'upload-version-1'
              }
            })
          })
          expect(resolved.status).toBe(200)
          await expect(resolved.json()).resolves.toEqual({
            result: { path: '/managed/groups.csv' }
          })
          return {
            status: 'completed',
            stdout: 'ok\n',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [],
            workingFiles: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      inputRegistry: {
        registerTurn: async () => [],
        getTurnInputs: () => [registeredInput],
        openRun,
        clearSession: () => undefined
      }
    })
    const connection = await server.ensureStarted()
    rpcEndpoint = connection.endpoint
    rpcToken = connection.token
    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'default-project',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'message-user-1'
      }
    })
    await server.registerNotebookTurnInputs({
      projectId: 'default-project',
      appSessionId: 'session-1',
      promptMessageId: 'message-user-1',
      uploads: [],
      references: []
    })

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
            projectId: 'default-project',
            sessionId: 'session-1',
            workspaceCwd: '/workspace',
            code: 'print("ok")',
            artifactVersionInputs: ['panel-a-v1']
          }
        })
      })

      expect(response.status).toBe(200)
      const document = JSON.parse(
        await readFile(join(root, 'notebooks', 'default-project', 'session-1', 'run.json'), 'utf8')
      ) as { runs: Array<Record<string, unknown>> }
      expect(document.runs[0]).toMatchObject({
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'message-user-1',
        inputFiles: [{ ...registeredInput, association: 'resolver-accessed' }, workflowArtifact]
      })
      expect(openRun).toHaveBeenCalledWith({
        projectId: 'default-project',
        appSessionId: 'session-1',
        promptMessageId: 'message-user-1',
        artifactVersionInputs: ['panel-a-v1']
      })
      const payload = (await response.json()) as {
        result: { inputFiles: Array<Record<string, unknown>> }
      }
      expect(payload.result.inputFiles).toEqual([
        expect.objectContaining({ inputFileVersionId: 'upload-version-1' }),
        expect.objectContaining({ inputFileVersionId: 'panel-a-v1' })
      ])
      expect(payload.result.inputFiles[0]).not.toHaveProperty('storageKey')
    } finally {
      await server.close()
    }
  })

  it('opens workflow Artifact Version inputs from an attachment-free active root turn', async () => {
    const registerTurn = vi.fn()
    const openRun = vi.fn(
      async () =>
        ({
          getRunInputFiles: () => [],
          resolve: vi.fn(),
          close: vi.fn()
        }) as never
    )
    const execute = vi.fn(async (request: unknown) => request)
    const server = new NotebookLocalRpcServer({ execute } as never, {
      transport: 'tcp',
      inputRegistry: {
        registerTurn,
        getTurnInputs: () => [],
        openRun,
        clearSession: vi.fn()
      }
    })
    const connection = await server.issueSessionConnection('session-1', 'project-1', 'root-frame-1')
    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'project-1',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'message-user-1'
      }
    })

    try {
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: {
              sessionId: 'session-1',
              workspaceCwd: '/workspace',
              code: 'print("ok")',
              artifactVersionInputs: ['panel-a-v1']
            }
          })
        },
        'attachment-free Artifact Version input test'
      )

      expect(response.status).toBe(200)
      expect(openRun).toHaveBeenCalledWith({
        projectId: 'project-1',
        appSessionId: 'session-1',
        promptMessageId: 'message-user-1',
        artifactVersionInputs: ['panel-a-v1']
      })
      expect(registerTurn).not.toHaveBeenCalled()
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('carries the root Artifact owner Project binding into the public notebook RPC seam', async () => {
    const root = await createStorageRoot()
    const openRun = vi.fn(
      async () => ({ getRunInputFiles: () => [], resolve: vi.fn(), close: vi.fn() }) as never
    )
    const server = new NotebookLocalRpcServer(
      { execute: vi.fn(async (request: unknown) => request) } as never,
      {
        transport: 'tcp',
        inputRegistry: {
          registerTurn: vi.fn(),
          getTurnInputs: () => [],
          openRun,
          clearSession: vi.fn()
        }
      }
    )
    const owner = new ArtifactTurnOwner({
      dataRoot: root,
      repository: new ArtifactRepository(root),
      runRegistry: new ArtifactRunRegistry(),
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(root),
      notebook: {
        setArtifactTurnBinding: (sessionId, binding) =>
          server.setArtifactTurnBinding(sessionId, binding),
        clearArtifactTurnBinding: (sessionId, ownerExecutionId) =>
          server.clearArtifactTurnBinding(sessionId, ownerExecutionId)
      }
    })
    const turn = await owner.openRootExecution({
      executionId: 'execution-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-from-root-owner',
      agentName: 'Codex',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1'
      }
    })
    const connection = await server.issueSessionConnection(
      'session-1',
      'project-from-root-owner',
      'root-frame-1'
    )

    try {
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: {
              sessionId: 'session-1',
              workspaceCwd: '/workspace',
              code: 'print("ok")',
              artifactVersionInputs: ['panel-a-v1']
            }
          })
        },
        'root Artifact owner Project binding test'
      )

      expect(response.status).toBe(200)
      expect(openRun).toHaveBeenCalledWith({
        projectId: 'project-from-root-owner',
        appSessionId: 'session-1',
        promptMessageId: 'prompt-1',
        artifactVersionInputs: ['panel-a-v1']
      })
    } finally {
      connection.release?.()
      await owner.dispose(turn)
      await server.close()
    }
  })

  it('does not let stale turn cleanup erase a replacement Artifact binding', async () => {
    const openRun = vi.fn(
      async () => ({ getRunInputFiles: () => [], resolve: vi.fn(), close: vi.fn() }) as never
    )
    const server = new NotebookLocalRpcServer(
      { execute: vi.fn(async (request: unknown) => request) } as never,
      {
        transport: 'tcp',
        inputRegistry: {
          registerTurn: vi.fn(),
          getTurnInputs: () => [],
          openRun,
          clearSession: vi.fn()
        }
      }
    )
    const connection = await server.issueSessionConnection('session-1', 'project-1', 'root-frame-1')
    const provenanceContext = (promptMessageId: string): NotebookRunProvenanceContext => ({
      rootFrameId: 'root-frame-1',
      agentFrameId: 'root-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId
    })
    const execute = (): Promise<Response> =>
      fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: {
              sessionId: 'session-1',
              workspaceCwd: '/workspace',
              code: 'print("ok")',
              artifactVersionInputs: ['panel-a-v1']
            }
          })
        },
        'replacement Artifact binding test'
      )

    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'project-1',
      provenanceContext: provenanceContext('prompt-1')
    })
    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-2',
      projectId: 'project-1',
      provenanceContext: provenanceContext('prompt-2')
    })
    server.clearArtifactTurnBinding('session-1', 'execution-1')

    try {
      await expect(execute()).resolves.toMatchObject({ status: 200 })
      expect(openRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ promptMessageId: 'prompt-2' })
      )

      server.clearArtifactTurnBinding('session-1', 'execution-2')
      const cleared = await execute()
      expect(cleared.status).toBe(500)
      await expect(cleared.json()).resolves.toEqual({
        error:
          'artifactVersionInputs requires an active Artifact provenance context and input registry.'
      })
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('rejects an unavailable workflow Version before notebook code can run', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }))
    const openRun = vi.fn(async () => {
      throw new Error('Artifact Version is unavailable in this Project: cross-project-version')
    })
    const server = new NotebookLocalRpcServer({ execute } as never, {
      transport: 'tcp',
      inputRegistry: {
        registerTurn: vi.fn(),
        getTurnInputs: () => [],
        openRun,
        clearSession: vi.fn()
      }
    })
    const connection = await server.issueSessionConnection('session-1', 'project-1', 'root-frame-1')
    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'project-1',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1'
      }
    })

    try {
      const response = await fetchLocalRpc(
        connection,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: {
              sessionId: 'session-1',
              workspaceCwd: '/workspace',
              code: 'write_sentinel()',
              artifactVersionInputs: ['cross-project-version']
            }
          })
        },
        'unavailable Artifact Version input test'
      )

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        error: 'Artifact Version is unavailable in this Project: cross-project-version'
      })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      connection.release?.()
      await server.close()
    }
  })

  it('closes and revokes an input-run lease when notebook execution rejects', async () => {
    const root = await createStorageRoot()
    const failure = new Error('execution failed')
    let inputRunLeaseId: string | undefined
    const close = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    vi.spyOn(service, 'execute').mockImplementation(async (executeRequest) => {
      inputRunLeaseId = executeRequest.inputRunLeaseId
      throw failure
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      inputRegistry: {
        registerTurn: vi.fn().mockResolvedValue([]),
        getTurnInputs: () => [registeredInput],
        openRun: vi.fn().mockResolvedValue({
          getRunInputFiles: () => [registeredInput],
          resolve: vi.fn().mockResolvedValue('/managed/groups.csv'),
          close
        }),
        clearSession: vi.fn()
      }
    })
    const connection = await server.ensureStarted()
    server.setArtifactTurnBinding('session-1', {
      ownerExecutionId: 'execution-1',
      projectId: 'default-project',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'message-user-1'
      }
    })
    await server.registerNotebookTurnInputs({
      projectId: 'default-project',
      appSessionId: 'session-1',
      promptMessageId: 'message-user-1',
      uploads: [],
      references: []
    })

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
            sessionId: 'session-1',
            workspaceCwd: '/workspace',
            code: 'throw new Error()'
          }
        })
      })

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error: failure.message })
      expect(inputRunLeaseId).toEqual(expect.any(String))
      expect(close).toHaveBeenCalledTimes(1)

      const internals = server as unknown as {
        dispatch(method: string, params: Record<string, unknown>): Promise<unknown>
      }
      await expect(
        internals.dispatch('resolveNotebookInput', {
          sessionId: 'session-1',
          inputRunLeaseId,
          sourceKind: 'upload-version',
          inputFileVersionId: 'upload-version-1'
        })
      ).rejects.toThrow('Notebook input resolution requires an active run lease.')
    } finally {
      await server.close()
    }
  })

  it('resolves an immutable input only for the calling run while leases overlap', async () => {
    const root = await createStorageRoot()
    const server = new NotebookLocalRpcServer(
      new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root)
      }),
      { transport: 'tcp', token: 'secret-token' }
    )
    const firstResolve = vi.fn().mockResolvedValue('/managed/groups.csv')
    const secondResolve = vi.fn().mockResolvedValue('/managed/groups.csv')
    const createLease = (resolve: typeof firstResolve): NotebookInputRunLease =>
      ({
        getRunInputFiles: () => [{ ...registeredInput }],
        resolve,
        close: () => []
      }) as unknown as NotebookInputRunLease
    const internals = server as unknown as {
      activeInputRunLeases: Map<string, Set<NotebookInputRunLease>>
      inputRunLeaseIds: WeakMap<NotebookInputRunLease, string>
      dispatch(method: string, params: Record<string, unknown>): Promise<unknown>
    }
    const firstLease = createLease(firstResolve)
    const secondLease = createLease(secondResolve)
    internals.activeInputRunLeases.set('session-1', new Set([firstLease, secondLease]))
    internals.inputRunLeaseIds = new WeakMap([
      [firstLease, 'input-run-1'],
      [secondLease, 'input-run-2']
    ])

    await expect(
      internals.dispatch('resolveNotebookInput', {
        sessionId: 'session-1',
        inputRunLeaseId: 'input-run-1',
        sourceKind: 'upload-version',
        inputFileVersionId: 'upload-version-1'
      })
    ).resolves.toEqual({ path: '/managed/groups.csv' })
    expect(firstResolve).toHaveBeenCalledTimes(1)
    expect(secondResolve).not.toHaveBeenCalled()
  })

  it('dispatches managePackages to the runtime service', async () => {
    const root = await createStorageRoot()
    const calls: unknown[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: {
        prepareRun: vi.fn(),
        captureCompletedRun: vi.fn(),
        inspectPackages: vi.fn(),
        markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
        refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
      },
      installPackagesImpl: async (request) => {
        calls.push(request)
        return { ok: true, needsRestart: false, log: 'installed' }
      }
    })
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token'
    })
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
      expect(payload.result).toMatchObject({
        ok: true,
        needsRestart: false,
        log: 'installed',
        target: {
          language: 'python',
          selection: 'implicit-default',
          runtimeSource: 'managed',
          environmentName: DEFAULT_PY_ENV
        }
      })
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
      projectId: 'default-project',
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
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token'
    })
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
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    // Inject a fake compute service with the minimal surface the dispatch needs.
    const fakeComputeService = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: true, probeResult: undefined }),
      appendDetails: async () => {},
      replaceDetails: async () => {},
      download: async () => ({}),
      submitJob: async () => ({}),
      getJobStatus: async () => ({}),
      getJobResult: async () => ({}),
      // Returns pre-configured enabled hosts for the session under test.
      listCompute: (sessionId: string): string[] => {
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
      transport: 'tcp',
      token: 'secret-token',
      computeService: fakeComputeService as never
    })
    const connection = await server.issueSessionConnection(
      'my-session',
      'default-project',
      'root-frame-my-session'
    )

    try {
      // Known session → returns the registered host list.
      const withHosts = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'computeCall',
          params: { op: 'list_compute', session_id: 'forged-session' }
        })
      })
      const withHostsPayload = (await withHosts.json()) as { result: string[] }

      expect(withHosts.status).toBe(200)
      expect(withHostsPayload.result).toEqual(['ssh:cluster-1'])

      // Unknown session → empty array.
      const otherConnection = await server.issueSessionConnection(
        'other-session',
        'default-project',
        'root-frame-other-session'
      )
      const noHosts = await fetch(otherConnection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${otherConnection.token}`,
          'content-type': 'application/json'
        },
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
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const calls: Array<{ sessionId: string; limit: number }> = []
    const fakeComputeService = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: true, probeResult: undefined }),
      appendDetails: async () => {},
      replaceDetails: async () => {},
      download: async () => ({}),
      submitJob: async () => ({}),
      getJobStatus: async () => ({}),
      getJobResult: async () => ({}),
      listCompute: () => [],
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
      transport: 'tcp',
      token: 'secret-token',
      computeService: fakeComputeService as never
    })
    const connection = await server.issueSessionConnection(
      'my-session',
      'default-project',
      'root-frame-my-session'
    )

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'computeCall',
          params: { op: 'set_concurrency_limit', session_id: 'forged-session', limit: 10 }
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
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const fakeComputeService = {
      callCommand: async () => ({}),
      list: async () => [],
      getDetails: async () => ({ doc: '', isSkeleton: true, probeResult: undefined }),
      appendDetails: async () => {},
      replaceDetails: async () => {},
      download: async () => ({}),
      submitJob: async () => ({}),
      getJobStatus: async () => ({}),
      getJobResult: async () => ({}),
      listCompute: () => [],
      setSessionConcurrencyLimit: async () => {},
      getSessionConcurrencyStatus: async (sessionId: string) => ({
        session_limit: sessionId === 'my-session' ? 5 : null,
        active_count: 2,
        queued_count: 1,
        provider_ceilings: { 'ssh:cluster-a': 10 }
      })
    }
    const server = new NotebookLocalRpcServer(service, {
      transport: 'tcp',
      token: 'secret-token',
      computeService: fakeComputeService as never
    })
    const connection = await server.issueSessionConnection(
      'my-session',
      'default-project',
      'root-frame-my-session'
    )

    try {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'computeCall',
          params: { op: 'concurrency_status', session_id: 'forged-session' }
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
