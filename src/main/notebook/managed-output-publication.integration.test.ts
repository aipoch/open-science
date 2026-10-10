import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { createSessionOperationTestHarness } from './session-operation.test-support'
import type { SessionOperationContext, StartSessionOperation } from './session-operation-owner'
import { createManagedShellExecutionCapability } from './managed-shell-execution'
import { createManagedOutputAuthority } from './managed-output-authority'
import {
  createManagedOutputRecoveryAuthority,
  revokeManagedOutputRecoveryAuthority
} from './managed-output-recovery'
import type { ManagedOutputWriteAttempt } from './managed-output-publication'
import type {
  ManagedExecutionProvenance,
  ManagedExecutionRecoveryOutput,
  ManagedExecutionRecoveredOutput
} from './managed-execution-output'
import { createManagedExecutionTurnPort } from './managed-execution-port'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { createRootNotebookLane } from './lane-identity'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const scope = { projectId: 'project-1', sessionId: 'session-1' }
const collectionId = 'a'.repeat(64)
const request = (
  requestId: string,
  execute: StartSessionOperation['execute']
): StartSessionOperation => ({
  ...scope,
  requestId,
  requestFingerprint: 'b'.repeat(64),
  requestText: requestId,
  execute
})

type Original = {
  h: Awaited<ReturnType<typeof createSessionOperationTestHarness>>
  root: string
  producer: NotebookRunRecord
  provenance: ManagedExecutionProvenance
  attempts: ManagedOutputWriteAttempt[]
  savedId: string | undefined
  execute: { mock: { calls: unknown[][] } }
  done: Awaited<
    ReturnType<Awaited<ReturnType<typeof createSessionOperationTestHarness>>['owner']['wait']>
  >
}
async function original(
  mode: 'before-write' | 'after-write' | 'pending-write',
  beforeFinalization?: (fixture: Original, context: SessionOperationContext) => Promise<void>
): Promise<Original> {
  const h = await createSessionOperationTestHarness(cleanups, { canonicalStorageRoot: true })
  if (mode === 'pending-write')
    vi.spyOn(h.artifacts, 'finalizeRun').mockRejectedValueOnce(
      new Error('Finalization interrupted')
    )
  const attempts: ManagedOutputWriteAttempt[] = []
  let root = ''
  let producer!: NotebookRunRecord
  let provenance!: ManagedExecutionProvenance
  let savedId: string | undefined
  const execute = vi.spyOn(h.notebook, 'executeManagedShell')
  await h.owner.start(
    request('original', async (context, signal) => {
      root = join(context.notebookDataDir, 'retained')
      await mkdir(root, { recursive: true })
      provenance = context.provenanceContext as ManagedExecutionProvenance
      const invocation = { ...scope, executionInvocationId: 'managed-inner-original' }
      const capability = createManagedShellExecutionCapability({
        ...invocation,
        cwd: root,
        outputRoot: root,
        environment: {},
        filesystem: { readOnlyRoots: [], readWriteRoots: [root] }
      })
      expect(
        await h.notebook.executeManagedShell(
          {
            ...invocation,
            workspaceCwd: context.workspaceCwd,
            provenanceContext: provenance,
            command: 'printf original > result.txt'
          },
          capability,
          signal
        )
      ).toMatchObject({ exitCode: 0 })
      producer = (
        await h.fixture.notebookRepository.readSessionRuns(scope.projectId, scope.sessionId)
      ).find((run) => run.submissionIdentity === invocation.executionInvocationId)!
      expect(producer).toMatchObject({ status: 'completed', kernelKind: 'bash' })
      expect(producer.workingFiles).toHaveLength(1)
      expect(producer.workingFiles[0].generationId).toBeTruthy()
      await context.recordRun(producer.runId)
      const artifact = await context.saveOutput({
        filename: 'result.txt',
        contentType: 'text/plain',
        producerRunId: producer.runId,
        source: {
          kind: 'managedOutput',
          path: 'result.txt',
          authority: createManagedOutputAuthority({
            ...scope,
            operationId: context.operationId,
            outputRoot: root
          })
        },
        publication: {
          beforeWrite: async (attempt) => {
            expect(Object.isFrozen(attempt)).toBe(true)
            expect(await h.fixture.client.artifactVersion.count()).toBe(0)
            attempts.push(structuredClone(attempt))
            if (mode === 'before-write') throw new Error('Durable journal commit failed')
          }
        }
      })
      savedId = artifact.versionId
      await beforeFinalization?.(
        { h, root, producer, provenance, attempts, savedId, execute, done: undefined },
        context
      )
      throw new Error('Artifact saved; collection ledger response lost')
    })
  )
  const done = await h.owner.wait({ ...scope, requestId: 'original' })
  expect(done).toMatchObject({
    status: mode === 'pending-write' ? 'interrupted' : 'failed',
    notebookRunIds: [producer.runId]
  })
  expect(attempts, JSON.stringify(done)).toHaveLength(1)
  expect(await h.fixture.client.artifactVersion.count()).toBe(mode === 'before-write' ? 0 : 1)
  return { h, root, producer, provenance, attempts, savedId, execute, done }
}
function recoveryOutput(
  fixture: Original,
  context: Pick<SessionOperationContext, 'operationId'>
): ManagedExecutionRecoveryOutput {
  const file = fixture.producer.workingFiles[0]
  return {
    filename: 'result.txt',
    contentType: 'text/plain',
    producerRunId: fixture.producer.runId,
    source: {
      kind: 'managedOutput',
      path: 'result.txt',
      authority: createManagedOutputAuthority({
        ...scope,
        operationId: context.operationId,
        outputRoot: fixture.root
      })
    },
    recoveryAuthority: createManagedOutputRecoveryAuthority({
      ...scope,
      operationId: context.operationId,
      collectionId,
      producerRunId: fixture.producer.runId,
      producerProvenance: fixture.provenance,
      outputs: [
        {
          filename: 'result.txt',
          path: 'result.txt',
          sha256: file.checksum!,
          sizeBytes: file.size!,
          generationId: file.generationId!
        }
      ]
    }),
    publication: {
      previousAttempts: fixture.attempts,
      beforeWrite: async (attempt) => {
        fixture.attempts.push(structuredClone(attempt))
      }
    }
  }
}

it.skipIf(process.platform === 'win32').each(['before-write', 'after-write'] as const)(
  'recovers %s in a later real Session operation without rerunning or reassigning the producer',
  async (mode) => {
    const f = await original(mode)
    // Replay must work after cleanup: the saved Version owns its bytes independently.
    if (mode === 'after-write') await rm(join(f.root, 'result.txt'))
    let result!: ManagedExecutionRecoveredOutput
    await f.h.owner.start(
      request('recover', async (context) => {
        expect(context.provenanceContext.promptMessageId).not.toBe(f.provenance.promptMessageId)
        expect(context.provenanceContext.messageBranchId).toBe(f.provenance.messageBranchId)
        result = await context.recoverOutput(recoveryOutput(f, context))
        return { text: 'Collected the original output without executing the command again.' }
      })
    )
    const done = await f.h.owner.wait({ ...scope, requestId: 'recover' })
    expect(done).toMatchObject({ status: 'completed', notebookRunIds: [] })
    expect(result.reused).toBe(mode === 'after-write')
    expect(result.artifact.producerRunId).toBe(f.producer.runId)
    expect(done!.artifactVersionIds).toEqual(
      mode === 'after-write' ? [] : [result.artifact.versionId]
    )
    expect(result.artifact.runId).toBe(
      mode === 'after-write' ? f.done!.artifactRunId : done!.artifactRunId
    )
    expect(
      await f.h.artifacts.listRunVersions({
        projectId: scope.projectId,
        appSessionId: scope.sessionId,
        artifactRunId: done!.artifactRunId!
      })
    ).toHaveLength(mode === 'after-write' ? 0 : 1)
    if (mode === 'after-write') expect(result.artifact.versionId).toBe(f.savedId)
    expect(f.attempts).toHaveLength(mode === 'after-write' ? 1 : 2)
    expect(await readFile(result.artifact.path, 'utf8')).toBe('original')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(await f.h.fixture.client.artifactVersion.count()).toBe(1)
  },
  30000
)

it.skipIf(process.platform === 'win32')(
  'collects through real Local RPC, ArtifactTurnOwner and storage ancestry in the next ordinary Agent turn',
  async () => {
    const f = await original('before-write')
    let result!: ManagedExecutionRecoveredOutput
    await f.h.owner.start(
      request('rpc-recover', async (outer, signal) => {
        const handle = f.h.artifactTurns.handleForExecution(outer.operationId)
        const artifactRunId = f.h.artifactTurns.snapshot(handle).runId
        const unexpected = async (): Promise<never> => {
          throw new Error('No execution permitted')
        }
        const port = createManagedExecutionTurnPort({
          dataRoot: f.h.fixture.storageRoot,
          artifacts: f.h.artifacts,
          notebooks: f.h.fixture.notebookRepository,
          trackArtifactWrite: (_sessionId, executionId, write) => {
            expect(executionId).toBe(outer.operationId)
            return f.h.artifactTurns.trackWrite(handle, write)
          },
          service: {
            runtimes: unexpected,
            inspectMaterials: unexpected,
            prepare: unexpected,
            getEnvironment: unexpected,
            releaseEnvironment: unexpected,
            discardOutputs: unexpected,
            executeInTurn: unexpected,
            collectOutputsInTurn: async (input, context) => {
              expect(input).toEqual({
                ...scope,
                environmentId: 'c'.repeat(64),
                collectionId,
                requestId: 'rpc-collect'
              })
              expect(context.executionInvocationId).toBe('outer-repl-recovery')
              result = await context.recoverOutput(recoveryOutput(f, context))
              return { versionId: result.artifact.versionId, reused: result.reused }
            }
          }
        })
        const server = new NotebookLocalRpcServer({ execute: vi.fn() } as never, {
          transport: 'tcp',
          managedExecution: port
        })
        cleanups.push(() => server.close())
        const provenance = outer.provenanceContext as ManagedExecutionProvenance
        server.setArtifactTurnBinding(scope.sessionId, {
          projectId: scope.projectId,
          ownerExecutionId: outer.operationId,
          artifactRunId,
          artifactStorageSessionId: scope.sessionId,
          provenanceContext: provenance
        })
        const connection = await server.issueControlConnection(
          scope.sessionId,
          scope.projectId,
          provenance.agentFrameId,
          { role: 'main' },
          outer.workspaceCwd
        )
        const end = connection.beginControlInvocation({
          rootExecutionId: outer.operationId,
          turnId: provenance.promptMessageId,
          toolInvocationId: 'outer-repl-recovery',
          controlInvocationGeneration: 1
        })
        try {
          const response = await fetch(connection.endpoint, {
            method: 'POST',
            signal,
            headers: {
              authorization: `Bearer ${connection.token}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              method: 'managedExecutionCall',
              params: {
                method: 'collectOutputs',
                payload: { environmentId: 'c'.repeat(64), collectionId, requestId: 'rpc-collect' }
              }
            })
          })
          const body = await response.json()
          expect(response.status, JSON.stringify(body)).toBe(200)
        } finally {
          end()
          connection.release()
        }
        return { text: 'Collected the original file through the ordinary Agent tool.' }
      })
    )
    const done = await f.h.owner.wait({ ...scope, requestId: 'rpc-recover' })
    expect(done).toMatchObject({ status: 'completed', notebookRunIds: [] })
    expect(result).toMatchObject({
      reused: false,
      artifact: { producerRunId: f.producer.runId, runId: done!.artifactRunId }
    })
    expect(await f.h.fixture.client.artifactVersion.count()).toBe(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
  },
  30000
)

it
  .skipIf(process.platform === 'win32')
  .each(['changed-bytes', 'revoked', 'wrong-intent', 'journal-failure'] as const)(
  'rejects recovery with %s before publishing any Version',
  async (failure) => {
    const f = await original('before-write')
    if (failure === 'changed-bytes') await writeFile(join(f.root, 'result.txt'), 'modified')
    await f.h.owner.start(
      request('invalid-recover', async (context) => {
        const output = recoveryOutput(f, context)
        if (failure === 'revoked') revokeManagedOutputRecoveryAuthority(output.recoveryAuthority)
        if (failure === 'wrong-intent')
          output.publication.previousAttempts = [
            {
              ...f.attempts[0],
              request: { ...f.attempts[0].request, appSessionId: 'another-session' }
            }
          ]
        if (failure === 'journal-failure')
          output.publication = {
            previousAttempts: f.attempts,
            beforeWrite: async () => {
              throw new Error('Journal unavailable')
            }
          }
        await expect(context.recoverOutput(output)).rejects.toThrow(
          failure === 'changed-bytes'
            ? 'generation'
            : failure === 'revoked'
              ? 'ended'
              : failure === 'wrong-intent'
                ? 'intent'
                : 'Journal unavailable'
        )
        return { text: 'Expected rejection' }
      })
    )
    expect(await f.h.owner.wait({ ...scope, requestId: 'invalid-recover' })).toMatchObject({
      status: 'failed',
      artifactVersionIds: []
    })
    expect(await f.h.fixture.client.artifactVersion.count()).toBe(0)
    expect(f.execute).toHaveBeenCalledTimes(1)
  },
  30000
)

it.skipIf(process.platform === 'win32')(
  'keeps the default current-turn producer guard for normal writes',
  async () => {
    const f = await original('before-write')
    await f.h.owner.start(
      request('ordinary-save', async (context) => {
        await expect(context.recordRun(f.producer.runId)).rejects.toThrow('does not belong')
        const output = recoveryOutput(f, context)
        await expect(
          context.saveOutput({
            filename: output.filename,
            contentType: output.contentType,
            producerRunId: output.producerRunId,
            source: output.source
          })
        ).rejects.toThrow('does not belong')
        return { text: 'Expected normal write rejection' }
      })
    )
    expect(await f.h.owner.wait({ ...scope, requestId: 'ordinary-save' })).toMatchObject({
      status: 'failed',
      artifactVersionIds: []
    })
    expect(await f.h.fixture.client.artifactVersion.count()).toBe(0)
  },
  30000
)

it.skipIf(process.platform === 'win32')(
  'revocation after save entry aborts the actual Artifact repository write',
  async () => {
    const f = await original('before-write')
    const save = f.h.artifacts.saveVersion.bind(f.h.artifacts)
    let entered!: () => void
    let proceed!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      proceed = resolve
    })
    vi.spyOn(f.h.artifacts, 'saveVersion').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      expect(args[2]?.aborted).toBe(true)
      return save(...args)
    })
    await f.h.owner.start(
      request('revoke-during-save', async (context) => {
        const output = recoveryOutput(f, context)
        const pending = context.recoverOutput(output)
        await started
        revokeManagedOutputRecoveryAuthority(output.recoveryAuthority)
        proceed()
        await expect(pending).rejects.toThrow('ended')
        return { text: 'Expected abort' }
      })
    )
    expect(await f.h.owner.wait({ ...scope, requestId: 'revoke-during-save' })).toMatchObject({
      status: 'failed',
      artifactVersionIds: []
    })
    expect(await f.h.fixture.client.artifactVersion.count()).toBe(0)
  },
  30000
)

it.skipIf(process.platform === 'win32')(
  'rejects a same-size change after the durable write intent, before any pending Version exists',
  async () => {
    const f = await original('before-write')
    await f.h.owner.start(
      request('race-during-publication', async (context) => {
        const output = recoveryOutput(f, context)
        output.publication = {
          previousAttempts: f.attempts,
          beforeWrite: async (attempt) => {
            f.attempts.push(structuredClone(attempt))
            await writeFile(join(f.root, 'result.txt'), 'modified')
          }
        }
        await expect(context.recoverOutput(output)).rejects.toThrow('expected')
        return { text: 'Expected changed-byte rejection' }
      })
    )
    expect(await f.h.owner.wait({ ...scope, requestId: 'race-during-publication' })).toMatchObject({
      status: 'failed',
      artifactVersionIds: []
    })
    expect(await f.h.fixture.client.artifactVersion.count()).toBe(0)
    expect(f.execute).toHaveBeenCalledTimes(1)
  },
  30000
)

it.skipIf(process.platform === 'win32')(
  'reconciles an old pending Version under its original turn before replaying it into a new collection ledger',
  async () => {
    const f = await original('pending-write')
    const saved = await f.h.fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: f.savedId! }
    })
    expect(saved.state).toBe('pending')
    expect(f.done).toMatchObject({ status: 'interrupted', recoveryPending: true })
    const restarted = f.h.restartedOwner()
    cleanups.push(() => restarted.close())
    await restarted.recover()
    expect(await restarted.get({ ...scope, requestId: 'original' })).toMatchObject({
      recoveryPending: false
    })
    expect(f.h.retryArtifactFinalization).toHaveBeenCalledTimes(1)
    let result!: ManagedExecutionRecoveredOutput
    await restarted.start(
      request('recover-after-reconciliation', async (context) => {
        result = await context.recoverOutput(recoveryOutput(f, context))
        return { text: 'Original Version recovered.' }
      })
    )
    const next = await restarted.wait({ ...scope, requestId: 'recover-after-reconciliation' })
    expect(next).toMatchObject({ status: 'completed', notebookRunIds: [], artifactVersionIds: [] })
    expect(result).toMatchObject({
      reused: true,
      artifact: {
        versionId: f.savedId,
        runId: f.done!.artifactRunId,
        producerRunId: f.producer.runId
      }
    })
    const final = await f.h.fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: f.savedId! }
    })
    expect(final.state).toBe('finalized')
    expect(final.artifactRunId).toBe(f.done!.artifactRunId)
    expect(final.managedVisibleAt).not.toBeNull()
    expect(f.execute).toHaveBeenCalledTimes(1)
  },
  30000
)

it
  .skipIf(process.platform === 'win32')
  .each(['different-branch', 'non-ancestor', 'different-generation', 'duplicate-owner'] as const)(
  'retains ancestry, generation and unique producer checks for %s recovery',
  async (failure) => {
    const f = await original('before-write')
    if (failure === 'different-branch')
      f.provenance = { ...f.provenance, messageBranchId: 'other-branch' }
    if (failure === 'non-ancestor')
      f.provenance = { ...f.provenance, promptMessageId: 'unrelated-prompt' }
    if (failure === 'different-generation')
      f.producer.workingFiles[0].generationId = 'nonexistent-generation'
    if (failure === 'duplicate-owner') {
      // A persisted legacy duplicate is intentionally left ambiguous: recovery must never waive
      // Artifact's unique-owner rule, even with a valid Main grant for the original producer.
      const duplicateId = 'legacy-duplicate-run'
      await f.h.fixture.notebookRepository.appendRun({
        ...scope,
        lane: createRootNotebookLane(scope.projectId, scope.sessionId, f.provenance.agentFrameId),
        run: {
          ...f.producer,
          runId: duplicateId,
          cellId: 'legacy-duplicate-cell',
          fileEvidence: undefined,
          workingFiles: f.producer.workingFiles.map((file) => ({
            ...file,
            createdByRunId: duplicateId,
            generationId: 'legacy-duplicate-generation'
          }))
        }
      })
    }
    await f.h.owner.start(
      request('invalid-proof', async (context) => {
        await expect(context.recoverOutput(recoveryOutput(f, context))).rejects.toThrow(
          failure === 'duplicate-owner'
            ? 'exactly one Run owner'
            : failure === 'different-generation'
              ? 'generation'
              : 'ancestor'
        )
        return { text: 'Expected evidence rejection' }
      })
    )
    expect(await f.h.owner.wait({ ...scope, requestId: 'invalid-proof' })).toMatchObject({
      status: 'failed',
      artifactVersionIds: []
    })
    expect(await f.h.fixture.client.artifactVersion.count()).toBe(0)
    expect(f.execute).toHaveBeenCalledTimes(1)
  },
  30000
)

it.skipIf(process.platform === 'win32')(
  'refuses a real pending Version without a finalization marker, then reuses it only after the original owner publishes',
  async () => {
    let rejectedPending = false
    const f = await original('after-write', async (pending, context) => {
      const version = await pending.h.fixture.client.artifactVersion.findUniqueOrThrow({
        where: { id: pending.savedId! }
      })
      expect(version.state).toBe('pending')
      expect(version.managedVisibleAt).toBeNull()
      expect(
        await pending.h.fixture.compatibilityRepository.findRunFinalizationMarker(
          scope.projectId,
          version.artifactRunId!
        )
      ).toBeUndefined()
      const attemptsBefore = pending.attempts.length
      await expect(context.recoverOutput(recoveryOutput(pending, context))).rejects.toThrow(
        'not yet published by its original turn'
      )
      expect(pending.attempts).toHaveLength(attemptsBefore)
      expect(await pending.h.fixture.client.artifactVersion.count()).toBe(1)
      rejectedPending = true
    })
    expect(rejectedPending).toBe(true)
    const published = await f.h.fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: f.savedId! }
    })
    expect(published.state).toBe('finalized')
    expect(published.managedVisibleAt).not.toBeNull()
    expect(
      await f.h.fixture.compatibilityRepository.findRunFinalizationMarker(
        scope.projectId,
        published.artifactRunId!
      )
    ).toBeDefined()
    let result!: ManagedExecutionRecoveredOutput
    await f.h.owner.start(
      request('retry-published', async (context) => {
        result = await context.recoverOutput(recoveryOutput(f, context))
        return { text: 'The original owner has now published this Version.' }
      })
    )
    expect(await f.h.owner.wait({ ...scope, requestId: 'retry-published' })).toMatchObject({
      status: 'completed',
      artifactVersionIds: [],
      notebookRunIds: []
    })
    expect(result).toMatchObject({
      reused: true,
      artifact: { versionId: f.savedId, runId: f.done!.artifactRunId, isPublished: true }
    })
    expect(f.execute).toHaveBeenCalledTimes(1)
  },
  30000
)

const { configureTestElectronHost } = await import('../../../test/runtime-host')
await configureTestElectronHost(await import('electron'))
