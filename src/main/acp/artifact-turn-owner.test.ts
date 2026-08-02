import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../shared/artifacts'
import { ArtifactRepository, getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { ArtifactTurnOwner } from './artifact-turn-owner'

const roots: string[] = []

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
  projectName: 'project-1',
  sessionId: 'artifact-session-1',
  runId: 'artifact-run-1',
  versionId: 'version-1',
  ...overrides
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ArtifactTurnOwner', () => {
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
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => notebookContexts.push(context)
      }
    })

    const turn = await owner.open({
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
    expect(owner.promptMessageIdFor('session-1')).toBe('prompt-1')
    expect(issuedBindings).toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-123-1',
        notebookSessionId: 'session-1',
        allowedMethods: ['artifactCreateVersion', 'artifactReplayVersion']
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
      notebookDataDir: join(dataRoot, 'notebooks', 'project-1', 'session-1', 'data'),
      notebookSessionRoot: join(dataRoot, 'notebooks', 'project-1', 'session-1')
    })

    const snapshot = owner.snapshot(turn)
    expect(snapshot).toEqual({
      appSessionId: 'session-1',
      runId: 'artifact-run-123-1',
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

    await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    await owner.open({
      appSessionId: 'session-2',
      artifactStorageSessionId: 'artifact-session-2',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    const first = await owner.writeForActiveTurn('session-1', {
      filename: 'first.txt',
      content: 'first'
    })
    const second = await owner.writeForActiveTurn('session-2', {
      filename: 'second.txt',
      content: 'second'
    })

    expect(first.sessionId).toBe('artifact-session-1')
    expect(second.sessionId).toBe('artifact-session-2')
    expect(first.runId).not.toBe(second.runId)
    await expect(
      owner.writeForActiveTurn('unknown-session', { filename: 'x.txt', content: 'x' })
    ).rejects.toThrow(/No active assistant turn/i)
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
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'OpenCode'
    })
    const acceptedWrite = owner.writeForActiveTurn('session-1', {
      filename: 'result.txt',
      content: 'result'
    })
    await writeStarted.promise

    const firstFinalization = owner.finalize(turn)
    const repeatedFinalization = owner.finalize(turn)
    expect(firstFinalization).toBe(repeatedFinalization)
    await expect(
      owner.writeForActiveTurn('session-1', { filename: 'late.txt', content: 'late' })
    ).rejects.toThrow(/No active assistant turn/i)
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
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Claude Code'
    })

    await expect(owner.finalize(turn)).resolves.toBeUndefined()
    await expect(owner.finalize(turn)).resolves.toBeUndefined()
    expect(listPendingRunFiles).toHaveBeenCalledOnce()
    expect(register).not.toHaveBeenCalled()
    expect(owner.snapshot(turn)).toEqual({
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
      notebook: {
        setArtifactProvenanceContext: (sessionId, context) => {
          notebookContexts.push({ sessionId, context })
        }
      }
    })
    const first = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    now = 1_001
    const replacement = await owner.open({
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
    const first = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })

    const staleDisposal = owner.dispose(first)
    await cleanupWriteStarted.promise
    const replacementOpening = owner.open({
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

  it('clears active ownership even when capability revocation fails', async () => {
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
      revokeRpcCapability: async () => {
        throw new Error('revoke failed')
      },
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => notebookContexts.push(context)
      }
    })
    const turn = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const acceptedWrite = owner.writeForActiveTurn('session-1', {
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
    expect(owner.activeRunIds()).toEqual([])
    await expect(readFile(currentRunFile, 'utf8')).resolves.toBe('{}\n')
    expect(notebookContexts.at(-1)).toBeUndefined()
  })

  it('clears a stale turn handoff when its replacement uses a different storage Session', async () => {
    const dataRoot = await createRoot()
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry()
    })
    const first = await owner.open({
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-provisional',
      projectId: 'project-1',
      agentName: 'Codex'
    })
    const replacement = await owner.open({
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
    const turn = await owner.open({
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
    const turn = await owner.open({
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

    const disposedWithoutFinalization = await owner.open({
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
      owner.open({
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

  it('clears Notebook context and ownership when handoff cleanup fails', async () => {
    const dataRoot = await createRoot()
    const contexts: unknown[] = []
    const owner = new ArtifactTurnOwner({
      dataRoot,
      repository: new ArtifactRepository(dataRoot),
      runRegistry: new ArtifactRunRegistry(),
      notebook: {
        setArtifactProvenanceContext: (_sessionId, context) => contexts.push(context)
      }
    })
    const turn = await owner.open({
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

    await expect(owner.dispose(turn)).rejects.toThrow()

    expect(contexts.at(-1)).toBeUndefined()
    expect(owner.activeRunIds()).toEqual([])
    expect(owner.snapshot(turn).phase).toBe('disposed')
  })

  it('revokes a capability and publishes no active state when opening the handoff fails', async () => {
    const dataRoot = await createRoot()
    const blockedRoot = join(dataRoot, 'blocked')
    const repository = new ArtifactRepository(blockedRoot)
    const revoked: string[] = []
    await repository.writePendingFile({
      projectName: 'seed',
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
      failingOwner.open({
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
