import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../shared/artifacts'
import { ArtifactRepository, getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createNotebookArtifactSourceScopeProvider } from '../notebook/artifact-source-scope'
import { ArtifactTurnOwner } from './artifact-turn-owner'

const roots: string[] = []
let executionSequence = 0

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-turn-owner-'))
  roots.push(root)
  return root
}

const createDeferred = <T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const artifactVersion = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
  id: 'version-1',
  name: 'result.txt',
  path: '/managed/result.txt',
  fileUrl: 'file:///managed/result.txt',
  mimeType: 'text/plain',
  size: 6,
  mtimeMs: 1,
  projectId: 'project-1',
  sessionId: 'artifact-session-1',
  runId: 'artifact-run-1',
  versionId: 'version-1',
  ...overrides
})

const openRootExecution = (
  owner: ArtifactTurnOwner,
  request: Omit<Parameters<ArtifactTurnOwner['openRootExecution']>[0], 'executionId'>
): ReturnType<ArtifactTurnOwner['openRootExecution']> =>
  owner.openRootExecution({ ...request, executionId: `root-execution-${++executionSequence}` })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ArtifactTurnOwner', () => {
  it('exposes no Session-current production write authority', () => {
    expect(Object.getOwnPropertyNames(ArtifactTurnOwner.prototype)).not.toEqual(
      expect.arrayContaining(['open', 'promptMessageIdFor', 'writeForActiveTurn'])
    )
  })

  it('does not grant Notebook source scope to an owner that did not opt in', async () => {
    const dataRoot = await createRoot()
    const issuedBindings: Array<Record<string, unknown>> = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: (binding) => {
        issuedBindings.push(binding)
        return 'artifact-only-capability'
      }
    })

    const turn = await owner.openExecution({
      executionId: 'artifact-only-execution',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Artifact-only Agent'
    })
    const handoff = JSON.parse(await readFile(owner.handoffFile(turn), 'utf8')) as Record<
      string,
      unknown
    >

    expect(handoff).not.toHaveProperty('notebookSessionId')
    expect(handoff).not.toHaveProperty('notebookDataDir')
    expect(handoff).not.toHaveProperty('notebookSessionRoot')
    expect(issuedBindings[0]).not.toHaveProperty('notebookSessionId')

    await owner.dispose(turn)
  })

  it('uses provenance frame identity for Notebook scope even on the root transport', async () => {
    const dataRoot = await createRoot()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot)
    })

    const turn = await owner.openRootExecution({
      executionId: 'root-transport-child-frame',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Child Agent',
      provenanceContext: {
        rootFrameId: 'root-frame-session-1',
        agentFrameId: 'child-frame-1'
      }
    })
    const handoff = JSON.parse(await readFile(owner.handoffFile(turn), 'utf8')) as Record<
      string,
      unknown
    >

    expect(handoff).toMatchObject({
      notebookDataDir: join(
        dataRoot,
        'notebooks',
        'project-1',
        'session-1',
        'frames',
        'child-frame-1',
        'data'
      ),
      notebookSessionRoot: join(
        dataRoot,
        'notebooks',
        'project-1',
        'session-1',
        'frames',
        'child-frame-1'
      )
    })

    await owner.dispose(turn)
  })

  it('keeps concurrent executions in one Session independently addressable through opaque handles', async () => {
    const dataRoot = await createRoot()
    const writes: Array<Record<string, unknown>> = []
    const issuedBindings: Array<Record<string, unknown>> = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      now: () => 100,
      issueRpcCapability: (binding) => {
        issuedBindings.push(binding)
        return `capability-${binding.executionId}`
      },
      provenance: {
        listRunVersions: async () => [],
        writeAppGeneratedVersion: async (request) => {
          writes.push(request)
          return artifactVersion({
            id: `version-${request.artifactRunId}`,
            versionId: `version-${request.artifactRunId}`,
            runId: request.artifactRunId,
            name: request.filename
          })
        }
      }
    })

    const root = await owner.openExecution({
      executionId: 'root-execution',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex',
      provenanceContext: {
        rootFrameId: 'root-frame',
        agentFrameId: 'root-frame',
        messageBranchId: 'root-branch',
        runtimeSegmentId: 'root-segment',
        promptMessageId: 'root-prompt'
      }
    })
    const parallel = await owner.openExecution({
      executionId: 'parallel-execution',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex',
      provenanceContext: {
        rootFrameId: 'root-frame',
        agentFrameId: 'parallel-frame',
        messageBranchId: 'parallel-branch',
        runtimeSegmentId: 'parallel-segment',
        promptMessageId: 'parallel-prompt'
      }
    })

    await Promise.all([
      owner.write(root, { filename: 'root.txt', content: 'root' }),
      owner.write(parallel, {
        filename: 'parallel.txt',
        content: 'parallel',
        producer: {
          kind: 'connector',
          connectorId: 'molecule',
          toolId: 'preview_molecule',
          invocationId: 'connector-call-1',
          implementationVersion: '1',
          normalizedArguments: { filename: 'parallel.txt' }
        }
      })
    ])
    await owner.finalize(root)
    await owner.dispose(root)

    expect(owner.snapshot(root)).toMatchObject({
      executionId: 'root-execution',
      agentFrameId: 'root-frame',
      runtimeSegmentId: 'root-segment',
      promptMessageId: 'root-prompt',
      phase: 'disposed'
    })
    expect(owner.snapshot(parallel)).toMatchObject({
      executionId: 'parallel-execution',
      agentFrameId: 'parallel-frame',
      runtimeSegmentId: 'parallel-segment',
      promptMessageId: 'parallel-prompt',
      phase: 'open'
    })
    expect(owner.handleForExecution('parallel-execution')).toBe(parallel)
    expect(writes).toEqual([
      expect.objectContaining({
        artifactRunId: 'artifact-run-100-1',
        agentFrameId: 'root-frame',
        runtimeSegmentId: 'root-segment',
        promptMessageId: 'root-prompt'
      }),
      expect.objectContaining({
        artifactRunId: 'artifact-run-100-2',
        agentFrameId: 'parallel-frame',
        runtimeSegmentId: 'parallel-segment',
        promptMessageId: 'parallel-prompt',
        producer: expect.objectContaining({
          kind: 'connector',
          connectorId: 'molecule',
          toolId: 'preview_molecule',
          invocationId: 'connector-call-1'
        })
      })
    ])
    expect(issuedBindings).toEqual([
      expect.objectContaining({
        executionId: 'root-execution',
        artifactRunId: 'artifact-run-100-1',
        allowedMethods: [
          'artifactReserveWrite',
          'artifactReleaseWrite',
          'artifactCreateVersion',
          'artifactReplayVersion'
        ]
      }),
      expect.objectContaining({
        executionId: 'parallel-execution',
        artifactRunId: 'artifact-run-100-2',
        allowedMethods: [
          'artifactReserveWrite',
          'artifactReleaseWrite',
          'artifactCreateVersion',
          'artifactReplayVersion'
        ]
      })
    ])
    expect(owner.activeRunIds()).toEqual(['artifact-run-100-2'])

    await owner.dispose(parallel)
    expect(owner.activeRunIds()).toEqual([])
    expect(() => owner.handleForExecution('parallel-execution')).toThrow(/No active Artifact turn/)
  })

  it('leaves no pending Artifact marker after empty Child Attempts in two Sessions are disposed', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry: new ArtifactRunRegistry(),
      now: () => 100
    })

    const children = await Promise.all(
      [1, 2].map((index) =>
        owner.openExecution({
          executionId: `child-attempt-${index}`,
          appSessionId: `session-${index}`,
          artifactStorageSessionId: `artifact-session-${index}`,
          projectId: 'project-1',
          agentName: 'Main Agent'
        })
      )
    )
    const handoffFiles = children.map((child) => owner.handoffFile(child))
    expect(handoffFiles).toEqual([
      join(
        dataRoot,
        'artifacts',
        'project-1',
        'artifact-session-1',
        '.execution-handoffs',
        'artifact-run-100-1.json'
      ),
      join(
        dataRoot,
        'artifacts',
        'project-1',
        'artifact-session-2',
        '.execution-handoffs',
        'artifact-run-100-2.json'
      )
    ])

    await Promise.all(children.map((child) => owner.dispose(child)))

    for (const handoffFile of handoffFiles) {
      await expect(readFile(handoffFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readdir(dirname(handoffFile))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(repository.listPendingRunPublications('project-1')).resolves.toEqual([])
  })

  it('isolates a root execution handoff and cleanup from a parallel child execution', async () => {
    const dataRoot = await createRoot()
    const notebookContexts: unknown[] = []
    const revoked: string[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: ({ executionId }) => `capability-${executionId}`,
      revokeRpcCapability: (token) => {
        revoked.push(token)
      },
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot),
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => notebookContexts.push(context)
      }
    })
    const root = await owner.openRootExecution({
      executionId: 'root-execution',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex',
      provenanceContext: {
        agentFrameId: 'root-frame',
        runtimeSegmentId: 'root-segment',
        promptMessageId: 'root-prompt'
      }
    })
    const child = await owner.openExecution({
      executionId: 'child-attempt',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex',
      provenanceContext: {
        agentFrameId: 'child-frame',
        runtimeSegmentId: 'child-segment',
        promptMessageId: 'child-prompt'
      }
    })

    expect(owner.handoffFile(root)).not.toBe(owner.handoffFile(child))
    expect(notebookContexts).toEqual([
      expect.objectContaining({ agentFrameId: 'root-frame', promptMessageId: 'root-prompt' })
    ])

    await owner.dispose(child)
    await expect(readFile(owner.handoffFile(root), 'utf8')).resolves.toContain('root-execution')
    expect(notebookContexts).toHaveLength(1)
    expect(revoked).toEqual(['capability-child-attempt'])

    await owner.dispose(root)
    expect(notebookContexts.at(-1)).toBeUndefined()
    expect(revoked).toEqual(['capability-child-attempt', 'capability-root-execution'])
  })

  it('opens a turn-scoped handoff without exposing its capability or local path in snapshots', async () => {
    const dataRoot = await createRoot()
    const issuedBindings: unknown[] = []
    const notebookContexts: unknown[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      runtimeInstanceId: 'runtime-1',
      now: () => 123,
      issueRpcCapability: (binding) => {
        issuedBindings.push(binding)
        return 'secret-capability'
      },
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot),
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => notebookContexts.push(context)
      }
    })

    const turn = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code',
      provenanceContext: {
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        messageBranchAncestry: ['branch-parent'],
        messageAncestry: ['message-parent', 'prompt-1'],
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1'
      }
    })

    expect(owner.activeRunIds()).toEqual(['artifact-run-123-1'])
    expect(issuedBindings).toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-123-1',
        notebookSessionId: 'session-1',
        allowedMethods: [
          'artifactReserveWrite',
          'artifactReleaseWrite',
          'artifactCreateVersion',
          'artifactReplayVersion'
        ]
      })
    ])
    expect(notebookContexts).toEqual([
      {
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1'
      }
    ])

    const currentRunFile = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-1'
    )
    const handoff = JSON.parse(await readFile(currentRunFile, 'utf8')) as Record<string, unknown>
    expect(handoff).toMatchObject({
      artifactRunId: 'artifact-run-123-1',
      rpcCapabilityToken: 'secret-capability',
      notebookSessionId: 'session-1',
      notebookDataDir: join(
        dataRoot,
        'notebooks',
        'project-1',
        'session-1',
        'frames',
        'agent-1',
        'data'
      ),
      notebookSessionRoot: join(
        dataRoot,
        'notebooks',
        'project-1',
        'session-1',
        'frames',
        'agent-1'
      )
    })

    const snapshot = owner.snapshot(turn)
    expect(snapshot).toEqual({
      executionId: expect.stringMatching(/^root-execution-/),
      appSessionId: 'session-1',
      runId: 'artifact-run-123-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'segment-1',
      promptMessageId: 'prompt-1',
      phase: 'open',
      outstandingWrites: 0
    })
    expect(snapshot).not.toHaveProperty('rpcCapabilityToken')
    expect(snapshot).not.toHaveProperty('currentRunFile')
    expect(JSON.stringify(snapshot)).not.toContain('secret-capability')
    expect(JSON.stringify(snapshot)).not.toContain(dataRoot)
  })

  it('keeps app-side writes scoped to the active Session turn and fails closed otherwise', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry: new ArtifactRunRegistry(),
      now: () => 456
    })

    const firstTurn = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const secondTurn = await openRootExecution(owner, {
      appSessionId: 'session-2',
      artifactStorageSessionId: 'artifact-session-2',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    const first = await owner.write(firstTurn, {
      filename: 'first.txt',
      content: 'first'
    })
    const second = await owner.write(secondTurn, {
      filename: 'second.txt',
      content: 'second'
    })

    expect(first.sessionId).toBe('artifact-session-1')
    expect(second.sessionId).toBe('artifact-session-2')
    expect(first.runId).not.toBe(second.runId)
    await owner.dispose(firstTurn)
    await expect(owner.write(firstTurn, { filename: 'x.txt', content: 'x' })).rejects.toThrow(
      /not open/i
    )
  })

  it('seals synchronously, drains accepted app and RPC writes, and prepares one claim exactly once', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const releaseWrite = createDeferred()
    const releaseRpc = createDeferred()
    const writeStarted = createDeferred()
    const listedVersion = artifactVersion()
    const listRunVersions = vi.fn(async () => [listedVersion])
    const writeAppGeneratedVersion = vi.fn(async () => {
      writeStarted.resolve()
      await releaseWrite.promise
      return listedVersion
    })
    const prepareRunFinalization = vi.spyOn(repository, 'prepareRunFinalization')
    const runRegistry = new ArtifactRunRegistry()
    const register = vi.spyOn(runRegistry, 'register')
    const revokeRpcCapability = vi.fn(async () => releaseRpc.promise)
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry,
      provenance: { listRunVersions, writeAppGeneratedVersion },
      issueRpcCapability: () => 'capability-1',
      revokeRpcCapability,
      now: () => 789
    })
    const turn = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'OpenCode'
    })
    const acceptedWrite = owner.write(turn, {
      filename: 'result.txt',
      content: 'result'
    })
    await writeStarted.promise

    const firstFinalization = owner.finalize(turn)
    const repeatedFinalization = owner.finalize(turn)
    expect(firstFinalization).toBe(repeatedFinalization)
    await expect(owner.write(turn, { filename: 'late.txt', content: 'late' })).rejects.toThrow(
      /not open/i
    )
    expect(listRunVersions).not.toHaveBeenCalled()

    releaseRpc.resolve()
    await Promise.resolve()
    expect(listRunVersions).not.toHaveBeenCalled()
    releaseWrite.resolve()
    await acceptedWrite

    const publication = await firstFinalization
    expect(publication).toMatchObject({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      runId: 'artifact-run-789-1',
      artifactClaimId: expect.stringMatching(/^artifact-claim-/),
      artifacts: [listedVersion]
    })
    expect(revokeRpcCapability).toHaveBeenCalledOnce()
    expect(listRunVersions).toHaveBeenCalledOnce()
    expect(prepareRunFinalization).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledOnce()
    await expect(owner.finalize(turn)).resolves.toBe(publication)
  })

  it('caches an empty terminal result without creating a claim', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const listPendingRunFiles = vi.spyOn(repository, 'listPendingRunFiles')
    const runRegistry = new ArtifactRunRegistry()
    const register = vi.spyOn(runRegistry, 'register')
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry,
      now: () => 900
    })
    const turn = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    await expect(owner.finalize(turn)).resolves.toBeUndefined()
    await expect(owner.finalize(turn)).resolves.toBeUndefined()
    expect(listPendingRunFiles).toHaveBeenCalledOnce()
    expect(register).not.toHaveBeenCalled()
    expect(owner.snapshot(turn)).toMatchObject({
      appSessionId: 'session-1',
      runId: 'artifact-run-900-1',
      phase: 'finalized',
      outstandingWrites: 0,
      terminalResult: { kind: 'empty' }
    })
  })

  it('does not let stale cleanup erase a replacement turn owned by the same Session', async () => {
    const dataRoot = await createRoot()
    const notebookContexts: Array<{ sessionId: string; context: unknown }> = []
    const revoked: string[] = []
    let capabilitySequence = 0
    let now = 1_000
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      now: () => now,
      issueRpcCapability: () => `capability-${++capabilitySequence}`,
      revokeRpcCapability: (token) => {
        revoked.push(token)
      },
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot),
      notebook: {
        setArtifactProvenanceContext: (sessionId, context) => {
          notebookContexts.push({ sessionId, context })
        }
      }
    })
    const first = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    now = 1_001
    const replacement = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    await owner.dispose(first)
    const currentRunFile = getArtifactCurrentRunFilePath(dataRoot, 'project-1', 'session-1')
    await expect(readFile(currentRunFile, 'utf8')).resolves.toContain('artifact-run-1001-2')
    expect(owner.activeRunIds()).toEqual(['artifact-run-1001-2'])
    expect(notebookContexts.at(-1)?.context).not.toBeUndefined()

    await owner.dispose(replacement)
    await expect(readFile(currentRunFile, 'utf8')).resolves.toBe('{}\n')
    expect(owner.activeRunIds()).toEqual([])
    expect(notebookContexts.at(-1)).toEqual({ sessionId: 'session-1', context: undefined })
    expect(revoked).toEqual(['capability-1', 'capability-2'])
  })

  it('serializes stale cleanup with a replacement opening the same handoff', async () => {
    const dataRoot = await createRoot()
    const cleanupWriteStarted = createDeferred()
    const releaseCleanupWrite = createDeferred()
    let writeCount = 0
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      writeHandoffFile: async (filePath, content) => {
        writeCount += 1
        if (writeCount === 2) {
          cleanupWriteStarted.resolve()
          await releaseCleanupWrite.promise
        }
        await writeFile(filePath, content, 'utf8')
      }
    })
    const first = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    const staleDisposal = owner.dispose(first)
    await cleanupWriteStarted.promise
    const replacementOpening = openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    await Promise.resolve()
    expect(writeCount).toBe(2)

    releaseCleanupWrite.resolve()
    await staleDisposal
    const replacement = await replacementOpening
    const currentRunFile = getArtifactCurrentRunFilePath(dataRoot, 'project-1', 'session-1')
    await expect(readFile(currentRunFile, 'utf8')).resolves.toContain('artifact-run-')
    expect(owner.activeRunIds()).toHaveLength(1)
    await owner.dispose(replacement)
  })

  it('keeps active ownership retryable when capability revocation fails', async () => {
    const dataRoot = await createRoot()
    const notebookContexts: unknown[] = []
    const writeStarted = createDeferred()
    const releaseWrite = createDeferred()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      provenance: {
        listRunVersions: async () => [],
        writeAppGeneratedVersion: async () => {
          writeStarted.resolve()
          await releaseWrite.promise
          return artifactVersion()
        }
      },
      issueRpcCapability: () => 'capability-1',
      revokeRpcCapability: vi
        .fn()
        .mockRejectedValueOnce(new Error('revoke failed'))
        .mockResolvedValue(undefined),
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot),
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => notebookContexts.push(context)
      }
    })
    const turn = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const acceptedWrite = owner.write(turn, {
      filename: 'accepted.txt',
      content: 'accepted'
    })
    await writeStarted.promise
    const currentRunFile = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-1'
    )

    const disposal = owner.dispose(turn)
    let disposalSettled = false
    void disposal.then(
      () => {
        disposalSettled = true
      },
      () => {
        disposalSettled = true
      }
    )
    await Promise.resolve()
    expect(disposalSettled).toBe(false)

    releaseWrite.resolve()
    await acceptedWrite
    await expect(disposal).rejects.toThrow('revoke failed')

    expect(disposalSettled).toBe(true)
    expect(owner.activeRunIds()).toEqual([owner.snapshot(turn).runId])
    await expect(readFile(currentRunFile, 'utf8')).resolves.toBe('{}\n')
    expect(notebookContexts.at(-1)).toBeUndefined()

    await owner.dispose(owner.handleForExecution(owner.snapshot(turn).executionId as string))
    expect(owner.activeRunIds()).toEqual([])
    expect(owner.snapshot(turn).phase).toBe('disposed')
  })

  it('clears a stale turn handoff when its replacement uses a different storage Session', async () => {
    const dataRoot = await createRoot()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry()
    })
    const first = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-provisional',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const replacement = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const firstHandoff = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-provisional'
    )
    const replacementHandoff = getArtifactCurrentRunFilePath(dataRoot, 'project-1', 'session-1')

    await owner.dispose(first)

    await expect(readFile(firstHandoff, 'utf8')).resolves.toBe('{}\n')
    await expect(readFile(replacementHandoff, 'utf8')).resolves.toContain('artifact-run-')
    expect(owner.activeRunIds()).toHaveLength(1)
    await owner.dispose(replacement)
  })

  it('retries failed claim preparation without duplicating a successful claim', async () => {
    const dataRoot = await createRoot()
    const repository = new ArtifactRepository(dataRoot)
    const runRegistry = new ArtifactRunRegistry()
    const register = vi.spyOn(runRegistry, 'register')
    const listRunVersions = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary list failure'))
      .mockResolvedValue([artifactVersion()])
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository,
      runRegistry,
      provenance: {
        listRunVersions,
        writeAppGeneratedVersion: async () => artifactVersion()
      }
    })
    const turn = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    await expect(owner.finalize(turn)).rejects.toThrow('temporary list failure')
    await expect(owner.finalize(turn)).resolves.toMatchObject({
      artifactClaimId: expect.stringMatching(/^artifact-claim-/)
    })

    expect(listRunVersions).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledOnce()
    await owner.dispose(turn)
  })

  it('serializes finalization with disposal and never reopens a disposed turn', async () => {
    const dataRoot = await createRoot()
    const listStarted = createDeferred()
    const releaseList = createDeferred()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      provenance: {
        listRunVersions: async () => {
          listStarted.resolve()
          await releaseList.promise
          return [artifactVersion()]
        },
        writeAppGeneratedVersion: async () => artifactVersion()
      }
    })
    const turn = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const finalization = owner.finalize(turn)
    await listStarted.promise
    const disposal = owner.dispose(turn)
    let disposalSettled = false
    void disposal.then(() => {
      disposalSettled = true
    })

    await Promise.resolve()
    expect(disposalSettled).toBe(false)
    releaseList.resolve()
    const publication = await finalization
    await disposal

    expect(owner.snapshot(turn).phase).toBe('disposed')
    await expect(owner.finalize(turn)).resolves.toBe(publication)
    expect(owner.snapshot(turn).phase).toBe('disposed')

    const disposedWithoutFinalization = await openRootExecution(owner, {
      appSessionId: 'session-2',
      artifactStorageSessionId: 'artifact-session-2',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    await owner.dispose(disposedWithoutFinalization)
    await expect(owner.finalize(disposedWithoutFinalization)).rejects.toThrow(/disposed/i)
  })

  it('clears a written handoff when Notebook provenance setup fails', async () => {
    const dataRoot = await createRoot()
    const contexts: unknown[] = []
    const revoked: string[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: () => 'capability-1',
      revokeRpcCapability: (token) => {
        revoked.push(token)
        throw new Error('cleanup revoke failed')
      },
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot),
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => {
          contexts.push(context)
          if (context) throw new Error('Notebook context failed')
        }
      }
    })
    const currentRunFile = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-1'
    )

    await expect(
      openRootExecution(owner, {
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        projectId: 'project-1',
        agentName: 'Codex'
      })
    ).rejects.toThrow('Notebook context failed')

    await expect(readFile(currentRunFile, 'utf8')).resolves.toBe('{}\n')
    expect(contexts.at(-1)).toBeUndefined()
    expect(revoked).toEqual(['capability-1'])
    expect(owner.activeRunIds()).toEqual([])
  })

  it('keeps a failed disposal retryable without reopening a successfully disposed turn', async () => {
    const dataRoot = await createRoot()
    const contexts: unknown[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot),
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => contexts.push(context)
      }
    })
    const turn = await openRootExecution(owner, {
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const currentRunFile = getArtifactCurrentRunFilePath(
      dataRoot,
      'project-1',
      'artifact-session-1'
    )
    await rm(currentRunFile)
    await mkdir(currentRunFile)

    const firstDisposal = owner.dispose(turn)
    expect(owner.dispose(turn)).toBe(firstDisposal)
    await expect(firstDisposal).rejects.toThrow()

    expect(contexts.at(-1)).toBeUndefined()
    expect(owner.activeRunIds()).toEqual([owner.snapshot(turn).runId])
    expect(owner.handleForExecution(owner.snapshot(turn).executionId as string)).toBe(turn)
    expect(owner.snapshot(turn).phase).toBe('sealing')
    await expect(owner.finalize(turn)).rejects.toThrow(/disposing or disposed/i)

    await rm(currentRunFile, { recursive: true })
    const retry = owner.dispose(
      owner.handleForExecution(owner.snapshot(turn).executionId as string)
    )
    expect(owner.dispose(turn)).toBe(retry)
    await retry

    expect(owner.activeRunIds()).toEqual([])
    expect(() => owner.handleForExecution(owner.snapshot(turn).executionId as string)).toThrow(
      /No active Artifact turn/
    )
    expect(owner.snapshot(turn).phase).toBe('disposed')
    expect(owner.dispose(turn)).toBe(retry)
    await expect(owner.dispose(turn)).resolves.toBeUndefined()
    await expect(owner.finalize(turn)).rejects.toThrow(/disposing or disposed/i)
  })

  it('revokes a capability and publishes no active state when opening the handoff fails', async () => {
    const dataRoot = await createRoot()
    const blockedRoot = join(dataRoot, 'blocked')
    const repository = new ArtifactRepository(blockedRoot)
    const revoked: string[] = []
    await repository.writePendingFile({
      projectId: 'seed',
      sessionId: 'seed',
      runId: 'seed',
      filename: 'seed.txt',
      source: { kind: 'inline', content: 'seed', encoding: 'utf8' }
    })
    // A file at the configured data root makes the current-run mkdir fail.
    const fileRoot = join(dataRoot, 'root-file')
    await writeFile(fileRoot, 'blocked')
    const failingOwner = new ArtifactTurnOwner({
      dataRoot: fileRoot,
      repository,
      runRegistry: new ArtifactRunRegistry(),
      issueRpcCapability: () => 'failed-open-capability',
      revokeRpcCapability: (token) => {
        revoked.push(token)
      }
    })

    await expect(
      openRootExecution(failingOwner, {
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        projectId: 'project-1',
        agentName: 'Codex'
      })
    ).rejects.toThrow()
    expect(failingOwner.activeRunIds()).toEqual([])
    expect(revoked).toEqual(['failed-open-capability'])
  })
})
