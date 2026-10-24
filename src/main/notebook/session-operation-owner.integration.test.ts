import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { ManagedExecutionService } from './managed-execution-service'
import { ManagedResearchEnvironmentOwner } from './managed-research-environment'
import { getNotebookDataRoot } from './repository'
import { afterEach, expect, it, vi } from 'vitest'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { SessionPackageService } from '../session-package/service'
import { SessionRepository } from '../session-persistence/repository'
import { createManagedExecutionTurnPort } from './managed-execution-port'
import {
  createManagedOutputAuthority,
  revokeManagedOutputAuthority
} from './managed-output-authority'
import { type SessionOperationContext, type StartSessionOperation } from './session-operation-owner'
import { createSessionOperationTestHarness } from './session-operation.test-support'

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
const scope = { projectId: 'project-1', sessionId: 'session-1', requestId: 'request-1' }
const fingerprint = 'a'.repeat(64)

const harness = (): ReturnType<typeof createSessionOperationTestHarness> =>
  createSessionOperationTestHarness(cleanups)

function request(
  execute: (context: SessionOperationContext, signal: AbortSignal) => Promise<{ text: string }>
): StartSessionOperation {
  return {
    ...scope,
    requestFingerprint: fingerprint,
    requestText: 'Execute a local, zero-model engineering check.',
    execute
  }
}

it.skipIf(process.platform === 'win32')(
  'publishes real Shell output under the actual request and roundtrips its evidence through .science',
  async () => {
    const h = await harness()
    let actualRunId = ''
    const execute = vi.fn(async (context: SessionOperationContext, signal: AbortSignal) => {
      const result = await h.notebook.executeShell(
        {
          ...scope,
          workspaceCwd: context.workspaceCwd,
          provenanceContext: context.provenanceContext,
          executionInvocationId: context.operationId,
          command: 'printf "value\\n42\\n" > result.csv'
        },
        signal
      )
      expect(result.exitCode).toBe(0)
      const runs = await h.fixture.notebookRepository.readSessionRuns(
        scope.projectId,
        scope.sessionId
      )
      const run = runs.find((item) => item.submissionIdentity === context.operationId)!
      expect(run.status).toBe('completed')
      actualRunId = run.runId
      await context.recordRun(run.runId)
      await context.saveOutput({
        filename: 'result.csv',
        contentType: 'text/csv',
        producerRunId: run.runId,
        source: { kind: 'localPath', path: 'result.csv' }
      })
      return { text: 'The real local check produced value 42.' }
    })
    const admitted = await h.owner.start(request(execute))
    const done = await h.owner.wait(scope)
    expect(done, JSON.stringify(done)).toMatchObject({
      status: 'completed',
      notebookRunIds: [actualRunId]
    })
    expect(done!.artifactVersionIds).toHaveLength(1)
    expect(h.kernelExecute).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await h.owner.start(request(execute))).toMatchObject({
      operationId: admitted.operationId,
      status: 'completed'
    })
    expect(execute).toHaveBeenCalledTimes(1)
    const session = (await h.read(scope))!
    expect(session.activeRun).toBeUndefined()
    expect(
      session.messages.some(
        ({ role, content }) => role === 'user' && content === request(execute).requestText
      )
    ).toBe(true)
    expect(session.messages.some(({ content }) => content.includes('value 42'))).toBe(true)
    const attached = session.artifacts ?? []
    expect(attached.map(({ versionId }) => versionId)).toContain(done!.artifactVersionIds[0])
    await h.snapshots.captureFinalizedMessages(session)
    const exporter = new SessionPackageService({
      storageRoot: h.fixture.storageRoot,
      getClient: async () => h.fixture.client
    })
    cleanups.push(() => exporter.close())
    const archive = join(h.fixture.storageRoot, 'real-operation.science')
    await exporter.exportTo({ projectId: scope.projectId, sessionId: scope.sessionId }, archive)
    const target = await createProvenanceTestFixture()
    cleanups.push(target.dispose)
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    cleanups.push(() => importer.close())
    const imported = await importer.importFrom(archive)
    const origin = await importer.readOrigin(imported)
    const version = await target.client.artifactVersion.findUniqueOrThrow({
      where: { id: origin.identities[done!.artifactVersionIds[0]] }
    })
    expect(await readFile(join(target.storageRoot, version.contentStorageKey), 'utf8')).toBe(
      'value\n42\n'
    )
    const importedSession = await new SessionRepository(target.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    )
    expect(importedSession?.messages.some(({ content }) => content.includes('value 42'))).toBe(true)
    const importedRuns = (
      await target.notebookRepository.readSessionDocuments(imported.projectId, imported.sessionId)
    ).flatMap(({ runs }) => runs)
    expect(importedRuns).toHaveLength(1)
    expect(importedRuns[0]).toMatchObject({
      runId: origin.identities[actualRunId],
      status: 'completed',
      script: 'printf "value\\n42\\n" > result.csv'
    })
    expect(execute).toHaveBeenCalledTimes(1)
  },
  30000
)

it('rejects readonly and busy Sessions before any execution', async () => {
  const h = await harness()
  const execute = vi.fn(async () => ({ text: 'Done' }))
  await h.mutate(scope, (session) => ({ ...session, archivedAt: 123 }))
  await expect(h.owner.start(request(execute))).rejects.toThrow('Archived')
  await h.mutate(scope, (session) => ({ ...session, archivedAt: undefined, status: 'running' }))
  await expect(h.owner.start(request(execute))).rejects.toThrow('unsettled')
  await h.mutate(scope, (session) => ({ ...session, status: 'idle' }))
  await mkdir(
    join(h.fixture.storageRoot, 'artifacts', scope.projectId, scope.sessionId, '.session-package'),
    { recursive: true }
  )
  await expect(h.owner.start(request(execute))).rejects.toThrow('read-only')
  expect(execute).not.toHaveBeenCalled()
})

it('deduplicates simultaneous admission and records cancellation only after execution settles', async () => {
  const h = await harness()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const execute = vi.fn(async (_context: SessionOperationContext, signal: AbortSignal) => {
    await gate
    signal.throwIfAborted()
    return { text: 'unexpected' }
  })
  const [first, retry] = await Promise.all([
    h.owner.start(request(execute)),
    h.owner.start(request(execute))
  ])
  expect(first.operationId).toBe(retry.operationId)
  await expect(
    h.owner.start({ ...request(execute), requestFingerprint: 'b'.repeat(64) })
  ).rejects.toThrow('different request')
  expect(await h.owner.cancel(scope)).toMatchObject({ status: 'cancelling' })
  release()
  expect(await h.owner.wait(scope)).toMatchObject({ status: 'cancelled' })
  expect(execute).toHaveBeenCalledTimes(1)
  expect((await h.read(scope))!.activeRun).toBeUndefined()
})

it('uses a normal fork without changing its origin or starting any model', async () => {
  const h = await harness()
  const forkOrigin = {
    importId: 'copy',
    sourceProjectId: 'source-project',
    sourceSessionId: 'source-session',
    importedAt: 2,
    manifestChecksum: 'a'.repeat(64)
  }
  await h.mutate(scope, (session) => ({ ...session, forkOrigin }))
  await h.owner.start(request(async () => ({ text: 'Inspected local materials.' })))
  expect(await h.owner.wait(scope)).toMatchObject({ status: 'completed' })
  expect((await h.read(scope))?.forkOrigin).toEqual(forkOrigin)
  expect(h.kernelExecute).not.toHaveBeenCalled()
})

it.each(['before-owner-begin', 'after-session-write'] as const)(
  'recovers admission %s without executing the callback',
  async (stage) => {
    const h = await harness()
    if (stage === 'before-owner-begin')
      vi.spyOn(h.runtimeSessions, 'begin').mockRejectedValueOnce(new Error('Admission interrupted'))
    else {
      const mutate = h.dependencies.sessions.mutate
      vi.spyOn(h.dependencies.sessions, 'mutate').mockImplementationOnce(async (...args) => {
        await mutate(...args)
        throw new Error('Admission interrupted')
      })
    }
    const execute = vi.fn(async () => ({ text: 'Must not execute' }))
    await expect(h.owner.start(request(execute))).rejects.toThrow('Admission interrupted')
    expect((await h.read(scope))?.activeRun).toBeDefined()
    const restarted = h.restartedOwner()
    cleanups.push(() => restarted.close())
    await restarted.recover()
    await restarted.recover()
    expect(await restarted.get(scope)).toMatchObject({
      status: 'interrupted',
      recoveryPending: false
    })
    expect((await h.read(scope))?.activeRun).toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
    expect(await restarted.start(request(execute))).toMatchObject({ status: 'interrupted' })
    expect(execute).not.toHaveBeenCalled()
  }
)

it.each(['before-native-finalization', 'after-native-activation'] as const)(
  'recovers %s using the existing reconciliation owner and never repeats execution',
  async (stage) => {
    const h = await harness()
    if (stage === 'before-native-finalization')
      vi.spyOn(h.artifacts, 'finalizeRun').mockRejectedValueOnce(
        new Error('Finalization interrupted')
      )
    else {
      const activate = h.artifacts.activateFinalizedRun.bind(h.artifacts)
      vi.spyOn(h.artifacts, 'activateFinalizedRun').mockImplementationOnce(async (input) => {
        await activate(input)
        throw new Error('Activation response interrupted')
      })
    }
    const execute = vi.fn(async (context: SessionOperationContext) => {
      await context.saveOutput({
        filename: 'report.json',
        source: { kind: 'inline', content: '{"check":"actual application report"}' }
      })
      return { text: 'A report was produced.' }
    })
    await h.owner.start(request(execute))
    const interrupted = await h.owner.wait(scope)
    expect(interrupted, JSON.stringify(interrupted)).toMatchObject({
      status: 'interrupted',
      recoveryPending: true
    })
    const restarted = h.restartedOwner()
    cleanups.push(() => restarted.close())
    await restarted.recover()
    const recovered = await restarted.get(scope)
    expect(recovered, JSON.stringify(recovered)).toMatchObject({
      status: 'interrupted',
      recoveryPending: false
    })
    expect(h.retryArtifactFinalization).toHaveBeenCalledTimes(1)
    const version = await h.fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: recovered!.artifactVersionIds[0] }
    })
    expect(version.state).toBe('finalized')
    expect(version.managedVisibleAt).not.toBeNull()
    const session = (await h.read(scope))!
    expect(session.activeRun).toBeUndefined()
    expect(session.artifacts?.map(({ versionId }) => versionId)).toContain(version.id)
    const owner = session.messages.find(({ artifactIds }) => artifactIds?.includes(version.id))
    expect(owner?.content).toBe('A report was produced.')
    await restarted.recover()
    expect(h.retryArtifactFinalization).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  }
)

it('accepts an environment-owned output only through its live capability', async () => {
  const h = await harness()
  const outputRoot = join(h.fixture.storageRoot, 'environment-output')
  await mkdir(outputRoot)
  await writeFile(join(outputRoot, 'report.json'), '{"environment":"managed"}')
  let context!: SessionOperationContext
  await h.owner.start(
    request(async (value) => {
      context = value
      const authority = createManagedOutputAuthority({
        ...scope,
        operationId: value.operationId,
        outputRoot: await realpath(outputRoot)
      })
      try {
        await value.saveOutput({
          filename: 'report.json',
          source: { kind: 'managedOutput', path: 'report.json', authority }
        })
      } finally {
        revokeManagedOutputAuthority(authority)
      }
      return { text: 'Saved the managed output.' }
    })
  )
  expect(await h.owner.wait(scope)).toMatchObject({ status: 'completed' })
  await expect(
    context.saveOutput({ filename: 'late.txt', source: { kind: 'inline', content: 'late' } })
  ).rejects.toThrow('already settled')
  expect(await h.fixture.client.artifactVersion.count()).toBe(1)
})

it('rejects cross-operation Run attribution and host paths without publishing success', async () => {
  const h = await harness()
  await h.owner.start(
    request(async (context) => {
      await context.recordRun('foreign-run')
      return { text: 'Must not succeed' }
    })
  )
  expect(await h.owner.wait(scope)).toMatchObject({
    status: 'failed',
    error: 'Notebook Run does not belong to this Session operation.'
  })
  await h.owner.start({
    ...request(async (context) => {
      await context.saveOutput({
        filename: 'secret.txt',
        source: { kind: 'localPath', path: '/etc/passwd' }
      })
      return { text: 'Must not succeed' }
    }),
    requestId: 'unsafe-path'
  })
  expect(await h.owner.wait({ ...scope, requestId: 'unsafe-path' })).toMatchObject({
    status: 'failed',
    error: 'Artifact output must use a managed relative path.'
  })
  expect(await h.fixture.client.artifactVersion.count()).toBe(0)
})

it('keeps unprepared Artifact evidence blocked instead of inventing a finalization proof', async () => {
  const h = await harness()
  vi.spyOn(h.artifactTurns, 'finalize').mockRejectedValueOnce(
    new Error('Interrupted before claim preparation')
  )
  const execute = vi.fn(async (context: SessionOperationContext) => {
    await context.saveOutput({
      filename: 'unsealed.txt',
      source: { kind: 'inline', content: 'Retain this evidence.' }
    })
    return { text: 'The application produced a file.' }
  })
  await h.owner.start(request(execute))
  const interrupted = await h.owner.wait(scope)
  expect(interrupted).toMatchObject({ status: 'interrupted', recoveryPending: true })
  const restarted = h.restartedOwner()
  cleanups.push(() => restarted.close())
  await restarted.recover()
  expect(await restarted.get(scope)).toMatchObject({ status: 'interrupted', recoveryPending: true })
  await expect(restarted.start({ ...request(execute), requestId: 'later' })).rejects.toThrow(
    'unsettled managed operation'
  )
  expect(execute).toHaveBeenCalledTimes(1)
  const version = await h.fixture.client.artifactVersion.findUniqueOrThrow({
    where: { id: interrupted!.artifactVersionIds[0] }
  })
  expect(version.state).toBe('pending')
  expect(await readFile(join(h.fixture.storageRoot, version.contentStorageKey), 'utf8')).toBe(
    'Retain this evidence.'
  )
})

it('drains admitted output writes and observes lease revocation before calling execution complete', async () => {
  const h = await harness()
  const outputRoot = await realpath(h.fixture.storageRoot)
  await writeFile(join(outputRoot, 'report.json'), '{"private":"not-published"}')
  let inWrite!: () => void
  const entered = new Promise<void>((resolve) => {
    inWrite = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const save = h.artifacts.saveVersion.bind(h.artifacts)
  vi.spyOn(h.artifacts, 'saveVersion').mockImplementationOnce(async (...args) => {
    inWrite()
    await gate
    return save(...args)
  })
  let authority!: ReturnType<typeof createManagedOutputAuthority>
  await h.owner.start(
    request(async (context) => {
      authority = createManagedOutputAuthority({
        ...scope,
        operationId: context.operationId,
        outputRoot
      })
      // Deliberately unawaited: the operation owner must retain and settle admitted output work.
      void context.saveOutput({
        filename: 'report.json',
        source: { kind: 'managedOutput', path: 'report.json', authority }
      })
      return { text: 'Should not claim publication success.' }
    })
  )
  await entered
  expect(await h.owner.get(scope)).toMatchObject({ status: 'running' })
  revokeManagedOutputAuthority(authority)
  release()
  expect(await h.owner.wait(scope)).toMatchObject({ status: 'failed' })
  expect(await h.fixture.client.artifactVersion.count()).toBe(0)
})

it('waits for a pending admission when cancellation races the start response', async () => {
  const h = await harness()
  let reserve!: () => void
  const gate = new Promise<void>((resolve) => {
    reserve = resolve
  })
  vi.spyOn(h.dependencies, 'reserveSession').mockImplementationOnce(async () => {
    await gate
    return () => undefined
  })
  let settle!: () => void
  const execution = new Promise<void>((resolve) => {
    settle = resolve
  })
  const start = h.owner.start(
    request(async (_context, signal) => {
      await execution
      signal.throwIfAborted()
      return { text: 'late' }
    })
  )
  const cancel = h.owner.cancel(scope)
  reserve()
  await start
  expect(await cancel).toMatchObject({ status: 'cancelling' })
  settle()
  expect(await h.owner.wait(scope)).toMatchObject({ status: 'cancelled' })
})

it('admits only one concurrent distinct request and does not strand the rejected request', async () => {
  const h = await harness()
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const execute = vi.fn(async () => {
    await gate
    return { text: 'Only one operation ran.' }
  })
  const attempts = await Promise.allSettled([
    h.owner.start(request(execute)),
    h.owner.start({ ...request(execute), requestId: 'request-2' })
  ])
  expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  finish()
  await Promise.all([h.owner.wait(scope), h.owner.wait({ ...scope, requestId: 'request-2' })])
  expect(execute).toHaveBeenCalledTimes(1)
  await h.owner.start({
    ...request(async () => ({ text: 'Next operation is available.' })),
    requestId: 'request-3'
  })
  expect(await h.owner.wait({ ...scope, requestId: 'request-3' })).toMatchObject({
    status: 'completed'
  })
})

it('records a rejected promise without an Error value as failure, not successful completion', async () => {
  const h = await harness()
  await h.owner.start(request(async () => Promise.reject(undefined)))
  expect(await h.owner.wait(scope)).toMatchObject({
    status: 'failed',
    resultText: 'Managed operation failed.'
  })
  expect((await h.read(scope))?.activeRun).toBeUndefined()
})

it.skipIf(process.platform === 'win32')(
  'keeps terminal cancelled Run outputs publishable while preserving cancellation',
  async () => {
    const h = await harness()
    let outputDirectory = ''
    const admitted = await h.owner.start(
      request(async (context, signal) => {
        outputDirectory = context.notebookDataDir
        try {
          await h.notebook.executeShell(
            {
              ...scope,
              workspaceCwd: context.workspaceCwd,
              provenanceContext: context.provenanceContext,
              executionInvocationId: context.operationId,
              command: 'printf "partial result" > partial.txt; while :; do sleep 1; done'
            },
            signal
          )
        } catch {
          /* Stopped execution can still have durable, terminal evidence. */
        }
        const run = (
          await h.fixture.notebookRepository.readSessionRuns(scope.projectId, scope.sessionId)
        ).find((item) => item.submissionIdentity === context.operationId)!
        expect(run.status).toBe('cancelled')
        await context.recordRun(run.runId)
        await context.saveOutput({
          filename: 'partial.txt',
          source: { kind: 'localPath', path: 'partial.txt' },
          producerRunId: run.runId
        })
        return { text: 'Partial result retained.' }
      })
    )
    await vi.waitFor(async () => {
      expect(outputDirectory).not.toBe('')
      expect(await readFile(join(outputDirectory, 'partial.txt'), 'utf8')).toBe('partial result')
    })
    await h.owner.cancel(scope)
    const done = await h.owner.wait(scope)
    expect(done).toMatchObject({ operationId: admitted.operationId, status: 'cancelled' })
    expect(done!.artifactVersionIds).toHaveLength(1)
    const session = (await h.read(scope))!
    expect(session.activeRun).toBeUndefined()
    expect(session.artifacts).toHaveLength(1)
    expect(await readFile(session.artifacts![0].path, 'utf8')).toBe('partial result')
  }
)

it('cancels an admission before durable Session mutation when its runtime reservation is revoked', async () => {
  const h = await harness()
  const execute = vi.fn(async () => ({ text: 'never' }))
  h.dependencies.reserveSession = async (_scope, onCancel) => {
    onCancel?.()
    return () => undefined
  }
  await expect(h.owner.start(request(execute))).rejects.toThrow('admission was cancelled')
  expect(execute).not.toHaveBeenCalled()
  expect((await h.read(scope))!.messages).toEqual([])
  expect(await h.owner.get(scope)).toBeUndefined()
})

it('quiesces active work and permits later operations without reopening the owner', async () => {
  const h = await harness()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  await h.owner.start(
    request(async (_context, signal) => {
      entered()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
      signal.throwIfAborted()
      return { text: 'never' }
    })
  )
  await started
  await h.owner.quiesce()
  const cancelled = await h.owner.get(scope)
  expect(cancelled).toMatchObject({ status: 'cancelled' })
  const before = (await h.read(scope))!
  expect(before.resumeRecovery?.cause).toBe('cancelled')
  const outcome = before.conversationGraph!.messages.find(
    ({ id }) => id === cancelled!.provenance!.promptMessageId
  )!.turnOutcome
  expect(outcome).toMatchObject({ kind: 'cancelled', recovery: 'resume' })
  const second = { ...request(async () => ({ text: 'new operation' })), requestId: 'after-quiesce' }
  await h.owner.start(second)
  expect(await h.owner.wait({ ...scope, requestId: second.requestId })).toMatchObject({
    status: 'completed'
  })
  const after = (await h.read(scope))!
  expect(after.status).toBe('idle')
  expect(after.resumeRecovery).toBeUndefined()
  for (const messages of [after.messages, after.conversationGraph!.messages]) {
    expect(
      messages.find(({ id }) => id === cancelled!.provenance!.promptMessageId)?.turnOutcome
    ).toEqual(outcome)
  }
})

it.skipIf(process.platform === 'win32').each(['ordinary', 'fork'])(
  'publishes two native managed requests into the same %s turn without creating more requests or Artifact runs',
  async (kind) => {
    const h = await harness()
    if (kind === 'fork')
      await h.mutate(scope, (session) => ({
        ...session,
        forkOrigin: {
          importId: 'copy',
          sourceSessionId: 'original',
          sourceProjectId: scope.projectId,
          importedAt: 1,
          manifestChecksum: 'a'.repeat(64)
        }
      }))
    const versions: string[] = []
    const artifactRuns = new Set<string>()
    await h.owner.start(
      request(async (outer, signal) => {
        const handle = h.artifactTurns.handleForExecution(outer.operationId)
        const artifactRunId = h.artifactTurns.snapshot(handle).runId
        const port = createManagedExecutionTurnPort({
          dataRoot: h.fixture.storageRoot,
          artifacts: h.artifacts,
          notebooks: h.fixture.notebookRepository,
          trackArtifactWrite: (sessionId, executionId, write) => {
            expect(sessionId).toBe(scope.sessionId)
            expect(executionId).toBe(outer.operationId)
            return h.artifactTurns.trackWrite(handle, write)
          },
          service: {
            runtimes: () => [],
            inspectMaterials: async () => ({}),
            prepare: async () => ({}),
            getEnvironment: async () => ({}),
            releaseEnvironment: async () => ({}),
            discardOutputs: async () => ({}),
            collectOutputsInTurn: async () => ({}),
            executeInTurn: async (input, context, executionSignal) => {
              expect(context.operationId).toBe(outer.operationId)
              const executionInvocationId = input.requestId
              await h.notebook.executeShell(
                {
                  ...scope,
                  workspaceCwd: context.workspaceCwd,
                  provenanceContext: context.provenanceContext,
                  executionInvocationId,
                  command: input.command
                },
                executionSignal
              )
              const run = (
                await h.fixture.notebookRepository.readSessionRuns(scope.projectId, scope.sessionId)
              ).find((item) => item.submissionIdentity === executionInvocationId)!
              await context.recordRun(run.runId)
              const artifact = await context.saveOutput({
                filename: 'result.txt',
                source: { kind: 'localPath', path: 'result.txt' },
                producerRunId: run.runId
              })
              versions.push(artifact.versionId)
              artifactRuns.add(artifact.runId!)
              return { runId: run.runId }
            }
          }
        })
        const provenanceContext =
          outer.provenanceContext as import('./managed-execution-output').ManagedExecutionProvenance
        const turn = Object.freeze({
          ...scope,
          ownerExecutionId: outer.operationId,
          artifactRunId,
          artifactStorageSessionId: scope.sessionId,
          workspaceCwd: outer.workspaceCwd,
          invocationId: 'single-repl-call',
          provenanceContext,
          signal,
          assertActive: () => signal.throwIfAborted()
        })
        await port.call(
          'execute',
          {
            environmentId: 'a'.repeat(64),
            requestId: 'native-request-1',
            command: 'printf one > result.txt'
          },
          turn
        )
        await port.call(
          'execute',
          {
            environmentId: 'a'.repeat(64),
            requestId: 'native-request-2',
            command: 'printf two > result.txt'
          },
          turn
        )
        expect(h.artifactTurns.snapshot(handle).phase).toBe('open')
        return { text: 'Two managed requests completed within the current turn.' }
      })
    )
    expect(await h.owner.wait(scope)).toMatchObject({ status: 'completed' })
    expect(versions).toHaveLength(2)
    expect(new Set(versions).size).toBe(2)
    expect(artifactRuns.size).toBe(1)
    const session = (await h.read(scope))!
    expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(session.artifacts).toHaveLength(2)
    expect(h.kernelExecute).not.toHaveBeenCalled()
  }
)

it('drains queued Session admission during deletion cancellation before any request is saved', async () => {
  const h = await harness()
  const execute = vi.fn(async () => ({ text: 'never' }))
  const admission = h.owner.start(request(execute))
  const cancelled = h.owner.cancelSession(scope)
  await expect(admission).rejects.toThrow('admission is cancelled')
  await cancelled
  expect(execute).not.toHaveBeenCalled()
  expect((await h.read(scope))!.messages).toEqual([])
  await h.owner.start({
    ...request(async () => ({ text: 'allowed after cancellation' })),
    requestId: 'later'
  })
  expect(await h.owner.wait({ ...scope, requestId: 'later' })).toMatchObject({
    status: 'completed'
  })
})

it.skipIf(process.platform === 'win32')(
  'reports environment release as cancelled while retaining real partial Run outputs and retry identity',
  async () => {
    const h = await createSessionOperationTestHarness(cleanups, { canonicalStorageRoot: true })
    const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
    const executable = await realpath(process.execPath)
    const node = {
      kind: 'node' as const,
      executable,
      version: process.versions.node,
      sha256: sha('runtime'),
      platform: process.platform as 'darwin' | 'linux',
      arch: process.arch,
      readOnlyRoots: [dirname(executable)]
    }
    const environments = new ManagedResearchEnvironmentOwner({
      dataRoot: h.fixture.storageRoot,
      socketRoot: await realpath(tmpdir()),
      verifyRuntime: async () => undefined,
      stopExecution: async (identity) => ({
        verified: (await h.notebook.confirmManagedShellCleanup(identity, { retry: true })).reaped
      })
    })
    cleanups.push(() => environments.close())
    const service = new ManagedExecutionService({
      artifacts: h.artifacts,
      notebooks: h.fixture.notebookRepository,
      dataRoot: h.fixture.storageRoot,
      environments,
      operations: h.owner,
      runtime: h.notebook,
      runtimes: {
        discover: async () => ({ runtimes: [{ runtimeId: sha('runtime'), runtime: node }] }),
        resolve: async () => node
      },
      materials: async () => ({
        source: { projectId: scope.projectId, sessionId: 'source', identity: 'fixed-input' },
        versions: [
          {
            versionId: 'input',
            sourceIdentity: 'fixed-input',
            filename: 'input.txt',
            sha256: sha('input'),
            sizeBytes: 5
          }
        ],
        readVersion: async () => Buffer.from('input')
      }),
      resolvePreparedInputs: async () => [],
      createSession: async () => {
        throw new Error('No new Session')
      },
      withWritableSession: async (_scope, operation) => operation()
    })
    const target = { projectId: scope.projectId, sessionId: scope.sessionId }
    const prepared = (await service.prepare({
      ...target,
      requestId: 'prepare-release',
      sourceSessionId: 'source',
      sourceIdentity: 'fixed-input',
      runtimeId: sha('runtime'),
      materials: { files: [{ versionId: 'input', restorePath: 'input.txt' }] }
    })) as { environmentId: string }
    const executeRequest = {
      ...target,
      environmentId: prepared.environmentId,
      requestId: 'release-execution',
      command:
        'printf "partial result" > "$OPEN_SCIENCE_OUTPUT_DIR/partial.txt"; while :; do sleep 1; done',
      timeoutMs: 20000,
      outputs: [
        { filename: 'partial.txt', path: 'partial.txt' },
        { filename: 'unproduced.txt', path: 'unproduced.txt', optional: true }
      ]
    }
    const admitted = await service.execute(executeRequest)
    const partialPath = join(
      getNotebookDataRoot(h.fixture.storageRoot, target.projectId, target.sessionId),
      'managed-execution',
      prepared.environmentId,
      'files/partial.txt'
    )
    let done: Awaited<ReturnType<typeof h.owner.wait>>
    try {
      await vi.waitFor(
        async () => expect(await readFile(partialPath, 'utf8')).toBe('partial result'),
        { timeout: 5000 }
      )
      await expect(
        service.releaseEnvironment({ ...target, environmentId: prepared.environmentId })
      ).resolves.toMatchObject({
        state: 'ready',
        pendingCollection: { collectionId: expect.stringMatching(/^[a-f0-9]{64}$/) }
      })
      done = await h.owner.wait({ ...target, requestId: executeRequest.requestId })
    } finally {
      // Failure cleanup must not manufacture the cancelled state being verified by this test.
      if (!done) await h.owner.cancel({ ...target, requestId: executeRequest.requestId })
    }
    expect(done).toMatchObject({ operationId: admitted.operationId, status: 'cancelled' })
    expect(done!.notebookRunIds).toHaveLength(1)
    const session = (await h.read(target))!
    const output = session.artifacts!.find((artifact) => artifact.name === 'partial.txt')!
    const receipt = session.artifacts!.find((artifact) => artifact.name?.startsWith('execution-'))!
    // The stop collected bytes before the current turn published them. Only exact Version
    // publication (including the receipt) may acknowledge retention and finish requested release.
    await service.reconcilePublishedOutputs(target)
    const released = await environments.get({ ...target, environmentId: prepared.environmentId })
    expect(released.state).toBe('released')
    expect(released.pendingCollection).toBeUndefined()
    expect(await readFile(output.path, 'utf8')).toBe('partial result')
    expect(JSON.parse(await readFile(receipt.path, 'utf8')).result).toMatchObject({
      status: 'cancelled',
      missingOptionalOutputs: ['unproduced.txt']
    })
    const runs = await h.fixture.notebookRepository.readSessionRuns(
      target.projectId,
      target.sessionId
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runId: done!.notebookRunIds[0], status: 'cancelled' })
    expect(session.activeRun).toBeUndefined()
    expect(session.status).toBe('idle')
    expect(session.resumeRecovery).toMatchObject({
      promptMessageId: done!.provenance!.promptMessageId,
      cause: 'cancelled'
    })
    for (const messages of [session.messages, session.conversationGraph!.messages]) {
      expect(
        messages.find(({ id }) => id === done!.provenance!.promptMessageId)?.turnOutcome
      ).toMatchObject({ kind: 'cancelled', recovery: 'resume' })
    }
    expect((await service.execute(executeRequest)).operationId).toBe(admitted.operationId)
    expect(
      await h.fixture.notebookRepository.readSessionRuns(target.projectId, target.sessionId)
    ).toHaveLength(1)
    expect(h.kernelExecute).not.toHaveBeenCalled()
  }
)

it.each(['cancelled', 'failed'] as const)(
  'persists a trusted %s outcome without inventing an owner cancellation or dropping its output',
  async (status) => {
    const h = await harness()
    await h.owner.start({
      ...request(async (context, signal) => {
        expect(signal.aborted).toBe(false)
        await context.saveOutput({
          filename: 'status.txt',
          source: { kind: 'inline', content: status }
        })
        return { text: 'Trusted execution outcome.', status }
      })
    })
    const done = await h.owner.wait(scope)
    expect(done).toMatchObject({ status })
    const session = (await h.read(scope))!
    expect(session.activeRun).toBeUndefined()
    expect(session.artifacts).toHaveLength(1)
    expect(await readFile(session.artifacts![0].path, 'utf8')).toBe(status)
    expect(session.status).toBe(status === 'cancelled' ? 'idle' : 'error')
    for (const messages of [session.messages, session.conversationGraph!.messages]) {
      expect(
        messages.find(({ id }) => id === done!.provenance!.promptMessageId)?.turnOutcome
      ).toMatchObject({ kind: status })
    }
    if (status === 'cancelled') expect(session.resumeRecovery?.cause).toBe('cancelled')
    else expect(session.resumeRecovery).toBeUndefined()
  }
)

it.each(['without-receipt', 'different-prompt', 'different-outcome', 'interrupted'] as const)(
  'does not consume %s recovery when admitting a new managed operation',
  async (condition) => {
    const h = await harness()
    await h.owner.start(
      request(async () => ({
        text: 'Initial operation settled.',
        status: condition === 'without-receipt' ? ('completed' as const) : ('cancelled' as const)
      }))
    )
    const settled = (await h.owner.wait(scope))!
    const promptId = settled.provenance!.promptMessageId
    await h.mutate(scope, (session) => {
      const outcome =
        condition === 'different-outcome'
          ? { kind: 'failed' as const, settledAt: Date.now() }
          : { kind: 'cancelled' as const, settledAt: Date.now(), recovery: 'resume' as const }
      const change = <Message extends (typeof session.messages)[number]>(
        message: Message
      ): Message => (message.id === promptId ? { ...message, turnOutcome: outcome } : message)
      return {
        ...session,
        messages: session.messages.map(change),
        conversationGraph: {
          ...session.conversationGraph!,
          messages: session.conversationGraph!.messages.map(change)
        },
        resumeRecovery: {
          kind: 'resume-required',
          cause: condition === 'interrupted' ? 'connection-lost' : 'cancelled',
          promptMessageId: condition === 'different-prompt' ? 'another-prompt' : promptId
        }
      }
    })
    const before = await h.read(scope)
    const execute = vi.fn(async () => ({ text: 'Must not execute.' }))
    await expect(
      h.owner.start({ ...request(execute), requestId: 'next-operation' })
    ).rejects.toThrow('active or unsettled')
    expect(execute).not.toHaveBeenCalled()
    expect(await h.read(scope)).toEqual(before)
  }
)

it('keeps optional inline publication failure separate from the real operation and finalizes its required Artifact', async () => {
  const h = await harness()
  const saved = h.artifacts.saveVersion.bind(h.artifacts)
  vi.spyOn(h.artifacts, 'saveVersion').mockImplementation(async (...args) => {
    const artifact = await saved(...args)
    if (args[0].filename === 'optional-capture.json')
      throw new Error('response lost after actual auxiliary save')
    return artifact
  })
  let observedIntent: import('./managed-output-publication').ManagedOutputWriteAttempt | undefined
  let auxiliary:
    Awaited<ReturnType<NonNullable<SessionOperationContext['saveAuxiliaryOutput']>>> | undefined
  await h.owner.start(
    request(async (context) => {
      await context.saveOutput({
        filename: 'required.json',
        source: { kind: 'inline', content: '{"result":42}' }
      })
      auxiliary = await context.saveAuxiliaryOutput!({
        filename: 'optional-capture.json',
        source: { kind: 'inline', content: '{"observed":true}' },
        publication: {
          beforeWrite: async (attempt) => {
            observedIntent = attempt
          }
        }
      })
      return {
        text: 'The experiment completed; optional capture publication needs reconciliation.'
      }
    })
  )
  const operation = await h.owner.wait(scope)
  expect(operation).toMatchObject({ status: 'completed' })
  expect(auxiliary).toEqual({ status: 'failed', code: 'artifact-save-failed' })
  expect(observedIntent).toMatchObject({
    request: {
      projectId: scope.projectId,
      appSessionId: scope.sessionId,
      filename: 'optional-capture.json'
    },
    source: {
      kind: 'inline',
      sha256: createHash('sha256').update('{"observed":true}').digest('hex')
    }
  })
  expect(observedIntent!.request).not.toHaveProperty('producerRunId')
  const session = (await h.read(scope))!
  expect(session.artifacts?.map((artifact) => artifact.name)).toEqual(
    expect.arrayContaining(['required.json', 'optional-capture.json'])
  )
  const replayed = await h.artifacts.replayVersion(observedIntent!.request)
  expect(replayed).toMatchObject({ name: 'optional-capture.json', isPublished: true })
  expect(replayed?.producerRunId).toBeUndefined()
})

it.each(['saved', 'response-lost'] as const)(
  'stores actual PNG bytes in SQLite-backed Artifacts with optional result %s and preserves UTF-8 outputs',
  async (result) => {
    const h = await harness()
    const content =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cVZ0AAAAASUVORK5CYII='
    const bytes = Buffer.from(content, 'base64')
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const save = h.artifacts.saveVersion.bind(h.artifacts)
    vi.spyOn(h.artifacts, 'saveVersion').mockImplementation(async (...args) => {
      const artifact = await save(...args)
      if (result === 'response-lost' && args[0].filename === 'observed-frame.png')
        throw new Error('response lost after actual binary save')
      return artifact
    })
    let intent: import('./managed-output-publication').ManagedOutputWriteAttempt | undefined
    await h.owner.start(
      request(async (context) => {
        await context.saveOutput({
          filename: 'normal.txt',
          source: { kind: 'inline', content: '研究 Ω😀\n' }
        })
        const auxiliary = await context.saveAuxiliaryOutput!({
          filename: 'observed-frame.png',
          contentType: 'image/png',
          source: { kind: 'inline', content, encoding: 'base64' },
          publication: {
            beforeWrite: async (attempt) => {
              intent = attempt
              expect(attempt.source).toEqual({
                kind: 'inline',
                sha256: checksum,
                sizeBytes: bytes.byteLength
              })
              expect(attempt.request).not.toHaveProperty('producerRunId')
              expect(attempt.destination.provenanceContext).toMatchObject(context.provenanceContext)
            }
          }
        })
        expect(auxiliary.status).toBe(result === 'saved' ? 'saved' : 'failed')
        if (result === 'response-lost')
          expect(auxiliary).toEqual({ status: 'failed', code: 'artifact-save-failed' })
        return { text: 'Original operation completed independently of optional frame delivery.' }
      })
    )
    expect(await h.owner.wait(scope)).toMatchObject({ status: 'completed', notebookRunIds: [] })
    const replayed = await h.artifacts.replayVersion(intent!.request)
    expect(replayed).toMatchObject({
      name: 'observed-frame.png',
      checksum,
      size: bytes.byteLength,
      isPublished: true
    })
    expect(replayed?.producerRunId).toBeUndefined()
    const version = await h.fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: replayed!.versionId }
    })
    const stored = await readFile(join(h.fixture.storageRoot, version.contentStorageKey))
    expect(stored).toEqual(bytes)
    expect(stored.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(createHash('sha256').update(stored).digest('hex')).toBe(checksum)
    expect(stored.toString('utf8')).not.toBe(content)
    const normal = (await h.read(scope))!.artifacts!.find((item) => item.name === 'normal.txt')!
    const normalVersion = await h.fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: normal.versionId }
    })
    expect(
      await readFile(join(h.fixture.storageRoot, normalVersion.contentStorageKey), 'utf8')
    ).toBe('研究 Ω😀\n')
  }
)

it('drains unawaited auxiliary writes and retains ordinary required-output failure semantics', async () => {
  const h = await harness()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await h.owner.start(
    request(async (context) => {
      void context.saveAuxiliaryOutput!({
        filename: 'optional.json',
        source: { kind: 'inline', content: '{}' },
        publication: {
          beforeWrite: async () => {
            enter()
            await gate
            throw new Error('optional write failed')
          }
        }
      })
      return { text: 'The original operation is complete.' }
    })
  )
  await entered
  expect(await h.owner.get(scope)).toMatchObject({ status: 'running' })
  release()
  expect(await h.owner.wait(scope)).toMatchObject({ status: 'completed' })
  expect(await h.fixture.client.artifactVersion.count()).toBe(0)
  const second = { ...scope, requestId: 'required-failure' }
  await h.owner.start({
    ...request(async (context) => {
      await context
        .saveOutput({
          filename: 'required.json',
          source: { kind: 'inline', content: '{}' },
          publication: {
            beforeWrite: async () => {
              throw new Error('required output failed')
            }
          }
        })
        .catch(() => undefined)
      return { text: 'Catching a required output error cannot suppress the owner failure.' }
    }),
    requestId: second.requestId
  })
  expect(await h.owner.wait(second)).toMatchObject({ status: 'failed' })
})

it('does not let the auxiliary capability import paths or claim Notebook producer authority', async () => {
  const h = await harness()
  await h.owner.start(
    request(async (context) => {
      for (const output of [
        { filename: 'bad.json', source: { kind: 'localPath', path: 'private.json' } },
        {
          filename: 'bad.json',
          source: { kind: 'inline', content: '{}' },
          producerRunId: 'foreign-run'
        },
        { filename: 'bad.json', source: { kind: 'inline', content: '{}' }, failurePolicy: 'ignore' }
      ]) {
        expect(await context.saveAuxiliaryOutput!(output as never)).toEqual({
          status: 'failed',
          code: 'invalid-output'
        })
      }
      return {
        text: 'Invalid auxiliary requests were rejected without acquiring producer authority.'
      }
    })
  )
  expect(await h.owner.wait(scope)).toMatchObject({ status: 'completed' })
  expect(await h.fixture.client.artifactVersion.count()).toBe(0)
})

it.skipIf(process.platform === 'win32')(
  'ordinary Main port preserves a real completed Run when optional publication fails',
  async () => {
    const h = await harness()
    let notebookRunId: string | undefined
    await h.owner.start(
      request(async (outer, signal) => {
        const handle = h.artifactTurns.handleForExecution(outer.operationId)
        const artifactRunId = h.artifactTurns.snapshot(handle).runId
        const port = createManagedExecutionTurnPort({
          dataRoot: h.fixture.storageRoot,
          artifacts: h.artifacts,
          notebooks: h.fixture.notebookRepository,
          trackArtifactWrite: (_sessionId, _owner, write) =>
            h.artifactTurns.trackWrite(handle, write),
          service: {
            runtimes: () => [],
            inspectMaterials: async () => ({}),
            prepare: async () => ({}),
            getEnvironment: async () => ({}),
            releaseEnvironment: async () => ({}),
            discardOutputs: async () => ({}),
            collectOutputsInTurn: async () => ({}),
            executeInTurn: async (_request, context) => {
              await h.notebook.executeShell(
                {
                  ...scope,
                  workspaceCwd: context.workspaceCwd,
                  command: 'printf observed',
                  provenanceContext: context.provenanceContext,
                  executionInvocationId: context.executionInvocationId
                },
                signal
              )
              const run = (
                await h.fixture.notebookRepository.readSessionRuns(scope.projectId, scope.sessionId)
              ).find((run) => run.executionInvocationId === context.executionInvocationId)!
              notebookRunId = run.runId
              await context.recordRun(run.runId)
              await context.saveOutput({
                filename: 'result.json',
                source: { kind: 'inline', content: '{"completed":true}' }
              })
              const auxiliary = await context.saveAuxiliaryOutput!({
                filename: 'capture.png',
                contentType: 'image/png',
                source: { kind: 'inline', content: 'iVBORw0KGgo=', encoding: 'base64' },
                publication: {
                  beforeWrite: async (attempt) => {
                    expect(attempt.request.artifactRunId).toBe(artifactRunId)
                    expect(attempt.source).toEqual({
                      kind: 'inline',
                      sizeBytes: 8,
                      sha256: createHash('sha256')
                        .update(Buffer.from('iVBORw0KGgo=', 'base64'))
                        .digest('hex')
                    })
                    expect(attempt.destination.provenanceContext).toEqual(context.provenanceContext)
                    throw new Error('optional capture unavailable')
                  }
                }
              })
              expect(auxiliary).toEqual({ status: 'failed', code: 'artifact-save-failed' })
              return { status: 'completed', observation: { status: 'pending' } }
            }
          }
        })
        const result = await port.call(
          'execute',
          {
            environmentId: 'a'.repeat(64),
            requestId: 'port-observed',
            command: 'printf observed',
            recordObservation: true
          },
          {
            ...scope,
            ownerExecutionId: outer.operationId,
            artifactRunId,
            artifactStorageSessionId: scope.sessionId,
            workspaceCwd: outer.workspaceCwd,
            invocationId: 'main-port-observation',
            signal,
            provenanceContext:
              outer.provenanceContext as import('./managed-execution-output').ManagedExecutionProvenance,
            assertActive: () => signal.throwIfAborted()
          }
        )
        expect(result).toEqual({ status: 'completed', observation: { status: 'pending' } })
        return { text: 'Run completed; the optional recording remains pending.' }
      })
    )
    expect(await h.owner.wait(scope)).toMatchObject({ status: 'completed' })
    const runs = await h.fixture.notebookRepository.readSessionRuns(
      scope.projectId,
      scope.sessionId
    )
    expect(runs.find((run) => run.runId === notebookRunId)).toMatchObject({
      status: 'completed',
      text: { stdout: 'observed' }
    })
    expect((await h.read(scope))?.artifacts?.map((artifact) => artifact.name)).toContain(
      'result.json'
    )
  }
)

const { configureTestElectronHost } = await import('../../../test/runtime-host')
await configureTestElectronHost(await import('electron'))
