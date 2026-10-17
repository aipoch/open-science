import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLinearConversationGraph,
  projectConversationMessage
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from '../artifacts/provenance-test-fixtures'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { UploadRepository } from '../uploads/repository'
import { HostArtifactsService } from './host-artifacts-service'
import { NotebookLocalRpcServer } from './local-rpc-server'

type RpcConnection = { endpoint: string; token: string; release?: () => void }

const callArtifacts = async (
  connection: RpcConnection,
  token: string,
  params: Record<string, unknown>
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'artifactsCall', params })
  })
  return { response, payload: (await response.json()) as Record<string, unknown> }
}

let server: NotebookLocalRpcServer | undefined
const fixtures: Array<Awaited<ReturnType<typeof createProvenanceTestFixture>>> = []

afterEach(async () => {
  try {
    await server?.close()
    server = undefined
  } finally {
    for (const fixture of fixtures.splice(0)) await fixture.dispose()
  }
})

async function producerFixture(restoredRoot = false): Promise<{
  fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  repository: ArtifactProvenanceRepository
  inputAuthority: ImmutableInputAuthority
  version: Awaited<ReturnType<ArtifactProvenanceRepository['createVersion']>>
  binding: Parameters<NotebookLocalRpcServer['setArtifactTurnBinding']>[1]
  invocation: Parameters<
    Awaited<ReturnType<NotebookLocalRpcServer['issueControlConnection']>>['beginControlInvocation']
  >[0]
  connection: Awaited<ReturnType<NotebookLocalRpcServer['issueControlConnection']>>
  end: () => void
  finalize: () => Promise<void>
}> {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  await fixture.client.project.create({ data: { id: 'project-1', name: 'Producer read-back' } })
  const conversationGraph = createLinearConversationGraph({
    sessionId: 'session-1',
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Save and verify a file',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'message-1',
        role: 'agent',
        content: 'Saved plot.png',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ],
    frameworkId: 'codex',
    model: 'gpt-5',
    createdAt: 1,
    updatedAt: 2
  })
  if (restoredRoot) {
    const rootFrameId = '77e08941-e525-4f61-bc31-c54db2f4b80a'
    conversationGraph.rootFrameId = rootFrameId
    conversationGraph.activeFrameId = rootFrameId
    conversationGraph.frames[0].id = rootFrameId
    for (const item of [
      ...conversationGraph.messages,
      ...conversationGraph.branches,
      ...conversationGraph.runtimeSegments
    ])
      item.agentFrameId = rootFrameId
  }
  const session: PersistedChatSession = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Producer read-back',
    cwd: join(fixture.storageRoot, 'workspace'),
    status: 'idle',
    messages: conversationGraph.messages.map(projectConversationMessage),
    conversationGraph,
    createdAt: 1,
    updatedAt: 2
  }
  const provenanceContext = {
    rootFrameId: conversationGraph.rootFrameId,
    agentFrameId: conversationGraph.activeFrameId,
    messageBranchId: conversationGraph.branches[0].id,
    runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
    promptMessageId: 'prompt-1'
  }
  const repository = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: async () => session
  })
  await fixture.stagePng('verified producer bytes')
  const version = await repository.createVersion(createArtifactVersionRequest(provenanceContext))
  const managedFileVersions = new ManagedFileVersionService({
    storageRoot: fixture.storageRoot,
    getClient: () => Promise.resolve(fixture.client)
  })
  const catalog = new ManagedFileIndexRepository(
    () => Promise.resolve(fixture.client),
    fixture.storageRoot,
    managedFileVersions,
    new UploadRepository(fixture.storageRoot, { getClient: () => Promise.resolve(fixture.client) })
  )
  const inputAuthority = new ImmutableInputAuthority({
    storageRoot: fixture.storageRoot,
    managedFileVersions
  })
  server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
    transport: 'tcp',
    hostArtifacts: new HostArtifactsService(catalog, inputAuthority)
  })
  const binding = {
    projectId: 'project-1',
    ownerExecutionId: 'execution-1',
    artifactRunId: 'artifact-run-1',
    artifactStorageSessionId: 'artifact-session-1',
    provenanceContext
  }
  server.setArtifactTurnBinding('session-1', binding)
  const connection = await server.issueControlConnection(
    'session-1',
    'project-1',
    restoredRoot ? 'root-frame-session-1' : provenanceContext.agentFrameId
  )
  const invocation = {
    rootExecutionId: 'execution-1',
    turnId: 'repl-run-1',
    toolInvocationId: 'repl-run-1',
    controlInvocationGeneration: 1,
    executionMode: 'foreground' as const,
    originatingTurnId: 'prompt-1'
  }
  const end = connection.beginControlInvocation(invocation)
  return {
    fixture,
    repository,
    inputAuthority,
    version,
    binding,
    invocation,
    connection,
    end,
    finalize: async () => {
      const request = {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
        artifactVersionIds: [version.versionId],
        ...provenanceContext,
        messageId: 'message-1'
      }
      await repository.finalizeRun(request)
      await repository.activateFinalizedRun(request)
    }
  }
}

describe('artifactsCall RPC', () => {
  it.each([false, true])(
    'reads current-turn pending bytes with restored root %s without publishing them into the Project catalog',
    async (restoredRoot) => {
      const { fixture, version, connection } = await producerFixture(restoredRoot)
      const params = { op: 'path', version_id: version.versionId }
      const resolved = await callArtifacts(connection, connection.token, params)
      expect(resolved.response.status, JSON.stringify(resolved.payload)).toBe(200)
      const bytes = await readFile(resolved.payload.result as string)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(version.checksum)
      expect(
        await callArtifacts(connection, connection.token, { op: 'list', options: {} })
      ).toMatchObject({
        payload: { result: { count: 0, artifacts: [] } }
      })
      expect(
        await fixture.client.artifactVersion.findUnique({ where: { id: version.versionId } })
      ).toMatchObject({
        state: 'pending',
        messageId: null,
        managedVisibleAt: null
      })
    }
  )

  it.each(['session', 'project', 'root', 'frame', 'branch', 'segment', 'prompt', 'run'] as const)(
    'rejects a pending Version belonging to another %s despite forged producer fields',
    async (field) => {
      const { binding, invocation, version, connection: original, end } = await producerFixture()
      end()
      original.release()
      const changed = { ...binding, provenanceContext: { ...binding.provenanceContext } }
      const provenanceKey = {
        frame: 'agentFrameId',
        branch: 'messageBranchId',
        segment: 'runtimeSegmentId',
        prompt: 'promptMessageId'
      } as const
      if (field in provenanceKey)
        changed.provenanceContext[provenanceKey[field as keyof typeof provenanceKey]] =
          'another-owner'
      if (field === 'root') {
        changed.provenanceContext.rootFrameId = 'another-root'
        changed.provenanceContext.agentFrameId = 'another-root'
      }
      if (field === 'run') changed.artifactRunId = 'another-run'
      const sessionId = field === 'session' ? 'another-session' : 'session-1'
      const projectId = field === 'project' ? 'another-project' : 'project-1'
      changed.projectId = projectId
      server!.setArtifactTurnBinding(sessionId, changed)
      const connection = await server!.issueControlConnection(
        sessionId,
        projectId,
        changed.provenanceContext.agentFrameId!
      )
      connection.beginControlInvocation(invocation)
      const denied = await callArtifacts(connection, connection.token, {
        op: 'path',
        version_id: version.versionId,
        projectId: 'project-1',
        sessionId: 'session-1',
        producerScope: {
          appSessionId: 'session-1',
          artifactRunId: 'artifact-run-1',
          ...binding.provenanceContext
        },
        provenanceContext: binding.provenanceContext
      })
      expect(denied.response.status).not.toBe(200)
      expect(denied.payload).not.toHaveProperty('result')
    }
  )

  it.each([
    'missing-turn',
    'missing-invocation',
    'stale-invocation',
    'background',
    'delegate'
  ] as const)('does not grant pending read-back to %s callers', async (mode) => {
    const { binding, invocation, version, connection: original, end } = await producerFixture()
    end()
    original.release()
    if (mode === 'missing-turn') await server!.clearArtifactTurnBinding('session-1', 'execution-1')
    const connection = await server!.issueControlConnection(
      'session-1',
      'project-1',
      binding.provenanceContext.agentFrameId!,
      { role: mode === 'delegate' ? 'delegate' : 'main' }
    )
    if (mode !== 'missing-invocation')
      connection.beginControlInvocation({
        ...invocation,
        ...(mode === 'background' ? { executionMode: 'background' } : {}),
        ...(mode === 'stale-invocation' ? { rootExecutionId: 'previous-execution' } : {})
      })
    const denied = await callArtifacts(connection, connection.token, {
      op: 'path',
      version_id: version.versionId,
      producerScope: {
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
        ...binding.provenanceContext
      },
      executionMode: 'foreground',
      rootExecutionId: 'execution-1'
    })
    expect(denied.response.status).not.toBe(200)
    expect(denied.payload).not.toHaveProperty('result')
  })

  it('retains finalized Project reads without a turn, including background callers', async () => {
    const { version, connection, invocation, end, finalize } = await producerFixture()
    end()
    await finalize()
    await server!.clearArtifactTurnBinding('session-1', 'execution-1')
    const params = { op: 'path', version_id: version.versionId }
    const resolved = await callArtifacts(connection, connection.token, params)
    expect(resolved.response.status, JSON.stringify(resolved.payload)).toBe(200)
    connection.beginControlInvocation({ ...invocation, executionMode: 'background' })
    const background = await callArtifacts(connection, connection.token, params)
    expect(background.payload).toEqual(resolved.payload)
    expect(
      createHash('sha256')
        .update(await readFile(background.payload.result as string))
        .digest('hex')
    ).toBe(version.checksum)
  })

  it.each([
    'invocation-end',
    'invocation-replacement',
    'turn-replacement',
    'capability-revocation'
  ] as const)('does not return a staged pending path after %s', async (retirement) => {
    const { inputAuthority, version, binding, invocation, connection, end } =
      await producerFixture()
    const stage = inputAuthority.stageVersion.bind(inputAuthority)
    let staged!: () => void
    const reached = new Promise<void>((resolve) => {
      staged = resolve
    })
    let proceed!: () => void
    const gate = new Promise<void>((resolve) => {
      proceed = resolve
    })
    vi.spyOn(inputAuthority, 'stageVersion').mockImplementation(async (request) => {
      const path = await stage(request)
      staged()
      await gate
      return path
    })
    const pending = callArtifacts(connection, connection.token, {
      op: 'path',
      version_id: version.versionId
    })
    await reached
    if (retirement === 'invocation-end') end()
    else if (retirement === 'invocation-replacement')
      connection.beginControlInvocation({
        ...invocation,
        toolInvocationId: 'new-invocation',
        controlInvocationGeneration: 2
      })
    else if (retirement === 'turn-replacement')
      server!.setArtifactTurnBinding('session-1', {
        ...binding,
        ownerExecutionId: 'new-execution'
      })
    else connection.revoke()
    proceed()
    const denied = await pending
    expect(denied.response.status).not.toBe(200)
    expect(denied.payload).not.toHaveProperty('result')
  })

  it('binds list and path scope to the control token without synthesizing a Frame filter', async () => {
    const list = vi.fn(async () => ({ artifacts: [] }))
    const resolvePath = vi.fn(async () => '/managed/report.csv')
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostArtifacts: { list, resolvePath }
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const listed = await callArtifacts(control, control.token, {
      op: 'list',
      options: { frame_id: 'requested-producer-frame' },
      projectId: 'forged-project',
      sessionId: 'forged-session',
      project_id: 'all',
      session_id: 'forged-session',
      frame_id: 'forged-top-level-frame'
    })
    expect(listed).toMatchObject({ response: { status: 200 } })
    expect(list).toHaveBeenNthCalledWith(
      1,
      { frame_id: 'requested-producer-frame' },
      { projectId: 'trusted-project', sessionId: 'trusted-session' }
    )

    const listedWithoutFrame = await callArtifacts(control, control.token, {
      op: 'list',
      options: {},
      projectId: 'forged-project',
      sessionId: 'forged-session',
      frame_id: 'forged-top-level-frame'
    })
    expect(listedWithoutFrame).toMatchObject({ response: { status: 200 } })
    expect(list).toHaveBeenNthCalledWith(
      2,
      {},
      {
        projectId: 'trusted-project',
        sessionId: 'trusted-session'
      }
    )

    const resolved = await callArtifacts(control, control.token, {
      op: 'path',
      version_id: 'version-1',
      projectId: 'forged-project',
      sessionId: 'forged-session'
    })
    expect(resolved.payload).toEqual({ result: '/managed/report.csv' })
    expect(resolvePath).toHaveBeenCalledWith('version-1', {
      projectId: 'trusted-project',
      sessionId: 'trusted-session'
    })
  })

  it('rejects bootstrap, invalid, ordinary Session, and released control capabilities', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostArtifacts: { list: vi.fn(), resolvePath: vi.fn() }
    })
    const bootstrap = await server.ensureStarted()
    const ordinary = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const params = { op: 'list', options: {} }

    await expect(callArtifacts(control, bootstrap.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'A session-bound notebook RPC token is required.' }
    })
    await expect(callArtifacts(control, 'invalid-token', params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    await expect(callArtifacts(control, ordinary.token, params)).resolves.toMatchObject({
      response: { status: 403 },
      payload: { error: 'host.artifacts requires a control-plane REPL capability.' }
    })

    control.release()
    await expect(callArtifacts(control, control.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    ordinary.release?.()
  })
})
