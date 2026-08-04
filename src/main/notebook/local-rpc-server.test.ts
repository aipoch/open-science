import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunInputFile } from '../../shared/notebook'
import { fetchLocalRpc } from '../local-rpc-transport'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookControlCompletionCapturedError, NotebookRuntimeService } from './runtime-service'
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
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('notebook local RPC server', () => {
  it('propagates a local socket through every issued capability connection', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, { transport: 'pipe' })
    const session = await server.issueSessionConnection('session-1', 'default-project')
    const skillImport = await server.issueSkillImportConnection('session-1')
    const control = await server.issueControlConnection('session-1', 'default-project')

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
      projectName: 'default-project',
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
          method: 'inspectPackages',
          params: {
            projectName: 'default-project',
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

  it('revokes session RPC capabilities and removes aliases when their session is released', async () => {
    const root = await createStorageRoot()
    const connectorCall = vi.fn(async () => ({ ok: true }))
    const onSessionReleased = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      token: 'secret-token',
      onSessionReleased,
      connectorService: { call: connectorCall }
    })
    const connection = await server.issueSessionConnection('notebook-session-1', 'default-project')
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
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      token: 'secret-token',
      connectorService: { call: connectorCall }
    })
    const initial = await server.issueSessionConnection('notebook-session-1', 'default-project')
    server.registerSessionAlias('notebook-session-1', 'real-session-1')
    const control = await server.issueControlConnection('real-session-1', 'default-project')
    const replacement = await server.issueSessionConnection('real-session-1', 'default-project')

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

  it('allows agentsCall through a session-bound control capability and derives its trusted context', async () => {
    const root = await createStorageRoot()
    const agentsRead = vi.fn(async () => ({ status: 'approved' }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      token: 'secret-token',
      agentsService: { read: agentsRead },
      inputRegistry: {
        registerTurn: vi.fn(async () => undefined),
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
    const control = await server.issueControlConnection('trusted-session', 'default-project')
    server.setArtifactProvenanceContext('trusted-session', {
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1'
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
      { token: 'secret-token' }
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
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const server = new NotebookLocalRpcServer(service, {
      token: 'secret-token',
      connectorService: { call: connectorCall }
    })
    const prior = await server.issueSessionConnection('stable-session', 'default-project')
    const replacement = await server.issueSessionConnection('stable-session', 'default-project')

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
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const requests: unknown[] = []
    const server = new NotebookLocalRpcServer(service, {
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
            projectName: 'project-1',
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

  it('revokes new Artifact requests while draining one already-authorized write', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const createStarted = createDeferred()
    const releaseCreate = createDeferred()
    let now = 1_000
    const server = new NotebookLocalRpcServer(service, {
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
            projectName: 'project-1',
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
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const createVersion = vi.fn()
    const server = new NotebookLocalRpcServer(service, {
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
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const createVersion = vi.fn()
    const server = new NotebookLocalRpcServer(service, {
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
      await expect(revoked.json()).resolves.toEqual({ error: 'Invalid Artifact RPC capability.' })
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
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const createVersion = vi.fn().mockResolvedValue({ versionId: 'version-1' })
    const server = new NotebookLocalRpcServer(service, {
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
      projectName: 'default-project',
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
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectName: 'default-project',
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
      token: 'secret-token',
      inputRegistry: {
        registerTurn: async () => undefined,
        getTurnInputs: () => [registeredInput],
        openRun: async () =>
          ({
            getRunInputFiles: () => [leasedInput],
            resolve: async () => {
              leasedInput.association = 'resolver-accessed'
              return '/managed/groups.csv'
            },
            close: () => [{ ...leasedInput }]
          }) as never,
        clearSession: () => undefined
      }
    })
    const connection = await server.ensureStarted()
    rpcEndpoint = connection.endpoint
    rpcToken = connection.token
    server.setArtifactProvenanceContext('session-1', {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'root-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'message-user-1'
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
            projectName: 'default-project',
            sessionId: 'session-1',
            workspaceCwd: '/workspace',
            code: 'print("ok")'
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
        inputFiles: [{ ...registeredInput, association: 'resolver-accessed' }]
      })
      const payload = (await response.json()) as {
        result: { inputFiles: Array<Record<string, unknown>> }
      }
      expect(payload.result.inputFiles).toEqual([
        expect.objectContaining({ inputFileVersionId: 'upload-version-1' })
      ])
      expect(payload.result.inputFiles[0]).not.toHaveProperty('storageKey')
    } finally {
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
      projectName: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    vi.spyOn(service, 'execute').mockImplementation(async (executeRequest) => {
      inputRunLeaseId = executeRequest.inputRunLeaseId
      throw failure
    })
    const server = new NotebookLocalRpcServer(service, {
      token: 'secret-token',
      inputRegistry: {
        registerTurn: vi.fn().mockResolvedValue(undefined),
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
    server.setArtifactProvenanceContext('session-1', {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'root-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'message-user-1'
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
        projectName: 'default-project',
        repository: new NotebookRunRepository(root)
      }),
      { token: 'secret-token' }
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
      projectName: 'default-project',
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
    const connection = await server.issueSessionConnection('my-session', 'default-project')

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
        'default-project'
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
    const connection = await server.issueSessionConnection('my-session', 'default-project')

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
    const connection = await server.issueSessionConnection('my-session', 'default-project')

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
